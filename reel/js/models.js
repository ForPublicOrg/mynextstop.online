/**
 * Small flat shaded 3D vehicles, drawn with plain Canvas 2D.
 *
 * WebGL is off the table for this project, so each vehicle is a handful of
 * polygons, tubes and spheres in metres, turned to its heading, rolled into a
 * lean, projected through a pinhole camera and painted far to near. Faces are
 * lit from one fixed light, so a car turning through a bend catches the light
 * the way a real one would.
 *
 * Model space: x forward, y to the vehicle's left, z up, origin on the ground
 * under the middle of the vehicle.
 *
 * Camera space is the ground frame scene.js uses: gx to the right of the
 * screen, gy away from the viewer, z up, all in ground pixels, measured from
 * the point the camera looks at. `cam` is { f, sin, cos, sx, sy }: focal length
 * in pixels, the sine and cosine of the pitch (0 looks straight down), and the
 * screen point the focus lands on.
 */

import { drawVehicle } from './vehicles.js?v=e6';

/** Design choices per ground mode, in picker order. 'flat' is the classic icon. */
export const DESIGNS = {
  car: [
    { id: 'hatch', label: 'Hatchback' },
    { id: 'suv', label: 'SUV' },
    { id: 'jeep', label: 'Jeep' },
    { id: 'sports', label: 'Sports' },
    { id: 'flat', label: 'Icon' }
  ],
  moto: [
    { id: 'cruiser', label: 'Cruiser' },
    { id: 'sport', label: 'Sport' },
    { id: 'scooter', label: 'Scooter' },
    { id: 'flat', label: 'Icon' }
  ],
  cycle: [
    { id: 'road', label: 'Road' },
    { id: 'mtb', label: 'Mountain' },
    { id: 'city', label: 'City' },
    { id: 'flat', label: 'Icon' }
  ]
};

export const DEFAULT_DESIGNS = { car: 'hatch', moto: 'cruiser', cycle: 'road' };

/** Ground pixels per metre at unit scale, before the per mode boost. */
export const PX_PER_M = 30;

/** Two wheelers are tiny next to a car, so they are drawn a little larger. */
const KIND_BOOST = { car: 1, moto: 1.7, cycle: 1.85 };

/**
 * A clean { car, moto, cycle } design map, unknown ids replaced by defaults.
 * @param {*} d Anything, usually a saved draft field.
 * @returns {{car: string, moto: string, cycle: string}} Valid design ids.
 */
export function normalizeDesigns(d) {
  const out = {};
  const src = d && typeof d === 'object' ? d : {};
  Object.keys(DEFAULT_DESIGNS).forEach(function (kind) {
    const ok = DESIGNS[kind].some(function (x) { return x.id === src[kind]; });
    out[kind] = ok ? src[kind] : DEFAULT_DESIGNS[kind];
  });
  return out;
}

/**
 * Project a ground frame point.
 * @param {{f: number, sin: number, cos: number, sx: number, sy: number}} cam Camera.
 * @param {number} gx Right of the focus, ground pixels.
 * @param {number} gy Away from the viewer, ground pixels.
 * @param {number} z Up, ground pixels.
 * @returns {{x: number, y: number, k: number, d: number}} Screen point, size factor, depth.
 */
export function project(cam, gx, gy, z) {
  const d = cam.f + gy * cam.sin - z * cam.cos;
  const k = cam.f / Math.max(1e-3, d);
  return { x: cam.sx + gx * k, y: cam.sy - (gy * cam.cos + z * cam.sin) * k, k: k, d: d };
}

/* ----------------------------------------------------------------- colour */

const RGB = new Map();
function rgbOf(hex) {
  let c = RGB.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    RGB.set(hex, c);
  }
  return c;
}

// Key light from the upper left, a little toward the viewer.
const LIGHT = (function () {
  const v = [-0.42, -0.5, 0.76];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
}());

function shadeOf(hex, n, flat) {
  const c = rgbOf(hex);
  if (flat) return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  const lam = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  const k = 0.5 + 0.62 * lam;
  const out = c.map(function (v) {
    // Past full light, lift toward white instead of clipping the hue.
    return k <= 1 ? Math.round(v * k) : Math.round(v + (255 - v) * (k - 1) * 0.9);
  });
  return 'rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')';
}

/* ---------------------------------------------------------------- builder */

function Builder() {
  this.items = [];
}

