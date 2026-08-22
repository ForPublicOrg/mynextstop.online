/**
 * exporter.js
 *
 * Turns a timeline into a downloadable video file, entirely in the browser.
 *
 * Two paths:
 *  1. WebCodecs `VideoEncoder` + mp4-muxer. Frame accurate, renders as fast as the
 *     machine allows, produces an H.264 MP4 that Instagram, TikTok and Shorts accept.
 *     Tiles are loaded a window ahead of the encoder for speed, with a per frame
 *     residency gate under that for correctness.
 *  2. `MediaRecorder` over `canvas.captureStream()`. Real time replay, produces WebM.
 *     Used only when WebCodecs H.264 is unavailable (Firefox today, older Safari).
 *
 * Canvas 2D only, no OffscreenCanvas, no WebGL, no build step.
 */

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.min.mjs';
import { renderFrame, planTiles, FPS } from './scene.js';
// Namespace import on purpose: the per-frame tile query is optional, and a named
// import of an export the scene does not have would fail the whole module at
// link time. Read through the namespace it is simply undefined, and the frame
// gate turns itself off.
import * as scene from './scene.js';

/** Codec strings tried in order: High, Main, Baseline, all at level 4.0. */
const MP4_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

/** Target bitrate for 9:16 and 16:9 exports, in bits per second. */
const BITRATE_WIDE = 12000000;

/** Target bitrate for square exports, in bits per second. */
const BITRATE_SQUARE = 10000000;

/** Target bitrate for the MediaRecorder fallback, in bits per second. */
const BITRATE_WEBM = 8000000;

/**
 * Ceiling on the encoded file. The muxer assembles the MP4 in memory, and
 * holds every sample a second time to write the index first, so a ninety
 * second reel at full rate would pin several hundred megabytes on a phone.
 * Map animation compresses easily: a lower rate on a long reel costs nothing
 * anyone can see.
 */
const MAX_FILE_BYTES = 90 * 1024 * 1024;

/** Floor for the rate the cap can push an export down to. */
const BITRATE_FLOOR = 4000000;

/** Encode queue depth we allow before waiting for the encoder to drain. */
const QUEUE_LIMIT = 6;

/** A keyframe every this many frames (2 seconds at 30 fps). */
const KEYFRAME_INTERVAL = 60;

/** Hand control back to the event loop every this many frames. */
const YIELD_EVERY = 8;

/** Safety poll while waiting on the encoder 'dequeue' event, in milliseconds. */
const DEQUEUE_POLL_MS = 30;

/** Probe size used by detectExportSupport when no timeline is available yet. */
const PROBE_WIDTH = 1080;
const PROBE_HEIGHT = 1920;

/** Grace period after the last frame so the capture pipeline sees it, in milliseconds. */
const RECORDER_TAIL_MS = 140;

/** Chunk interval handed to MediaRecorder.start, in milliseconds. */
const RECORDER_TIMESLICE_MS = 500;

/**
 * Coarse timer that keeps the WebM recording moving when requestAnimationFrame
 * is throttled or suspended, in milliseconds.
 */
const RECORDER_WATCHDOG_MS = 250;

/**
 * Frames covered by one tile prefetch window.
 *
 * The whole plan for a long trip is thousands of tiles, far more than the cache
 * can hold at once. We load it a window at a time instead, five seconds of
 * video per window, so the tiles a frame needs are resident when it renders and
 * the ones it is finished with can be let go.
 */
const FRAMES_PER_WINDOW = 150;

/**
 * Ceiling on how long one frame may wait for its own tiles, in milliseconds.
 *
 * The gate exists so a frame is never drawn on tiles that are not there, but it
 * must not be able to stall a whole export either. A wait that runs out draws
 * the frame with whatever arrived and lets the parent tile fallback cover the
 * rest, which is what the old behaviour did for every frame.
 */
const GATE_WAIT_MS = 8000;

/**
 * Frames a gated wait keeps its tiles pinned for once the wait is over.
 *
 * One frame would be enough, since the render follows the wait immediately. Two
 * keeps the pins through the next frame's own gate, so a run of gated frames
 * over the same tiles does not release and re-pin on every one of them.
 */
const GATE_HOLD_FRAMES = 2;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the standard abort rejection value.
 * @returns {Error} a DOMException named 'AbortError' where available.
 */
function createAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('The export was cancelled.', 'AbortError');
  }
  const err = new Error('The export was cancelled.');
  err.name = 'AbortError';
  return err;
}

