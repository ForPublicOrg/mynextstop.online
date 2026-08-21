/**
 * tiles.js
 * A small raster tile cache built on plain HTMLImageElement loads.
 *
 * Images are requested with crossOrigin 'anonymous' so the canvas they land on
 * stays untainted and can be exported. The cache keeps the most recently used
 * 700 loaded tiles.
 *
 * A tile that fails is never written off for good: it gets up to three
 * attempts, each on the next subdomain and spaced by a short cooldown, and even
 * a tile that used up all three is tried again once the longer cooldown for
 * exhausted tiles passes. A frame never stalls on any of this, a missing tile
 * simply shows the theme background until it arrives.
 *
 * `isLoaded` and `missing` answer the residency question synchronously for a
 * caller that does need to know before it draws, such as the MP4 exporter, and
 * `prefetch` schedules no work at all when the answer is that everything is
 * already there.
 */

/**
 * Maximum number of opportunistically loaded tiles held at once. Tiles that
 * arrived through a `get` miss are evicted least recently used first once the
 * cache is over this many.
 */
const MAX_LOADED = 700;

/**
 * Ceiling on the working set pinned at any one time.
 *
 * A prefetch declares the tiles a render needs. Those tiles have to survive
 * until the render is done, so they are exempt from the LRU cap: a plan longer
 * than MAX_LOADED would otherwise evict its own earliest tiles while it was
 * still loading the later ones, and every opening frame would come out blank.
 * The ceiling keeps a pathological plan from pinning the whole world.
 */
// Satellite 256 px tiles decode to roughly 0.26 MB each, so 3200 pinned bounds decoded-tile memory near 850 MB worst case, and far less for carto where plans are small.
const MAX_PINNED = 3200;

/** Ceiling on prefetch concurrency, to stay polite to the tile hosts. */
const MAX_CONCURRENCY = 24;

/** Load attempts a tile gets before it counts as exhausted. */
const MAX_ATTEMPTS = 3;

/** Wait before a tile that just failed may be tried again, in milliseconds. */
const RETRY_COOLDOWN_MS = 1500;

/**
 * Wait before a tile that used up every attempt may start over, in
 * milliseconds. Long enough that a doomed tile is not hammered, short enough
 * that a user whose wifi came back gets real tiles on the next export.
 */
const EXHAUSTED_RETRY_MS = 15000;

/**
 * Ceiling on a single load attempt, in milliseconds.
 *
 * An image that neither loads nor errors would otherwise leave its entry in the
 * loading state for good, and a caller waiting on that tile would never be
 * released. A timeout counts as an ordinary failed attempt, so the usual retry,
 * cooldown and exhaustion rules apply and one dead tile settles as
 * failed-but-done rather than hanging an export.
 */
const LOAD_TIMEOUT_MS = 12000;

/**
 * Monotonic-ish clock for cooldown bookkeeping. Never used in render math.
 * @returns {number} Milliseconds.
 */
function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Build an AbortError that matches what fetch would throw.
 * @returns {Error} An AbortError.
 */