/** A face. `ref` is a point inside the solid, used to point the normal outward. */
Builder.prototype.poly = function (pts, color, o) {
  o = o || {};
  this.items.push({ t: 'poly', pts: pts, color: color, layer: o.layer || 1, ref: o.ref || null, flat: !!o.flat, extras: o.extras || null });
};
Builder.prototype.line = function (a, b, w, color, layer) {
  this.items.push({ t: 'line', pts: [a, b], w: w, color: color, layer: layer || 1 });
};
Builder.prototype.ball = function (c, r, color, layer) {
  this.items.push({ t: 'ball', pts: [c], r: r, color: color, layer: layer || 1 });
};
Builder.prototype.loop = function (pts, w, color, layer) {
  this.items.push({ t: 'loop', pts: pts, w: w, color: color, layer: layer || 1 });
};

function inset(pts, k) {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
  cx /= pts.length; cy /= pts.length; cz /= pts.length;
  return pts.map(function (p) {
    return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k, cz + (p[2] - cz) * k];
  });
}

/**
 * Extrude a side profile, counter clockwise as seen from the right with the
 * front to the right, between half widths hw0 (lowest point) and hw1 (highest).
 */
function prism(b, prof, hw0, hw1, color, o) {
  o = o || {};
  let zMin = Infinity;
  let zMax = -Infinity;
  prof.forEach(function (p) { zMin = Math.min(zMin, p[1]); zMax = Math.max(zMax, p[1]); });
  const hw = function (z) { return zMax > zMin ? hw0 + (hw1 - hw0) * (z - zMin) / (zMax - zMin) : hw0; };
  const R = prof.map(function (p) { return [p[0], -hw(p[1]), p[1]]; });
  const L = prof.map(function (p) { return [p[0], hw(p[1]), p[1]]; });
  const glass = function (pts) { return o.glass ? [{ pts: inset(pts, o.glassK || 0.8), color: o.glass }] : null; };
  b.poly(R, color, { layer: o.layer, extras: glass(R) });
  b.poly(L.slice().reverse(), color, { layer: o.layer, extras: glass(L) });
  for (let i = 0; i < prof.length; i++) {
    const j = (i + 1) % prof.length;
    const quad = [L[i], L[j], R[j], R[i]];
    const g = o.edgeGlass && o.edgeGlass[i];
    b.poly(quad, (o.edgeColor && o.edgeColor[i]) || color, {
      layer: o.layer,
      extras: g ? [{ pts: inset(quad, g.k || 0.86), color: g.color }] : null
    });
  }
}

function box(b, x0, x1, y0, y1, z0, z1, color, layer) {
  const P = function (x, y, z) { return [x, y, z]; };
  const ref = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const faces = [
    [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)],
    [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)],
    [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)],
    [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)],
    [P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)],
    [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)]
  ];
  faces.forEach(function (f) { b.poly(f, color, { layer: layer, ref: ref }); });
}

/** A solid wheel on a y axis (or an x axis for a spare) with rim, hub and spokes. */
function wheel(b, x, y, z, r, w, spin, c, o) {
  o = o || {};
  const n = 14;
  const axisX = o.axis === 'x';
  const at = function (a, off) {
    const u = r * Math.cos(a);
    const v = r * Math.sin(a);
    return axisX ? [x + off, y + u, z + v] : [x + u, y + off, z + v];
  };
  const A = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const a = spin + (i / n) * Math.PI * 2;
    A.push(at(a, w / 2));
    B.push(at(a, -w / 2));
  }
  const ref = [x, y, z];
  const layer = o.layer || 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.poly([A[i], A[j], B[j], B[i]], c.tyre, { layer: layer, ref: ref });
  }
  const capExtras = function (pts, off) {
    const ex = [
      { pts: inset(pts, o.rimK || 0.66), color: c.rim },
      { pts: inset(pts, 0.24), color: c.hub || '#3a3e44' }
    ];
    const spokes = o.spokes || 5;
    for (let s = 0; s < spokes; s++) {
      const a = spin + (s / spokes) * Math.PI * 2;
      ex.push({ line: [at(a, off), axisX ? [x + off, y, z] : [x, y + off, z]], w: r * 0.11, color: c.hub || '#3a3e44' });
    }
    return ex;
  };
  b.poly(A, c.tyre, { layer: layer, ref: ref, extras: capExtras(A, w / 2) });
  b.poly(B, c.tyre, { layer: layer, ref: ref, extras: capExtras(B, -w / 2) });
}