/**
 * Throw if the caller already cancelled.
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

/**
 * True when the value looks like an abort rejection.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError';
}

/** @type {MessagePort|null} Port that hands control back to the event loop. */
let yieldPort = null;

/** @type {Array<() => void>} Waiters for the yield port, oldest first. */
const yieldQueue = [];

/**
 * Lazily build the yield channel.
 * @returns {MessagePort|null} the sending port, or null when unavailable
 */
function ensureYieldPort() {
  if (yieldPort || typeof MessageChannel !== 'function') return yieldPort;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const waiter = yieldQueue.shift();
    if (waiter) waiter();
  };
  yieldPort = channel.port2;
  return yieldPort;
}

/**
 * Yield one macrotask so the progress UI can paint and cancel clicks land.
 *
 * A message channel rather than a timer on purpose: browsers clamp setTimeout
 * to one second in a hidden tab, and to roughly one tick a minute once the tab
 * has been hidden a while, which would stall an export the moment the user
 * switched tabs. Channel messages are not throttled that way.
 *
 * @returns {Promise<void>}
 */
function nextTick() {
  const port = ensureYieldPort();
  if (!port) return new Promise((resolve) => setTimeout(resolve));
  return new Promise((resolve) => {
    yieldQueue.push(resolve);
    port.postMessage(0);
  });
}

/**
 * Call a progress callback without letting a UI bug break the export.
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [onProgress]
 * @param {'tiles'|'encode'} stage
 * @param {number} done
 * @param {number} total
 */
function report(onProgress, stage, done, total) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ stage, done, total });
  } catch (err) {
    // A throwing progress handler must never take the export down.
  }
}

/**
 * Announce a stage that has no meaningful count of its own.
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [onProgress]
 * @param {'finish'} stage
 */
function reportStage(onProgress, stage) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ stage });
  } catch (err) {
    // Same as above.
  }
}

/**
 * Normalise a value to a finite positive integer.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the pixel dimensions off a timeline, with validation.
 * @param {any} timeline
 * @returns {{ width: number, height: number, duration: number }}
 */
function readTimeline(timeline) {
  if (!timeline || !timeline.dims) {
    throw new Error('bad-timeline');
  }
  const width = toPositiveInt(timeline.dims.w, 0);
  const height = toPositiveInt(timeline.dims.h, 0);
  if (!width || !height) throw new Error('bad-timeline');
  const raw = Number(timeline.duration);
  const duration = Number.isFinite(raw) && raw > 0 ? raw : 1 / FPS;
  return { width, height, duration };
}

/**
 * Number of frames we will encode for a timeline.
 * @param {number} duration seconds
 * @returns {number} at least 1
 */
function frameCount(duration) {
  return Math.max(1, Math.ceil(duration * FPS));
}

/**
 * Give a 2D context a `roundRect` method when the browser lacks one.
 * Instance scoped on purpose: nothing global is patched.
 * @param {CanvasRenderingContext2D} ctx
 * @returns {CanvasRenderingContext2D} the same context
 */
function ensureRoundRect(ctx) {
  if (typeof (/** @type {any} */ (ctx).roundRect) === 'function') return ctx;
  /** @type {any} */ (ctx).roundRect = function roundRectFallback(x, y, w, h, radii) {
    let left = x;
    let top = y;
    let width = w;
    let height = h;
    if (width < 0) {
      left += width;
      width = -width;
    }
    if (height < 0) {
      top += height;
      height = -height;
    }
    const list = Array.isArray(radii) ? radii : [radii];
    const raw = [
      Number(list[0]) || 0,
      Number(list.length > 1 ? list[1] : list[0]) || 0,
      Number(list.length > 2 ? list[2] : list[0]) || 0,
      Number(list.length > 3 ? list[3] : list.length > 1 ? list[1] : list[0]) || 0,
    ];
    const cap = Math.min(width, height) / 2;
    const [tl, tr, br, bl] = raw.map((r) => Math.max(0, Math.min(Math.abs(r), cap)));
    this.moveTo(left + tl, top);
    this.lineTo(left + width - tr, top);
    this.arcTo(left + width, top, left + width, top + tr, tr);
    this.lineTo(left + width, top + height - br);
    this.arcTo(left + width, top + height, left + width - br, top + height, br);
    this.lineTo(left + bl, top + height);
    this.arcTo(left, top + height, left, top + height - bl, bl);
    this.lineTo(left, top + tl);
    this.arcTo(left, top, left + tl, top, tl);
    this.closePath();
  };
  return ctx;
}