function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError');
  }
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export class TileCache {
  /**
   * @param {{template: string, subdomains: string[], size: number, zoomBias: number, minZoom: number, maxZoom: number}} tilesSpec
   *   A theme's `tiles` block.
   */
  constructor(tilesSpec) {
    /** @type {object} The tiles spec this cache serves. */
    this.spec = tilesSpec;
    /** @type {Map<string, object>} Key to entry, in least recently used order. */
    this.entries = new Map();
    /** @type {number} Tiles that used up every attempt. */
    this.failedCount = 0;
    /** @type {number} Tiles currently held in the loaded state. */
    this.okCount = 0;
    /** @type {Map<string, number>} Pinned key to how many working sets hold it. */
    this.pinned = new Map();
    /** @type {boolean} True once dispose has run. */
    this.disposed = false;
  }

  /**
   * Fetch a tile for drawing.
   *
   * Never blocks: on a miss it starts the load and returns null for this frame,
   * so the theme background shows through until the image arrives. A tile whose
   * cooldown has elapsed is quietly retried here too, which is how the preview
   * heals itself after a network blip.
   *
   * @param {number} z Integer tile zoom.
   * @param {number} x Tile column, wrapped around the world here.
   * @param {number} y Tile row, rejected when outside the world.
   * @returns {HTMLImageElement|null} A decoded image, or null.
   */
  get(z, x, y) {
    if (this.disposed) return null;
    const n = Math.pow(2, z);
    if (!(y >= 0) || y >= n) return null;
    const wx = ((x % n) + n) % n;
    const key = z + '/' + wx + '/' + y;

    const found = this.entries.get(key);
    if (found) {
      if (found.state === 'ok') {
        // Touch: re-inserting moves the key to the most recent position.
        this.entries.delete(key);
        this.entries.set(key, found);
        return found.img && found.img.complete ? found.img : null;
      }
      if (found.state !== 'loading') this._retryIfDue(key, z, wx, y, found);
      return null;
    }

    this._start(key, z, wx, y);
    return null;
  }

  /**
   * Whether a tile is decoded and ready to draw this instant.
   *
   * Synchronous and free of side effects: it never starts a load and never
   * touches the LRU order, so a caller can ask about every tile of every frame
   * without changing what the cache would otherwise have done.
   *
   * @param {number} z Integer tile zoom.
   * @param {number} x Tile column, wrapped around the world here.
   * @param {number} y Tile row.
   * @returns {boolean} True when `get` would hand back an image right now.
   */
  isLoaded(z, x, y) {
    if (this.disposed) return false;
    const n = Math.pow(2, z);
    if (!(y >= 0) || y >= n) return false;
    const wx = ((x % n) + n) % n;
    return this._resident(z + '/' + wx + '/' + y);
  }

  /**
   * The tiles of a list that are not resident yet.
   *
   * The world check and the dedupe match `prefetch`, so an empty result means a
   * prefetch of the same list would have had nothing to load. Tiles outside the
   * world are never drawn and so never reported as missing. Same cost profile
   * as `isLoaded`: one map lookup per entry, and nothing is allocated beyond the
   * result itself.
   *
   * @param {Array<{z: number, x: number, y: number}>} list Tiles to check.
   * @returns {Array<{z: number, x: number, y: number}>} The subset still to load.
   */
  missing(list) {
    /** @type {Array<{z: number, x: number, y: number}>} */
    const out = [];
    if (this.disposed) return out;
    const source = Array.isArray(list) ? list : [];
    let seen = null;
    for (let i = 0; i < source.length; i++) {
      const it = source[i];
      if (!it) continue;
      const n = Math.pow(2, it.z);
      if (!(it.y >= 0) || it.y >= n) continue;
      const wx = ((it.x % n) + n) % n;
      const key = it.z + '/' + wx + '/' + it.y;
      if (this._resident(key)) continue;
      if (!seen) seen = new Set();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ z: it.z, x: wx, y: it.y });
    }
    return out;
  }

  /**
   * Whether a cache key currently holds a decoded image.
   * @param {string} key Cache key, already wrapped.
   * @returns {boolean} True when the image is there and complete.
   */
  _resident(key) {
    const entry = this.entries.get(key);
    return Boolean(entry && entry.state === 'ok' && entry.img && entry.img.complete);
  }

  /**
   * Warm the cache for a list of tiles.
   *
   * Unless `pin` is false the list becomes a pinned working set: those tiles are
   * held against LRU eviction until `releasePins` is called with the same list.
   * Pins are counted, so overlapping working sets (the export windows, say) can
   * be held and released independently. Without pinning, a plan longer than the
   * LRU cap would evict its own opening tiles before the caller ever drew a
   * frame with them.
   *
   * Tiles that fail are retried inside this call, up to MAX_ATTEMPTS each, so
   * `failed` counts only the tiles that used up every attempt. A tile that has
   * already used up its attempts is reported as failed straight away rather than
   * waited on, so a dead tile can never hold a caller.
   *
   * A list whose tiles are all resident already schedules no work at all: the
   * pins are taken, progress is reported once, and the returned promise is
   * resolved. That is what makes a per-frame residency check cheap enough to run
   * on every frame of an export.
   *
   * @param {Array<{z: number, x: number, y: number}>} list Tiles to load.
   * @param {{onProgress?: function(number, number): void, signal?: AbortSignal, concurrency?: number, pin?: boolean}} [opts]
   *   Progress reporter, abort signal, pool size, and whether to pin.
   * @returns {Promise<{ok: number, failed: number}>} Counts once every tile has
   *   settled. Rejects with an AbortError if the signal fires.
   */
  prefetch(list, opts) {
    const options = opts || {};
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const signal = options.signal || null;
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, options.concurrency || 10));
    const items = this._normalise(list);

    if (options.pin !== false) this._pin(items);

    if (signal && signal.aborted) return Promise.reject(abortError());
    if (items.length && !this.disposed && this._allResident(items)) {
      if (onProgress) {
        try {
          onProgress(items.length, items.length);
        } catch (err) {
          // A broken progress reporter must not break the call.
        }
      }
      return Promise.resolve({ ok: items.length, failed: 0 });
    }

    return this._run(items, onProgress, signal, concurrency);
  }

  /**
   * Whether every normalised item already holds a decoded image.
   * @param {Array<{key: string}>} items Normalised items.
   * @returns {boolean} True when there is nothing to load.
   */
  _allResident(items) {
    for (let i = 0; i < items.length; i++) {
      if (!this._resident(items[i].key)) return false;
    }
    return true;
  }

  /**
   * Drop one hold on each tile of a previously pinned list.
   *
   * Tiles nobody else holds go back under the LRU cap immediately. Releasing a
   * list that was never pinned, or releasing twice, is harmless.
   *
   * @param {Array<{z: number, x: number, y: number}>} list The list handed to prefetch.
   * @returns {void}
   */
  releasePins(list) {
    if (this.disposed) return;
    const items = this._normalise(list);
    for (let i = 0; i < items.length; i++) {
      const key = items[i].key;
      const held = this.pinned.get(key);
      if (held === undefined) continue;
      if (held <= 1) this.pinned.delete(key);
      else this.pinned.set(key, held - 1);
    }
    this._evict();
  }

  /**
   * Cancel every pending load and drop every cached image.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.forEach(function (entry) {
      if (entry.state === 'loading' && entry.settle) entry.settle(false);
    });
    this.entries.clear();
    this.pinned.clear();
    this.okCount = 0;
  }

  /**
   * Turn a caller's list into unique, world-checked cache items.
   * @param {Array<{z: number, x: number, y: number}>} list Tiles.
   * @returns {Array<{key: string, z: number, x: number, y: number, seen: boolean}>} Items.
   */
  _normalise(list) {
    const items = [];
    const seen = new Set();
    const source = Array.isArray(list) ? list : [];
    for (let i = 0; i < source.length; i++) {
      const it = source[i];
      if (!it) continue;
      const n = Math.pow(2, it.z);
      if (!(it.y >= 0) || it.y >= n) continue;
      const wx = ((it.x % n) + n) % n;
      const key = it.z + '/' + wx + '/' + it.y;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key: key, z: it.z, x: wx, y: it.y, seen: false, ok: false });
    }
    return items;
  }

  /**
   * Add one hold to each item, respecting the pinned ceiling.
   *
   * A key already pinned is always counted up, only brand new keys can be
   * turned away at the ceiling, so a release can never unpin a tile another
   * working set still holds.
   *
   * @param {Array<{key: string}>} items Normalised items.
   * @returns {void}
   */
  _pin(items) {
    for (let i = 0; i < items.length; i++) {
      const key = items[i].key;
      const held = this.pinned.get(key);
      if (held !== undefined) this.pinned.set(key, held + 1);
      else if (this.pinned.size < MAX_PINNED) this.pinned.set(key, 1);
    }
  }

  /**
   * Load every item, sweeping the ones that failed until their attempts run out.
   * @param {Array<object>} items Normalised items.
   * @param {function(number, number): void|null} onProgress Reporter.
   * @param {AbortSignal|null} signal Cancels the run.
   * @param {number} concurrency Pool size.
   * @returns {Promise<{ok: number, failed: number}>} Settled counts.
   */
  async _run(items, onProgress, signal, concurrency) {
    if (signal && signal.aborted) throw abortError();
    const total = items.length;
    if (this.disposed || total === 0) return { ok: 0, failed: 0 };

    let reported = 0;
    const onSettle = function (item) {
      // Progress counts each tile once, so a retry sweep never walks the bar back.
      if (item.seen) return;
      item.seen = true;
      reported++;
      if (!onProgress) return;
      try {
        onProgress(reported, total);
      } catch (err) {
        // A broken progress reporter must not abort the run.
      }
    };

    let pending = items;
    for (let pass = 0; pass < MAX_ATTEMPTS && pending.length; pass++) {
      if (pass > 0) await this._waitForRetry(pending, signal);
      if (this.disposed) break;
      pending = await this._pass(pending, concurrency, signal, onSettle);
    }

    let ok = 0;
    for (let i = 0; i < total; i++) {
      if (items[i].ok) ok++;
    }
    if (onProgress && reported < total) {
      try {
        onProgress(total, total);
      } catch (err) {
        // Same as above.
      }
    }
    return { ok: ok, failed: total - ok };
  }

  /**
   * Run one loading pass over a list and collect the tiles worth retrying.
   * @param {Array<object>} items Items to attempt.
   * @param {number} concurrency Pool size.
   * @param {AbortSignal|null} signal Cancels the pass.
   * @param {function(object): void} onSettle Called once per item as it settles.
   * @returns {Promise<Array<object>>} Items still inside their attempt budget.
   */
  _pass(items, concurrency, signal, onSettle) {
    const self = this;
    return new Promise(function (resolve, reject) {
      let settled = false;
      let done = 0;
      let next = 0;
      let active = 0;
      const retry = [];
      const total = items.length;

      function detach() {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onAbort() {
        if (settled) return;
        settled = true;
        detach();
        reject(abortError());
      }

      if (signal) {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      function pump() {
        while (!settled && active < concurrency && next < total) {
          const it = items[next++];
          active++;
          self._ensure(it.key, it.z, it.x, it.y).then(function (good) {
            if (settled) return;
            active--;
            done++;
            if (good) it.ok = true;
            else {
              const entry = self.entries.get(it.key);
              if (entry && entry.state === 'cooldown') retry.push(it);
            }
            onSettle(it);
            if (done >= total) {
              settled = true;
              detach();
              resolve(retry);
            } else {
              pump();
            }
          });
        }
      }

      pump();
    });
  }

  /**
   * Sleep until the pending tiles are allowed another attempt.
   * @param {Array<object>} items Items waiting on a cooldown.
   * @param {AbortSignal|null} signal Cancels the wait.
   * @returns {Promise<void>} Resolves when the cooldown has passed.
   */
  _waitForRetry(items, signal) {
    let wait = 0;
    const now = nowMs();
    for (let i = 0; i < items.length; i++) {
      const entry = this.entries.get(items[i].key);
      if (!entry) continue;
      const left = entry.retryAt - now;
      if (left > wait) wait = left;
    }
    wait = Math.min(Math.max(0, wait), RETRY_COOLDOWN_MS);
    if (wait <= 0) return Promise.resolve();

    return new Promise(function (resolve, reject) {
      let timer = setTimeout(function () {
        timer = 0;
        cleanup();
        resolve();
      }, wait);
      function cleanup() {
        if (timer) clearTimeout(timer);
        timer = 0;
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onAbort() {
        cleanup();
        reject(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  /**
   * Ensure a tile is loading or loaded, and report the outcome.
   * @param {string} key Cache key, already wrapped.
   * @param {number} z Tile zoom.
   * @param {number} x Wrapped tile column.
   * @param {number} y Tile row.
   * @returns {Promise<boolean>} True when the tile is available.
   */
  _ensure(key, z, x, y) {
    if (this.disposed) return Promise.resolve(false);
    const found = this.entries.get(key);
    if (!found) return this._start(key, z, x, y).promise;
    if (found.state === 'ok') return Promise.resolve(true);
    if (found.state === 'loading') return found.promise;
    const restarted = this._retryIfDue(key, z, x, y, found);
    if (restarted) return restarted.promise;
    // Cooling down or out of attempts. Either way it settles now as failed, so a
    // caller waiting on this tile is released instead of held behind its
    // cooldown.
    return Promise.resolve(false);
  }

  /**
   * Start another attempt on a cooling or exhausted tile, if its wait is over.
   * @param {string} key Cache key, already wrapped.
   * @param {number} z Tile zoom.
   * @param {number} x Wrapped tile column.
   * @param {number} y Tile row.
   * @param {object} entry The current cache entry.
   * @returns {object|null} The restarted entry, or null while it is still waiting.
   */
  _retryIfDue(key, z, x, y, entry) {
    if (nowMs() < entry.retryAt) return null;
    if (entry.state === 'failed') {
      // The long cooldown is up: give the tile a whole fresh set of attempts.
      entry.attempts = 0;
      if (this.failedCount > 0) this.failedCount--;
    }
    return this._start(key, z, x, y);
  }

  /**
   * Begin one load attempt for a tile.
   * @param {string} key Cache key, already wrapped.
   * @param {number} z Tile zoom.
   * @param {number} x Wrapped tile column.
   * @param {number} y Tile row.
   * @returns {object} The cache entry.
   */
  _start(key, z, x, y) {
    const self = this;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: 'loading', img: null, promise: null, settle: null, attempts: 0, retryAt: 0 };
      this.entries.set(key, entry);
    } else {
      entry.state = 'loading';
      entry.img = null;
      entry.settle = null;
    }
    const attempt = entry.attempts;

    entry.promise = new Promise(function (resolve) {
      let finished = false;
      let timer = 0;

      function settle(good) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        timer = 0;
        const img = entry.img;
        if (img) {
          img.onload = null;
          img.onerror = null;
        }
        if (self.disposed) {
          entry.state = good ? 'ok' : 'failed';
          resolve(good);
          return;
        }
        if (good) {
          entry.state = 'ok';
          entry.retryAt = 0;
          self.okCount++;
          self._evict();
        } else {
          entry.img = null;
          entry.attempts = attempt + 1;
          if (entry.attempts >= MAX_ATTEMPTS) {
            entry.state = 'failed';
            entry.retryAt = nowMs() + EXHAUSTED_RETRY_MS;
            self.failedCount++;
          } else {
            entry.state = 'cooldown';
            // The first miss is often one unlucky host, so try again at once.
            entry.retryAt = nowMs() + (entry.attempts === 1 ? 0 : RETRY_COOLDOWN_MS);
          }
        }
        resolve(good);
      }
      entry.settle = settle;

      const img = new Image();
      entry.img = img;
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = function () {
        settle(!self.disposed);
      };
      img.onerror = function () {
        settle(false);
      };
      // A request that never answers has to end as a failed attempt, otherwise
      // the entry would sit in the loading state and anything awaiting it would
      // wait for good.
      timer = setTimeout(function () {
        timer = 0;
        settle(false);
      }, LOAD_TIMEOUT_MS);
      img.src = self._url(z, x, y, attempt);
    });

    return entry;
  }

  /**
   * Build the request URL for a tile.
   * @param {number} z Tile zoom.
   * @param {number} x Wrapped tile column.
   * @param {number} y Tile row.
   * @param {number} attempt Zero based attempt index, rotates the subdomain.
   * @returns {string} The tile URL.
   */
  _url(z, x, y, attempt) {
    const subs = this.spec.subdomains;
    let s = '';
    if (subs && subs.length) s = subs[(x + y + attempt) % subs.length];
    return this.spec.template
      .replace(/\{s\}/g, s)
      .replace(/\{z\}/g, String(z))
      .replace(/\{x\}/g, String(x))
      .replace(/\{y\}/g, String(y));
  }

  /**
   * Drop the least recently used loaded tiles until the cap is met.
   *
   * Tiles still in flight are never evicted, and neither are the tiles any
   * pinned working set still holds.
   * @returns {void}
   */
  _evict() {
    // Cheap precondition: evictable tiles are a subset of the loaded ones.
    if (this.okCount <= MAX_LOADED) return;

    const self = this;
    const candidates = [];
    this.entries.forEach(function (entry, key) {
      if (entry.state !== 'ok') return;
      if (self.pinned.has(key)) return;
      candidates.push(key);
    });

    // Map iteration is insertion order, and `get` re-inserts on a hit, so the
    // front of this list is the least recently used.
    const over = candidates.length - MAX_LOADED;
    for (let i = 0; i < over; i++) {
      this.entries.delete(candidates[i]);
      this.okCount--;
    }
  }
}