/** A spoked bicycle wheel: tyre ring, rim ring and turning spokes. */
function bikeWheel(b, x, z, r, tw, spin, c) {
  const tyre = [];
  const rim = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    tyre.push([x + r * Math.cos(a), 0, z + r * Math.sin(a)]);
    rim.push([x + (r - tw) * Math.cos(a), 0, z + (r - tw) * Math.sin(a)]);
  }
  b.loop(tyre, tw * 1.6, c.tyre);
  b.loop(rim, 0.016, c.rim);
  for (let s = 0; s < 8; s++) {
    const a = spin + (s / 8) * Math.PI * 2;
    b.line([x, 0, z], [x + (r - tw) * Math.cos(a), 0, z + (r - tw) * Math.sin(a)], 0.008, c.rim);
  }
}

/** Two bone leg, knee forward, in the x-z plane at a fixed y. */
function leg(b, hip, foot, a, l2, w, cThigh, cShin, cShoe) {
  const dx = foot[0] - hip[0];
  const dz = foot[2] - hip[2];
  const d = Math.min(Math.hypot(dx, dz), a + l2 - 1e-3);
  const base = Math.atan2(dz, dx);
  const off = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - l2 * l2) / (2 * a * d))));
  const knee = [hip[0] + a * Math.cos(base + off), hip[1], hip[2] + a * Math.sin(base + off)];
  b.line(hip, knee, w, cThigh);
  b.line(knee, foot, w * 0.85, cShin);
  b.ball(foot, w * 0.5, cShoe);
}

/** Torso, head, and arms reaching for the bars. */
function rider(b, r) {
  const neck = [r.shoulder[0], 0, r.shoulder[2]];
  b.line([r.hip[0], 0, r.hip[2]], neck, 0.34, r.top);
  b.ball([neck[0] + r.head[0], 0, neck[2] + r.head[1]], 0.135, r.helmet);
  [-1, 1].forEach(function (s) {
    const sh = [r.shoulder[0], s * 0.19, r.shoulder[2]];
    const grip = [r.grip[0], s * r.grip[1], r.grip[2]];
    const elbow = [(sh[0] + grip[0]) / 2, s * (Math.abs(sh[1]) + Math.abs(grip[1])) / 2 * 1.08, (sh[2] + grip[2]) / 2 - 0.05];
    b.line(sh, elbow, 0.1, r.top);
    b.line(elbow, grip, 0.085, r.top);
    b.ball(grip, 0.045, r.skin || '#c8906b');
  });
}

/* ---------------------------------------------------------------- designs */

const GLASS = '#2b3a49';
const TYRE = { tyre: '#1e2023', rim: '#c9ced6', hub: '#5b6168' };

function carBody(b, s, d) {
  prism(b, d.body, d.hw, d.hw * 0.97, d.color, { layer: 1 });
  prism(b, d.cabin, d.cw0, d.cw1, d.roof || d.color, {
    layer: 2,
    glass: d.sideGlass === false ? null : GLASS,
    glassK: 0.78,
    edgeGlass: { 1: { color: GLASS, k: 0.84 }, 3: { color: GLASS, k: 0.8 } }
  });
  const fx = d.front;
  const rx = d.rear;
  [-1, 1].forEach(function (side) {
    b.poly([[fx, side * d.lightY[0], d.lightZ[0]], [fx, side * d.lightY[1], d.lightZ[0]], [fx, side * d.lightY[1], d.lightZ[1]], [fx, side * d.lightY[0], d.lightZ[1]]], '#fff3d1', { layer: 3, ref: [0, 0, d.lightZ[0]], flat: true });
    b.poly([[rx, side * d.lightY[0], d.tailZ[0]], [rx, side * d.lightY[1], d.tailZ[0]], [rx, side * d.lightY[1], d.tailZ[1]], [rx, side * d.lightY[0], d.tailZ[1]]], '#d0202a', { layer: 3, ref: [0, 0, d.tailZ[0]], flat: true });
  });
  b.poly([[fx, -d.lightY[0] + 0.12, d.lightZ[0] - 0.04], [fx, d.lightY[0] - 0.12, d.lightZ[0] - 0.04], [fx, d.lightY[0] - 0.12, d.lightZ[1] - 0.06], [fx, -d.lightY[0] + 0.12, d.lightZ[1] - 0.06]], '#22252a', { layer: 3, ref: [0, 0, d.lightZ[0]], flat: true });
  const wc = { tyre: TYRE.tyre, rim: d.rim || TYRE.rim, hub: TYRE.hub };
  [d.wx, -d.wx].forEach(function (x) {
    [-1, 1].forEach(function (side) {
      wheel(b, x, side * d.wy, d.wr, d.wr, d.ww, -s.spin, wc, { layer: 0 });
    });
  });
}