/**
 * Create the offscreen-in-spirit render target. A plain detached canvas, 2D only.
 * @param {number} width
 * @param {number} height
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
function createRenderTarget(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // alpha false keeps the encoder on an opaque surface. The renderer fills the
  // background as its first operation, so nothing relies on transparency.
  const ctx = /** @type {CanvasRenderingContext2D|null} */ (
    canvas.getContext('2d', { alpha: false })
  );
  if (!ctx) throw new Error('canvas-unavailable');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ensureRoundRect(ctx);
  return { canvas, ctx };
}

/**
 * Draw one frame at time t with an identity transform.
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} timeline
 * @param {number} t seconds
 * @param {any} tiles
 */
function paint(ctx, timeline, t, tiles) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderFrame(ctx, timeline, t, tiles);
}

/* ------------------------------------------------------------------ */
/* capability detection                                                */
/* ------------------------------------------------------------------ */

/**
 * Bitrate for a given output size and length: the shape's full rate, held
 * down on a long reel so the file stays under MAX_FILE_BYTES.
 * @param {number} width
 * @param {number} height
 * @param {number} [duration] seconds, omitted when probing support
 * @returns {number} bits per second
 */
function bitrateFor(width, height, duration) {
  const base = width === height ? BITRATE_SQUARE : BITRATE_WIDE;
  if (!(duration > 0)) return base;
  return Math.max(BITRATE_FLOOR, Math.min(base, Math.floor((MAX_FILE_BYTES * 8) / duration)));
}

/**
 * Candidate H.264 encoder configs, best quality profile first.
 * @param {number} width
 * @param {number} height
 * @param {number} [duration] seconds
 * @returns {Array<Object>} VideoEncoderConfig candidates
 */
function buildEncoderConfigs(width, height, duration) {
  return MP4_CODECS.map((codec) => ({
    codec,
    width,
    height,
    bitrate: bitrateFor(width, height, duration),
    framerate: FPS,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  }));
}

/**
 * Ask the browser which of our H.264 configs it can actually encode.
 * @param {number} width
 * @param {number} height
 * @param {number} [duration] seconds
 * @returns {Promise<Object|null>} the first supported config, or null
 */
async function pickEncoderConfig(width, height, duration) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  if (typeof VideoEncoder.isConfigSupported !== 'function') return null;
  const candidates = buildEncoderConfigs(width, height, duration);
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const result = await VideoEncoder.isConfigSupported(candidates[i]);
      if (result && result.supported) {
        // Prefer the config the browser normalised for us when it hands one back.
        return result.config || candidates[i];
      }
    } catch (err) {
      // Unsupported codec strings can reject outright. Try the next one.
    }
  }
  return null;
}

/**
 * Pick a WebM mime type MediaRecorder will accept.
 * @returns {string|null}
 */
function pickWebmMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const options = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder.isTypeSupported !== 'function') return 'video/webm';
  for (let i = 0; i < options.length; i += 1) {
    if (MediaRecorder.isTypeSupported(options[i])) return options[i];
  }
  return null;
}

/**
 * True when a canvas can be turned into a MediaStream and recorded.
 * @returns {boolean}
 */
function canRecordWebm() {
  if (typeof document === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return pickWebmMime() !== null;
}

/**
 * Report which export formats this browser can produce.
 * Safe to call at any time, does not allocate an encoder.
 *
 * @returns {Promise<{ mp4: boolean, webm: boolean }>}
 */
export async function detectExportSupport() {
  let mp4 = false;
  try {
    mp4 = (await pickEncoderConfig(PROBE_WIDTH, PROBE_HEIGHT)) !== null;
  } catch (err) {
    mp4 = false;
  }
  let webm = false;
  try {
    webm = canRecordWebm();
  } catch (err) {
    webm = false;
  }
  return { mp4, webm };
}

/* ------------------------------------------------------------------ */
/* tile prefetch                                                       */
/* ------------------------------------------------------------------ */

/**
 * Ask the scene for every tile the timeline will touch.
 * A planning failure is survivable: the renderer still requests tiles lazily.
 *
 * @param {any} timeline
 * @returns {Array<{z: number, x: number, y: number, firstFrame?: number}>}
 */
function planFor(timeline) {
  try {
    return planTiles(timeline) || [];
  } catch (err) {
    return [];
  }
}

/**
 * Split a plan into windows of FRAMES_PER_WINDOW frames each.
 * Entries without a usable `firstFrame` land in the first window, which
 * degrades gracefully to loading everything up front.
 *
 * @param {Array<{z: number, x: number, y: number, firstFrame?: number}>} list
 * @returns {Array<Array<{z: number, x: number, y: number}>>}
 */
function windowPlan(list) {
  /** @type {Array<Array<any>>} */
  const windows = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item) continue;
    const first = Number(item.firstFrame);
    const index = Number.isFinite(first) && first > 0 ? Math.floor(first / FRAMES_PER_WINDOW) : 0;
    while (windows.length <= index) windows.push([]);
    windows[index].push(item);
  }
  return windows;
}

/**
 * Load the plan a window at a time, keeping only the windows in play pinned.
 *
 * Tile failures are never fatal: the renderer simply shows the theme background
 * where a tile is missing, so we count them and carry on. Progress is reported
 * as tiles settled across every window against the whole plan, so the bar means
 * the same thing it always did even though loading now interleaves with
 * encoding.
 *
 * @param {Object} args
 * @param {any} args.tiles TileCache instance, may be null
 * @param {Array<Array<any>>} args.windows
 * @param {number} args.total plan length
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {{ ensure: (k: number) => Promise<void>, warm: (k: number) => void,
 *   release: (k: number) => void, releaseAll: () => void, failed: () => number }}
 */
function createTileWindows({ tiles, windows, total, onProgress, signal }) {
  const usable = Boolean(tiles) && typeof tiles.prefetch === 'function';
  const canRelease = usable && typeof tiles.releasePins === 'function';
  /** @type {Map<number, Promise<void>>} */
  const runs = new Map();
  /** @type {Map<number, number>} */
  const settled = new Map();
  /** @type {Set<number>} */
  const held = new Set();
  let failedTiles = 0;

  const publish = () => {
    let done = 0;
    settled.forEach((count) => {
      done += count;
    });
    report(onProgress, 'tiles', Math.min(done, total), total);
  };

  const start = (k) => {
    if (k < 0 || k >= windows.length) return Promise.resolve();
    const running = runs.get(k);
    if (running) return running;

    const list = windows[k];
    if (!usable || !list || !list.length) {
      const empty = Promise.resolve();
      runs.set(k, empty);
      return empty;
    }

    held.add(k);
    const run = tiles
      .prefetch(list, {
        concurrency: 10,
        signal,
        pin: true,
        onProgress: (done) => {
          settled.set(k, done);
          publish();
        },
      })
      .then(
        (result) => {
          settled.set(k, list.length);
          if (result && Number.isFinite(result.failed)) failedTiles += Math.max(0, result.failed);
          publish();
        },
        (err) => {
          // Aborts surface through the signal check the caller runs next, and a
          // window that could not load at all is just missing tiles.
          settled.set(k, list.length);
          if (!isAbortError(err)) failedTiles += list.length;
          publish();
        }
      );
    runs.set(k, run);
    return run;
  };

  return {
    ensure: (k) => start(k),
    warm: (k) => {
      start(k);
    },
    release: (k) => {
      if (!canRelease || !held.has(k)) return;
      held.delete(k);
      try {
        tiles.releasePins(windows[k]);
      } catch (err) {
        // Releasing a pin can never be worth failing an export over.
      }
    },
    releaseAll: () => {
      if (!canRelease) {
        held.clear();
        return;
      }
      const keys = Array.from(held);
      held.clear();
      for (let i = 0; i < keys.length; i += 1) {
        try {
          tiles.releasePins(windows[keys[i]]);
        } catch (err) {
          // Same as above.
        }
      }
    },
    failed: () => failedTiles,
  };
}

/**
 * Resolve when the work settles or when the deadline passes, whichever is first.
 *
 * A missed deadline is not an error: the caller draws with whatever arrived. A
 * cancellation is still an error, because the encode loop has to unwind.
 *
 * @param {Promise<any>} work
 * @param {number} ms
 * @returns {Promise<void>}
 */
function withDeadline(work, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const failed = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    timer = setTimeout(done, ms);
    Promise.resolve(work).then(done, (err) => {
      if (isAbortError(err)) failed(err);
      else done();
    });
  });
}