const CARS = {
  hatch: {
    len: 4, wid: 1.75,
    color: '#d33a30',
    body: [[-1.95, 0.34], [1.8, 0.34], [1.96, 0.46], [1.96, 0.7], [1.7, 0.87], [0.55, 0.96], [-1.82, 0.99], [-1.97, 0.82], [-1.97, 0.46]],
    hw: 0.86,
    cabin: [[-1.78, 0.97], [0.5, 0.96], [-0.12, 1.5], [-1.6, 1.52]],
    cw0: 0.8, cw1: 0.67,
    front: 1.965, rear: -1.975, lightY: [0.48, 0.78], lightZ: [0.56, 0.68], tailZ: [0.64, 0.78],
    wx: 1.25, wy: 0.74, wr: 0.31, ww: 0.22
  },
  suv: {
    len: 4.6, wid: 1.9,
    color: '#eceef1', rim: '#9aa1aa',
    body: [[-2.25, 0.46], [2.15, 0.46], [2.29, 0.62], [2.29, 0.94], [2.05, 1.12], [0.75, 1.18], [-2.2, 1.2], [-2.31, 1.02], [-2.31, 0.62]],
    hw: 0.95,
    cabin: [[-2.16, 1.18], [0.72, 1.18], [0.05, 1.78], [-2.05, 1.8]],
    cw0: 0.9, cw1: 0.8,
    front: 2.295, rear: -2.315, lightY: [0.5, 0.86], lightZ: [0.8, 0.94], tailZ: [0.86, 1.04],
    wx: 1.45, wy: 0.82, wr: 0.4, ww: 0.28,
    extra: function (b) {
      box(b, 2.12, 2.36, -0.92, 0.92, 0.38, 0.6, '#2b2f36', 1);
      box(b, -2.38, -2.18, -0.92, 0.92, 0.38, 0.6, '#2b2f36', 1);
      b.line([-1.95, 0.7, 1.86], [-0.2, 0.7, 1.86], 0.05, '#2b2f36', 3);
      b.line([-1.95, -0.7, 1.86], [-0.2, -0.7, 1.86], 0.05, '#2b2f36', 3);
    }
  },
  jeep: {
    len: 4.1, wid: 1.85,
    color: '#5e6a3a', roof: '#24272b', sideGlass: false,
    body: [[-1.9, 0.56], [1.86, 0.56], [1.96, 0.66], [1.96, 1.04], [0.62, 1.07], [-1.9, 1.07]],
    hw: 0.9,
    cabin: [[-1.85, 1.06], [0.5, 1.06], [0.3, 1.78], [-1.8, 1.78]],
    cw0: 0.86, cw1: 0.84,
    front: 1.965, rear: -1.905, lightY: [0.56, 0.78], lightZ: [0.8, 0.96], tailZ: [0.7, 0.86],
    wx: 1.3, wy: 0.82, wr: 0.44, ww: 0.32, rim: '#2c2f33',
    extra: function (b, s) {
      wheel(b, -2.05, 0, 0.98, 0.36, 0.24, s.spin * 0, { tyre: '#1e2023', rim: '#2c2f33', hub: '#55595f' }, { axis: 'x', layer: 2 });
      box(b, 1.9, 2.1, -0.95, 0.95, 0.46, 0.62, '#1f2125', 1);
    }
  },
  sports: {
    len: 4.4, wid: 1.95,
    color: '#f2c230', rim: '#2a2d31',
    body: [[-2.15, 0.3], [2.0, 0.3], [2.25, 0.42], [2.2, 0.56], [1.6, 0.73], [0.4, 0.83], [-1.9, 0.87], [-2.2, 0.76], [-2.2, 0.44]],
    hw: 0.98,
    cabin: [[-1.25, 0.83], [0.45, 0.81], [-0.25, 1.22], [-1.0, 1.24]],
    cw0: 0.82, cw1: 0.6,
    front: 2.255, rear: -2.205, lightY: [0.5, 0.84], lightZ: [0.44, 0.52], tailZ: [0.6, 0.72],
    wx: 1.35, wy: 0.84, wr: 0.34, ww: 0.3,
    extra: function (b) {
      box(b, -2.18, -1.86, -0.86, 0.86, 1.02, 1.07, '#1d1f23', 3);
      b.line([-2.0, 0.5, 0.86], [-2.0, 0.5, 1.03], 0.04, '#1d1f23', 2);
      b.line([-2.0, -0.5, 0.86], [-2.0, -0.5, 1.03], 0.04, '#1d1f23', 2);
      b.poly([[1.6, -0.14, 0.735], [1.6, 0.14, 0.735], [0.42, 0.14, 0.835], [0.42, -0.14, 0.835]], '#1d1f23', { layer: 3, ref: [1, 0, 0.5] });
    }
  }
};