/**
 * Frame accurate residency gate.
 *
 * The windowed prefetch is the lookahead: it loads five seconds of plan ahead of
 * the encoder and is what keeps the export fast. This is the backstop under it.
 * Before a frame is drawn we ask the scene which tiles that exact frame needs
 * and check them against the cache. All resident, which is the overwhelmingly
 * common case, and the answer is synchronous with nothing awaited and nothing
 * allocated beyond the query itself. Anything absent, because the window pinned
 * more than the cache could hold and the overflow was evicted before its frames
 * encoded, is loaded before the frame is drawn rather than after.
 *
 * Every part of this degrades to the previous behaviour: a scene without
 * `tilesForFrame`, a cache without `missing`, a query that throws, or a wait
 * that runs out all simply leave the frame to draw as it would have.
 *
 * @param {Object} args
 * @param {any} args.timeline
 * @param {any} args.tiles TileCache instance, may be null
 * @param {AbortSignal} [args.signal]
 * @returns {{ ensure: (frame: number) => Promise<void>|null, releaseAll: () => void }}
 */
function createFrameGate({ timeline, tiles, signal }) {
  const query = typeof scene.tilesForFrame === 'function' ? scene.tilesForFrame : null;
  const usable =
    Boolean(query) &&
    Boolean(tiles) &&
    typeof tiles.missing === 'function' &&
    typeof tiles.prefetch === 'function';

  /** @type {Array<{ frame: number, list: Array<any> }>} */
  const holds = [];

  const release = (list) => {
    if (!tiles || typeof tiles.releasePins !== 'function') return;
    try {
      tiles.releasePins(list);
    } catch (err) {
      // Releasing a pin can never be worth failing an export over.
    }
  };

  const expire = (frame) => {
    while (holds.length && holds[0].frame <= frame - GATE_HOLD_FRAMES) {
      release(/** @type {any} */ (holds.shift()).list);
    }
  };

  return {
    ensure: (frame) => {
      if (!usable) return null;

      let list;
      try {
        list = /** @type {any} */ (query)(timeline, frame);
      } catch (err) {
        return null;
      }
      if (!Array.isArray(list) || !list.length) return null;

      let absent;
      try {
        absent = tiles.missing(list);
      } catch (err) {
        return null;
      }
      if (!absent || !absent.length) return null;

      expire(frame);

      let wait;
      try {
        // The whole frame is pinned, not only the absent part: loads settling
        // during the wait run the LRU, which could otherwise evict the tiles
        // this frame already had while it stood here waiting for the rest.
        wait = tiles.prefetch(list, { concurrency: 10, signal, pin: true });
      } catch (err) {
        return null;
      }
      holds.push({ frame, list });
      return withDeadline(wait, GATE_WAIT_MS);
    },
    releaseAll: () => {
      while (holds.length) release(/** @type {any} */ (holds.shift()).list);
    },
  };
}

/* ------------------------------------------------------------------ */
/* MP4 path, WebCodecs plus mp4-muxer                                  */
/* ------------------------------------------------------------------ */

/**
 * Wait until the encoder drains below the queue limit, or the caller cancels.
 * Resolves on the 'dequeue' event where supported, and polls otherwise so we
 * never deadlock on a browser that ships VideoEncoder without the event.
 *
 * @param {VideoEncoder} encoder
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function waitForDequeue(encoder, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (typeof encoder.removeEventListener === 'function') {
        encoder.removeEventListener('dequeue', onDequeue);
      }
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    function onDequeue() {
      settle(resolve, undefined);
    }
    function onAbort() {
      settle(reject, createAbortError());
    }

    if (signal && signal.aborted) {
      settle(reject, createAbortError());
      return;
    }
    if (typeof encoder.addEventListener === 'function') {
      encoder.addEventListener('dequeue', onDequeue);
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort);
    }
    timer = setTimeout(onDequeue, DEQUEUE_POLL_MS);
  });
}

/**
 * Render and encode every frame into an MP4 blob.
 *
 * @param {Object} args
 * @param {any} args.timeline
 * @param {any} args.tiles
 * @param {HTMLCanvasElement} args.canvas
 * @param {CanvasRenderingContext2D} args.ctx
 * @param {Object} args.config a supported VideoEncoderConfig
 * @param {number} args.width
 * @param {number} args.height
 * @param {number} args.duration seconds
 * @param {any} args.tileWindows windowed tile loader from createTileWindows
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ blob: Blob, mimeType: string, ext: 'mp4', seconds: number }>}
 */