function buildCar(id) {
  const d = CARS[id];
  return {
    len: d.len,
    wid: d.wid,
    build: function (b, s) {
      carBody(b, s, d);
      if (d.extra) d.extra(b, s);
    }
  };
}

const MOTOS = {
  cruiser: {
    len: 2.2, wid: 0.8, main: '#6d1a24', seat: '#3b271b', engine: '#43474d', rimc: '#c9ced6',
    top: '#2f3a2c', helmet: '#d9d4c7', pants: '#2e3a52',
    wf: 0.8, wb: -0.74, wr: 0.34,
    build: function (b, s, d) {
      box(b, -0.28, 0.3, -0.17, 0.17, 0.28, 0.62, d.engine, 1);
      prism(b, [[-0.12, 0.8], [0.42, 0.8], [0.38, 1.0], [-0.06, 1.02]], 0.17, 0.12, d.main);
      prism(b, [[-0.66, 0.82], [-0.08, 0.8], [-0.1, 0.92], [-0.58, 0.95]], 0.16, 0.14, d.seat);
      prism(b, [[-1.06, 0.48], [-0.58, 0.66], [-0.58, 0.74], [-1.1, 0.56]], 0.1, 0.1, d.main);
      prism(b, [[0.56, 0.64], [1.04, 0.52], [1.06, 0.58], [0.6, 0.72]], 0.08, 0.08, d.main);
      b.line([-0.2, -0.21, 0.3], [-1.0, -0.21, 0.4], 0.075, '#d5d9df');
      [-1, 1].forEach(function (y) { b.line([0.62, y * 0.1, 1.02], [d.wf, y * 0.1, d.wr], 0.045, '#c9ced6'); });
      b.line([0.5, -0.38, 1.16], [0.5, 0.38, 1.16], 0.035, '#2a2d31');
      b.ball([0.74, 0, 1.0], 0.1, '#f4ecd2');
      return { hip: [-0.32, 0, 1.0], shoulder: [-0.04, 0, 1.55], head: [0.04, 0.24], grip: [0.5, 0.36, 1.16], knee: [0.16, 0.22, 0.8], peg: [0.08, 0.22, 0.42] };
    }
  },
  sport: {
    len: 2.1, wid: 0.75, main: '#d7262e', seat: '#1d1f23', engine: '#2b2e33', rimc: '#2a2d31',
    top: '#1d1f23', helmet: '#d7262e', pants: '#1d1f23',
    wf: 0.76, wb: -0.7, wr: 0.32,
    build: function (b, s, d) {
      box(b, -0.25, 0.3, -0.16, 0.16, 0.3, 0.6, d.engine, 1);
      prism(b, [[-0.08, 0.52], [0.72, 0.52], [0.92, 0.86], [0.62, 1.12], [0.12, 1.02]], 0.22, 0.12, d.main);
      prism(b, [[-0.95, 0.86], [-0.3, 0.8], [-0.24, 0.96], [-0.9, 1.02]], 0.12, 0.08, d.main);
      prism(b, [[-0.4, 0.86], [-0.06, 0.86], [-0.08, 0.94], [-0.38, 0.95]], 0.14, 0.12, d.seat);
      b.line([-0.1, -0.18, 0.4], [-0.95, -0.18, 0.78], 0.08, '#4b4f55');
      [-1, 1].forEach(function (y) { b.line([0.58, y * 0.09, 0.98], [d.wf, y * 0.09, d.wr], 0.045, '#d4a017'); });
      b.ball([0.9, 0, 0.84], 0.06, '#f4ecd2');
      return { hip: [-0.22, 0, 1.0], shoulder: [0.3, 0, 1.36], head: [0.13, 0.17], grip: [0.56, 0.3, 1.0], knee: [0.26, 0.26, 0.78], peg: [-0.18, 0.22, 0.56] };
    }
  },
  scooter: {
    len: 1.8, wid: 0.7, main: '#8fd3c1', seat: '#6b4630', engine: '#5b6168', rimc: '#c9ced6',
    top: '#f2efe6', helmet: '#f2c230', pants: '#3a4a6b',
    wf: 0.62, wb: -0.56, wr: 0.23,
    build: function (b, s, d) {
      prism(b, [[0.36, 0.3], [0.64, 0.3], [0.64, 0.58], [0.52, 1.14], [0.4, 1.14], [0.42, 0.56]], 0.22, 0.12, d.main);
      box(b, -0.12, 0.42, -0.19, 0.19, 0.26, 0.34, d.main, 1);
      prism(b, [[-0.82, 0.3], [-0.06, 0.3], [-0.06, 0.6], [-0.26, 0.84], [-0.76, 0.82], [-0.9, 0.56]], 0.22, 0.2, d.main);
      prism(b, [[-0.76, 0.82], [-0.16, 0.84], [-0.2, 0.94], [-0.7, 0.93]], 0.16, 0.14, d.seat);
      b.line([0.44, -0.34, 1.14], [0.44, 0.34, 1.14], 0.04, '#d5d9df');
      b.ball([0.56, 0, 1.08], 0.08, '#f4ecd2');
      return { hip: [-0.42, 0, 0.98], shoulder: [-0.28, 0, 1.52], head: [0.05, 0.24], grip: [0.42, 0.33, 1.13], knee: [0.08, 0.2, 0.86], peg: [0.16, 0.17, 0.38] };
    }
  }
};