async function encodeMp4({
  timeline,
  tiles,
  canvas,
  ctx,
  config,
  width,
  height,
  duration,
  tileWindows,
  onProgress,
  signal,
}) {
  const total = frameCount(duration);
  const frameDuration = Math.round(1000000 / FPS);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  });

  /** @type {Error|null} */
  let failure = null;
  /** @type {VideoEncoder|null} */
  let encoder = null;

  const frameGate = createFrameGate({ timeline, tiles, signal });

  const recordFailure = (err) => {
    if (failure) return;
    failure = err instanceof Error ? err : new Error(String((err && err.message) || err));
  };

  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (err) {
          recordFailure(err);
        }
      },
      error: (err) => recordFailure(err),
    });
    encoder.configure(config);

    report(onProgress, 'encode', 0, total);

    for (let frame = 0; frame < total; frame += 1) {
      throwIfAborted(signal);
      if (failure) throw failure;

      if (frame % FRAMES_PER_WINDOW === 0) {
        const windowIndex = frame / FRAMES_PER_WINDOW;
        // The tiles this window needs have to be resident before we render it.
        await tileWindows.ensure(windowIndex);
        throwIfAborted(signal);
        if (failure) throw failure;
        // Load the next window while this one encodes, and let go of the one
        // whose frames are already behind us.
        tileWindows.warm(windowIndex + 1);
        tileWindows.release(windowIndex - 2);
      }

      while (encoder.encodeQueueSize > QUEUE_LIMIT) {
        await waitForDequeue(encoder, signal);
        throwIfAborted(signal);
        if (failure) throw failure;
      }

      // Last thing before the draw, so nothing else can await in between and let
      // the LRU take a tile back out from under this frame.
      const resident = frameGate.ensure(frame);
      if (resident) {
        await resident;
        throwIfAborted(signal);
        if (failure) throw failure;
      }

      paint(ctx, timeline, frame / FPS, tiles);

      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round((frame * 1000000) / FPS),
        duration: frameDuration,
      });
      try {
        encoder.encode(videoFrame, { keyFrame: frame % KEYFRAME_INTERVAL === 0 });
      } finally {
        videoFrame.close();
      }

      // The last frame is only submitted here, not encoded, so the bar stops
      // one short: the 'finish' stage below covers the flush.
      report(onProgress, 'encode', Math.min(frame + 1, total - 1), total);

      if ((frame + 1) % YIELD_EVERY === 0) {
        await nextTick();
      }
    }

    throwIfAborted(signal);
    if (failure) throw failure;

    reportStage(onProgress, 'finish');

    await encoder.flush();
    if (failure) throw failure;
    throwIfAborted(signal);

    muxer.finalize();

    const buffer = muxer.target.buffer;
    if (!buffer) throw new Error('muxer-empty');

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      ext: 'mp4',
      seconds: total / FPS,
    };
  } finally {
    frameGate.releaseAll();
    tileWindows.releaseAll();
    if (encoder && encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch (err) {
        // Closing an encoder that already errored can throw. Nothing to do.
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* WebM fallback, MediaRecorder over captureStream                     */
/* ------------------------------------------------------------------ */

/**
 * Record the timeline in real time into a WebM blob.
 * This is playback rather than frame stepping, so time comes from the clock.
 *
 * Two things keep a background tab honest. The recording clock stops while the
 * page is hidden, and the recorder pauses with it, so the file can never fill
 * up with a frozen frame or run longer than the timeline. And a coarse interval
 * runs alongside requestAnimationFrame, so a throttled or suspended frame
 * callback cannot starve the render or leave the promise hanging forever.
 *
 * Tiles are loaded a window ahead of the clock, the same windows the MP4 path
 * uses, so a long trip is never asked to pin its whole plan at once: past the
 * pin ceiling the cache would quietly let the later tiles go before the first
 * frame was even drawn. Real time cannot stop to wait, so a window that is
 * late simply draws from parent tiles, which is what it always did.
 *
 * @param {Object} args
 * @param {any} args.timeline
 * @param {any} args.tiles
 * @param {HTMLCanvasElement} args.canvas
 * @param {CanvasRenderingContext2D} args.ctx
 * @param {number} args.duration seconds
 * @param {any} args.tileWindows windowed tile loader from createTileWindows
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ blob: Blob, mimeType: string, ext: 'webm', seconds: number }>}
 */
function recordWebm({ timeline, tiles, canvas, ctx, duration, tileWindows, onProgress, signal }) {
  const mimeType = pickWebmMime();
  if (!mimeType || typeof canvas.captureStream !== 'function') {
    return Promise.reject(new Error('export-unsupported'));
  }

  const total = frameCount(duration);
  const containerType = mimeType.split(';')[0];
  const doc = typeof document !== 'undefined' ? document : null;

  return new Promise((resolve, reject) => {
    /** @type {Blob[]} */
    const chunks = [];
    let settled = false;
    let stopping = false;
    let rafId = 0;
    let watchdog = 0;
    let tailTimer = 0;
    let startedAt = 0;
    let stoppedAt = 0;
    let pausedFor = 0;
    let hiddenAt = 0;
    let lastPaintAt = 0;
    let windowIndex = 0;

    /** @type {MediaStream} */
    let stream;
    /** @type {MediaRecorder} */
    let recorder;

    const isHidden = () => Boolean(doc && doc.hidden);

    const stopTracks = () => {
      if (!stream) return;
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (err) {
          // Already ended.
        }
      });
    };

    const stopRaf = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const cleanup = () => {
      stopRaf();
      if (watchdog) clearInterval(watchdog);
      watchdog = 0;
      if (tailTimer) clearTimeout(tailTimer);
      tailTimer = 0;
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibility);
      }
      stopTracks();
    };

    const releaseRecorder = () => {
      if (!recorder) return;
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch (stopErr) {
          // Nothing further to do, we are already rejecting.
        }
      }
      cleanup();
      releaseRecorder();
      reject(err);
    };

    function onAbort() {
      fail(createAbortError());
    }

    // Declared before use by the listeners above; defined once the recorder runs.
    let onVisibility = () => {};

    try {
      if (signal && signal.aborted) throw createAbortError();

      stream = canvas.captureStream(FPS);
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: Math.min(BITRATE_WEBM, bitrateFor(canvas.width, canvas.height, duration)),
      });

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        fail(/** @type {any} */ (event).error || new Error('recorder-failed'));
      };
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseRecorder();
        if (!chunks.length) {
          reject(new Error('recorder-empty'));
          return;
        }
        // What the file actually holds: wall clock minus the time the recorder
        // spent paused behind a hidden tab.
        const recorded = stoppedAt > startedAt ? (stoppedAt - startedAt - pausedFor) / 1000 : duration;
        resolve({
          blob: new Blob(chunks, { type: containerType }),
          mimeType: containerType,
          ext: 'webm',
          seconds: Math.max(1 / FPS, recorded),
        });
      };

      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort);
      }

      const finish = () => {
        if (settled || stopping) return;
        stopping = true;
        stopRaf();
        reportStage(onProgress, 'finish');
        tailTimer = setTimeout(() => {
          tailTimer = 0;
          if (settled) return;
          if (!recorder || recorder.state === 'inactive') return;
          stoppedAt = performance.now();
          try {
            recorder.stop();
          } catch (err) {
            fail(err instanceof Error ? err : new Error('recorder-failed'));
          }
        }, RECORDER_TAIL_MS);
      };

      /**
       * Paint the frame the clock is currently on and stop when time is up.
       * @param {number} now performance.now style timestamp
       */
      const step = (now) => {
        if (settled || stopping) return;
        const elapsed = Math.max(0, now - startedAt - pausedFor) / 1000;
        const t = Math.min(elapsed, duration);
        // Keep one window of tiles loading ahead of the clock and let go of
        // the ones the clock has left behind.
        const atWindow = Math.floor(Math.floor(t * FPS) / FRAMES_PER_WINDOW);
        if (tileWindows && atWindow !== windowIndex) {
          windowIndex = atWindow;
          tileWindows.warm(atWindow);
          tileWindows.warm(atWindow + 1);
          tileWindows.release(atWindow - 2);
        }
        try {
          paint(ctx, timeline, t, tiles);
        } catch (err) {
          fail(err instanceof Error ? err : new Error('render-failed'));
          return;
        }
        lastPaintAt = now;
        const done = Math.min(total, Math.max(0, Math.round(t * FPS)));
        report(onProgress, 'encode', done, total);
        if (elapsed >= duration) finish();
      };

      const tick = (now) => {
        rafId = 0;
        if (settled || stopping || isHidden()) return;
        step(now);
        if (settled || stopping || rafId) return;
        rafId = requestAnimationFrame(tick);
      };

      const restartRaf = () => {
        stopRaf();
        if (settled || stopping) return;
        rafId = requestAnimationFrame(tick);
      };

      onVisibility = () => {
        if (settled) return;
        if (isHidden()) {
          // Freeze both the recording and the clock, so the two stay in step.
          if (stopping || hiddenAt) return;
          hiddenAt = performance.now();
          stopRaf();
          if (recorder.state === 'recording' && typeof recorder.pause === 'function') {
            try {
              recorder.pause();
            } catch (err) {
              // A recorder that will not pause still has the clock held for it.
            }
          }
          return;
        }
        if (!hiddenAt) return;
        const now = performance.now();
        pausedFor += now - hiddenAt;
        hiddenAt = 0;
        if (recorder.state === 'paused' && typeof recorder.resume === 'function') {
          try {
            recorder.resume();
          } catch (err) {
            // Same as above.
          }
        }
        lastPaintAt = now;
        restartRaf();
      };

      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibility);
      }

      // Seed the stream with the first frame before the recorder starts, so the
      // very beginning of the clip is never blank.
      paint(ctx, timeline, 0, tiles);
      report(onProgress, 'encode', 0, total);

      recorder.start(RECORDER_TIMESLICE_MS);
      startedAt = performance.now();
      lastPaintAt = startedAt;

      // The watchdog is the floor under a throttled or suspended frame callback:
      // it advances the render itself and can end the recording on its own.
      watchdog = setInterval(() => {
        if (settled || stopping || isHidden()) return;
        const now = performance.now();
        if (now - lastPaintAt < RECORDER_WATCHDOG_MS) return;
        step(now);
        if (!settled && !stopping) restartRaf();
      }, RECORDER_WATCHDOG_MS);

      if (isHidden()) onVisibility();
      rafId = requestAnimationFrame(tick);
    } catch (err) {
      fail(err instanceof Error || isAbortError(err) ? err : new Error('export-unsupported'));
    }
  });
}