function buildMoto(id) {
  const d = MOTOS[id];
  return {
    len: d.len,
    wid: d.wid,
    build: function (b, s) {
      const wc = { tyre: '#1e2023', rim: d.rimc, hub: '#5b6168' };
      wheel(b, d.wf, 0, d.wr, d.wr, 0.13, -s.spin, wc, { rimK: 0.72, spokes: 6 });
      wheel(b, d.wb, 0, d.wr, d.wr, 0.15, -s.spin, wc, { rimK: 0.72, spokes: 6 });
      const r = d.build(b, s, d);
      [-1, 1].forEach(function (side) {
        leg(b, [r.hip[0], side * 0.14, r.hip[2]], [r.peg[0], side * r.peg[1], r.peg[2]], 0.46, 0.46, 0.14, d.pants, d.pants, '#1d1f23');
      });
      rider(b, { hip: r.hip, shoulder: r.shoulder, head: r.head, grip: r.grip, top: d.top, helmet: d.helmet });
    }
  };
}

const CYCLES = {
  road: { frame: '#1f6feb', top: '#ffd23f', helmet: '#f5f6f8', pants: '#1d1f23', tw: 0.03, bar: 'drop', step: false, shoulder: [0.24, 1.3], head: [0.14, 0.15] },
  mtb: { frame: '#f26b1d', top: '#0e7a6c', helmet: '#1d1f23', pants: '#2e3a52', tw: 0.06, bar: 'flat', step: false, shoulder: [0.12, 1.38], head: [0.09, 0.2] },
  city: { frame: '#efe3c8', top: '#e86a5c', helmet: '#3a2a20', pants: '#2e3a52', tw: 0.04, bar: 'swept', step: true, shoulder: [-0.06, 1.46], head: [0.04, 0.24] }
};

function buildCycle(id) {
  const d = CYCLES[id];
  return {
    len: 1.75,
    wid: 0.6,
    build: function (b, s) {
      const R = 0.34;
      bikeWheel(b, -0.5, R, R, d.tw, -s.spin, { tyre: '#1e2023', rim: '#b9bfc7' });
      bikeWheel(b, 0.52, R, R, d.tw, -s.spin, { tyre: '#1e2023', rim: '#b9bfc7' });
      const BB = [0, 0, 0.3];
      const SC = [-0.14, 0, 0.84];
      const HT = [0.42, 0, 0.88];
      const HB = [0.45, 0, 0.72];
      const RA = [-0.5, 0, R];
      const FA = [0.52, 0, R];
      const w = 0.042;
      b.line(SC, BB, w, d.frame);
      if (d.step) b.line(HB, [0.02, 0, 0.42], w, d.frame);
      else b.line(SC, HT, w, d.frame);
      b.line(HB, BB, w * 1.15, d.frame);
      b.line(BB, RA, w * 0.8, d.frame);
      b.line(SC, RA, w * 0.8, d.frame);
      b.line(HT, HB, w * 1.2, d.frame);
      b.line(HB, FA, w * 0.9, d.frame);
      b.line(SC, [-0.19, 0, 0.96], 0.03, '#2a2d31');
      b.line([-0.3, 0, 0.98], [-0.08, 0, 0.98], 0.07, '#1d1f23');
      let grip;
      if (d.bar === 'drop') {
        b.line(HT, [0.5, 0, 0.92], 0.03, '#2a2d31');
        b.line([0.5, -0.21, 0.92], [0.5, 0.21, 0.92], 0.03, '#2a2d31');
        grip = [0.52, 0.21, 0.9];
      } else if (d.bar === 'flat') {
        b.line(HT, [0.46, 0, 0.98], 0.035, '#2a2d31');
        b.line([0.46, -0.33, 0.98], [0.46, 0.33, 0.98], 0.03, '#2a2d31');
        grip = [0.46, 0.31, 0.98];
      } else {
        b.line(HT, [0.44, 0, 1.04], 0.035, '#c9ced6');
        b.line([0.32, -0.28, 1.04], [0.44, 0, 1.04], 0.03, '#c9ced6');
        b.line([0.32, 0.28, 1.04], [0.44, 0, 1.04], 0.03, '#c9ced6');
        box(b, 0.52, 0.8, -0.17, 0.17, 0.82, 1.0, '#a0703c', 2);
        grip = [0.32, 0.28, 1.04];
      }
      // Cranks turn with the wheels; the feet ride the pedals.
      const c = -s.spin * 0.5;
      const feet = [];
      [-1, 1].forEach(function (side, i) {
        const a = c + i * Math.PI;
        const pedal = [0.17 * Math.cos(a), side * 0.12, 0.3 + 0.17 * Math.sin(a)];
        b.line([0, side * 0.06, 0.3], pedal, 0.022, '#2a2d31');
        feet.push(pedal);
      });
      b.loop([[0.1, -0.06, 0.3], [0, -0.06, 0.4], [-0.1, -0.06, 0.3], [0, -0.06, 0.2]], 0.02, '#4b4f55');
      const hip = [-0.2, 0, 1.03];
      feet.forEach(function (p, i) {
        leg(b, [hip[0], (i ? 1 : -1) * 0.11, hip[2]], p, 0.47, 0.46, 0.12, d.pants, '#c8906b', '#f5f6f8');
      });
      rider(b, { hip: hip, shoulder: [d.shoulder[0], 0, d.shoulder[1]], head: d.head, grip: grip, top: d.top, helmet: d.helmet });
    }
  };
}

const MODEL_CACHE = new Map();

/**
 * The model for a leg mode under the chosen designs, or null to draw the flat
 * icon instead.
 * @param {string} mode A MODE_META id.
 * @param {{car: string, moto: string, cycle: string}} designs Chosen designs.
 * @returns {{len: number, wid: number, kind: string, build: Function}|null}
 */
export function modelFor(mode, designs) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_DESIGNS, mode)) return null;
  const id = (designs && designs[mode]) || DEFAULT_DESIGNS[mode];
  if (id === 'flat') return null;
  const key = mode + ':' + id;
  if (MODEL_CACHE.has(key)) return MODEL_CACHE.get(key);
  let m = null;
  if (mode === 'car' && CARS[id]) m = buildCar(id);
  else if (mode === 'moto' && MOTOS[id]) m = buildMoto(id);
  else if (mode === 'cycle' && CYCLES[id]) m = buildCycle(id);
  if (m) m.kind = mode;
  MODEL_CACHE.set(key, m);
  return m;
}

/* --------------------------------------------------------------- renderer */

function newell(p) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const m = Math.hypot(nx, ny, nz) || 1;
  return [nx / m, ny / m, nz / m];
}

function pathOf(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(s[0].x, s[0].y);
  for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
  ctx.closePath();
}

/**
 * Draw a model standing on the ground frame.
 *
 * @param {CanvasRenderingContext2D} ctx Target.
 * @param {object} model From modelFor.
 * @param {{f: number, sin: number, cos: number, sx: number, sy: number}} cam Camera.
 * @param {{gx: number, gy: number, hx: number, hy: number, ppm: number, spin?: number, lean?: number, bob?: number, alpha?: number, halo?: string}} o
 *   Ground position, unit heading in the ground frame, ground pixels per
 *   metre, wheel turn in radians, lean to the left in radians, body bob in
 *   metres, opacity, and an optional halo colour drawn under the shadow.
 * @returns {void}
 */