/* ------------------------------------------------------------------ */
/* public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Render a timeline to a video file.
 *
 * Stages, reported through `onProgress`:
 *  - `tiles`: warming the map tile cache so frames do not render half empty. On
 *    the MP4 path this loads a window of the plan at a time, so it interleaves
 *    with `encode` rather than finishing first. `done` and `total` still count
 *    the whole plan.
 *  - `encode`: rendering and encoding frames.
 *  - `finish`: the last frame is in, the file is being written. No counts.
 *
 * Prefers H.264 MP4 via WebCodecs. Falls back to a real time WebM recording when
 * the browser cannot encode H.264, in which case the result has `ext: 'webm'`.
 *
 * Tile failures are non fatal and surface as `failedTiles`.
 *
 * @param {Object} args
 * @param {any} args.timeline built by `buildTimeline` in scene.js
 * @param {any} args.tiles a TileCache for the timeline theme
 * @param {(info: {stage: 'tiles'|'encode'|'finish', done?: number, total?: number}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal] cancels at any point
 * @returns {Promise<{ blob: Blob, mimeType: string, ext: 'mp4'|'webm', width: number,
 *   height: number, seconds: number, failedTiles: number }>}
 * @throws {DOMException} named 'AbortError' when cancelled
 */
export async function exportVideo({ timeline, tiles, onProgress, signal } = {}) {
  const { width, height, duration } = readTimeline(timeline);
  throwIfAborted(signal);

  const plan = planFor(timeline);
  const config = await pickEncoderConfig(width, height, duration);
  throwIfAborted(signal);

  const { canvas, ctx } = createRenderTarget(width, height);

  let result;
  let failedTiles = 0;

  const tileWindows = createTileWindows({
    tiles,
    windows: windowPlan(plan),
    total: plan.length,
    onProgress,
    signal,
  });

  if (config) {
    report(onProgress, 'tiles', 0, plan.length);
    try {
      result = await encodeMp4({
        timeline,
        tiles,
        canvas,
        ctx,
        config,
        width,
        height,
        duration,
        tileWindows,
        onProgress,
        signal,
      });
    } finally {
      tileWindows.releaseAll();
    }
    failedTiles = tileWindows.failed();
  } else {
    if (!canRecordWebm()) throw new Error('export-unsupported');
    report(onProgress, 'tiles', 0, plan.length);
    try {
      // Real time playback cannot stop to load, so the opening is made ready
      // before the clock starts and the rest follows it a window ahead.
      await tileWindows.ensure(0);
      throwIfAborted(signal);
      tileWindows.warm(1);
      result = await recordWebm({
        timeline,
        tiles,
        canvas,
        ctx,
        duration,
        tileWindows,
        onProgress,
        signal,
      });
    } finally {
      tileWindows.releaseAll();
    }
    failedTiles = tileWindows.failed();
  }

  return {
    blob: result.blob,
    mimeType: result.mimeType,
    ext: result.ext,
    width,
    height,
    seconds: result.seconds,
    failedTiles,
  };
}