export function drawModel(ctx, model, cam, o) {
  const ppm = o.ppm * (KIND_BOOST[model.kind] || 1);
  const lean = o.lean || 0;
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  const hx = o.hx;
  const hy = o.hy;
  const bob = o.bob || 0;

  const toGround = function (p, noLean) {
    let y = p[1];
    let z = p[2] + (p[2] > 0.25 ? bob : 0);
    if (!noLean && lean) {
      const y2 = y * cl + z * sl;
      z = -y * sl + z * cl;
      y = y2;
    }
    return [o.gx + ppm * (p[0] * hx - y * hy), o.gy + ppm * (p[0] * hy + y * hx), ppm * z];
  };
  const camPos = [0, -cam.f * cam.sin, cam.f * cam.cos];

  ctx.save();
  ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Contact shadow: two soft layers under the footprint, over an optional
  // light halo that keeps a dark vehicle readable on a dark map.
  const layers = [[1.25, 0.1], [1.04, 0.2]];
  if (o.halo) layers.unshift([1.6, 0, o.halo]);
  layers.forEach(function (layer) {
    const pts = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const g = toGround([Math.cos(a) * model.len * 0.5 * layer[0], Math.sin(a) * model.wid * 0.62 * layer[0], 0], true);
      pts.push(project(cam, g[0], g[1], 0));
    }
    ctx.fillStyle = layer[2] || 'rgba(0,0,0,' + layer[1] + ')';
    pathOf(ctx, pts);
    ctx.fill();
  });

  const b = new Builder();
  model.build(b, { spin: o.spin || 0 });

  const list = [];
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    const g = it.pts.map(function (p) { return toGround(p); });
    const s = g.map(function (p) { return project(cam, p[0], p[1], p[2]); });
    let depth = 0;
    for (let k = 0; k < s.length; k++) depth += s[k].d;
    depth /= s.length;
    let n = null;
    if (it.t === 'poly') {
      n = newell(g);
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < g.length; k++) { cx += g[k][0]; cy += g[k][1]; cz += g[k][2]; }
      cx /= g.length; cy /= g.length; cz /= g.length;
      if (it.ref) {
        const r = toGround(it.ref);
        if (n[0] * (cx - r[0]) + n[1] * (cy - r[1]) + n[2] * (cz - r[2]) < 0) n = [-n[0], -n[1], -n[2]];
      }
      if (n[0] * (camPos[0] - cx) + n[1] * (camPos[1] - cy) + n[2] * (camPos[2] - cz) <= 0) continue;
    }
    list.push({ it: it, s: s, n: n, depth: depth });
  }
  list.sort(function (a, c) { return a.it.layer - c.it.layer || c.depth - a.depth; });

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const it = e.it;
    if (it.t === 'poly') {
      const col = shadeOf(it.color, e.n, it.flat);
      pathOf(ctx, e.s);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      if (it.extras) {
        for (let k = 0; k < it.extras.length; k++) {
          const x = it.extras[k];
          const pts = (x.pts || x.line).map(function (p) { const q = toGround(p); return project(cam, q[0], q[1], q[2]); });
          if (x.line) {
            ctx.strokeStyle = x.color;
            ctx.lineWidth = Math.max(0.8, x.w * ppm * pts[0].k);
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            ctx.lineTo(pts[1].x, pts[1].y);
            ctx.stroke();
          } else {
            pathOf(ctx, pts);
            ctx.fillStyle = shadeOf(x.color, e.n, false);
            ctx.fill();
          }
        }
      }
    } else if (it.t === 'line') {
      const k = (e.s[0].k + e.s[1].k) / 2;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = Math.max(0.8, it.w * ppm * k);
      ctx.beginPath();
      ctx.moveTo(e.s[0].x, e.s[0].y);
      ctx.lineTo(e.s[1].x, e.s[1].y);
      ctx.stroke();
    } else if (it.t === 'loop') {
      ctx.strokeStyle = it.color;
      ctx.lineWidth = Math.max(0.8, it.w * ppm * e.s[0].k);
      pathOf(ctx, e.s);
      ctx.stroke();
    } else {
      const c = e.s[0];
      const r = Math.max(0.6, it.r * ppm * c.k);
      const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
      g.addColorStop(0, shadeOf(it.color, [LIGHT[0], LIGHT[1], LIGHT[2]], false));
      g.addColorStop(1, shadeOf(it.color, [0, 0, -1], false));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Paint a picker thumbnail: the model in three quarter view, or the flat icon.
 * @param {CanvasRenderingContext2D} ctx Target, drawing space w by h.
 * @param {string} mode 'car', 'moto' or 'cycle'.
 * @param {string} id A design id.
 * @param {number} w Width.
 * @param {number} h Height.
 * @returns {void}
 */
export function paintDesign(ctx, mode, id, w, h) {
  const designs = {};
  designs[mode] = id;
  const model = modelFor(mode, designs);
  if (!model) {
    drawVehicle(ctx, mode, { vehicle: { fill: '#0e7a6c', stroke: '#ffffff' } }, w / 2, h / 2, 0, h / 64);
    return;
  }
  const pitch = 62 * Math.PI / 180;
  const ppm = (w * 0.66) / (model.len * (KIND_BOOST[model.kind] || 1));
  const cam = { f: w * 6, sin: Math.sin(pitch), cos: Math.cos(pitch), sx: w / 2, sy: h * (model.kind === 'car' ? 0.66 : 0.8) };
  const a = -0.42;
  drawModel(ctx, model, cam, { gx: 0, gy: 0, hx: Math.cos(a), hy: Math.sin(a), ppm: ppm, spin: 0.4 });
}
