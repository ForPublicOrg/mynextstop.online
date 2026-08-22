/**
 * vehicles.js
 * Single path silhouettes for the leg modes, shared between the canvas
 * renderer and the inline SVG icons in the UI.
 *
 * Every path is authored in a 24 x 24 box with the nose pointing right, along
 * positive x, so rotating by the path tangent angle is all the orientation the
 * renderer needs. The one exception is the walker, which is drawn upright and
 * only mirrored to face the way it is going: a person tilted to the road
 * gradient reads as falling over, a car does not.
 */

/** The viewBox every MODE_META path is authored against. */
export const MODE_VIEWBOX = '0 0 24 24';

/**
 * Round to two decimals and drop the trailing zeros, for compact path strings.
 * @param {number} v Value.
 * @returns {string} Formatted number.
 */
function n2(v) {
  return String(Math.round(v * 100) / 100);
}

/**
 * A full circle subpath. Clockwise on screen adds to the winding count,
 * counter clockwise subtracts, which is how the wheel holes are punched.
 * @param {number} cx Centre x.
 * @param {number} cy Centre y.
 * @param {number} r Radius.
 * @param {boolean} clockwise True for a solid ring, false for a hole.
 * @returns {string} Path data for one closed circle.
 */
function circleSub(cx, cy, r, clockwise) {
  const s = clockwise ? 1 : 0;
  return 'M' + n2(cx - r) + ' ' + n2(cy) +
    'A' + n2(r) + ' ' + n2(r) + ' 0 1 ' + s + ' ' + n2(cx + r) + ' ' + n2(cy) +
    'A' + n2(r) + ' ' + n2(r) + ' 0 1 ' + s + ' ' + n2(cx - r) + ' ' + n2(cy) + 'Z';
}

/**
 * A ring: solid outer circle with a concentric hole.
 * @param {number} cx Centre x.
 * @param {number} cy Centre y.
 * @param {number} rOuter Outer radius.
 * @param {number} rInner Inner radius.
 * @returns {string} Path data.
 */
function ringSub(cx, cy, rOuter, rInner) {
  return circleSub(cx, cy, rOuter, true) + circleSub(cx, cy, rInner, false);
}

/**
 * A filled disc.
 * @param {number} cx Centre x.
 * @param {number} cy Centre y.
 * @param {number} r Radius.
 * @returns {string} Path data.
 */
function discSub(cx, cy, r) {
  return circleSub(cx, cy, r, true);
}

/**
 * A rounded rectangle subpath. Clockwise on screen adds to the winding count,
 * counter clockwise subtracts, which is how a window band is punched out.
 * @param {number} x Left edge.
 * @param {number} y Top edge.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 * @param {boolean} [clockwise] False to punch a hole. Defaults to true.
 * @returns {string} Path data.
 */
function roundRectSub(x, y, w, h, r, clockwise) {
  if (clockwise === false) {
    return 'M' + n2(x + r) + ' ' + n2(y) +
      'Q' + n2(x) + ' ' + n2(y) + ' ' + n2(x) + ' ' + n2(y + r) +
      'L' + n2(x) + ' ' + n2(y + h - r) +
      'Q' + n2(x) + ' ' + n2(y + h) + ' ' + n2(x + r) + ' ' + n2(y + h) +
      'L' + n2(x + w - r) + ' ' + n2(y + h) +
      'Q' + n2(x + w) + ' ' + n2(y + h) + ' ' + n2(x + w) + ' ' + n2(y + h - r) +
      'L' + n2(x + w) + ' ' + n2(y + r) +
      'Q' + n2(x + w) + ' ' + n2(y) + ' ' + n2(x + w - r) + ' ' + n2(y) + 'Z';
  }
  return 'M' + n2(x + r) + ' ' + n2(y) +
    'L' + n2(x + w - r) + ' ' + n2(y) +
    'Q' + n2(x + w) + ' ' + n2(y) + ' ' + n2(x + w) + ' ' + n2(y + r) +
    'L' + n2(x + w) + ' ' + n2(y + h - r) +
    'Q' + n2(x + w) + ' ' + n2(y + h) + ' ' + n2(x + w - r) + ' ' + n2(y + h) +
    'L' + n2(x + r) + ' ' + n2(y + h) +
    'Q' + n2(x) + ' ' + n2(y + h) + ' ' + n2(x) + ' ' + n2(y + h - r) +
    'L' + n2(x) + ' ' + n2(y + r) +
    'Q' + n2(x) + ' ' + n2(y) + ' ' + n2(x + r) + ' ' + n2(y) + 'Z';
}

/**
 * A straight bar between two points, as a clockwise quad so it never cancels
 * the winding of a ring it overlaps.
 * @param {number} x1 Start x.
 * @param {number} y1 Start y.
 * @param {number} x2 End x.
 * @param {number} y2 End y.
 * @param {number} half Half thickness.
 * @returns {string} Path data.
 */
function barSub(x1, y1, x2, y2, half) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return 'M' + n2(x1 - nx) + ' ' + n2(y1 - ny) +
    'L' + n2(x2 - nx) + ' ' + n2(y2 - ny) +
    'L' + n2(x2 + nx) + ' ' + n2(y2 + ny) +
    'L' + n2(x1 + nx) + ' ' + n2(y1 + ny) + 'Z';
}

/** Swept wing jet, seen from above, nose right. */
const PLANE_D = 'M23 12L17.2 14.2L14.6 14.2L11.4 20.6L8.6 20.6L10.1 14.2L5.4 14.2' +
  'L3.4 16.9L1.4 16.9L2.6 12L1.4 7.1L3.4 7.1L5.4 9.8L10.1 9.8L8.6 3.4L11.4 3.4' +
  'L14.6 9.8L17.2 9.8Z';

/**
 * Hatchback in side profile, bonnet to the right, on two round wheels. The
 * wheels are separate discs that hang below the body so they survive the halo
 * stroke at icon size, where a shallow wheel arch would fill in.
 */
const CAR_D = 'M2 16.4L2 12.6Q2 11.5 3.1 11.2L7 10.3L9.8 7.9Q10.4 7.4 11.2 7.4' +
  'L15.2 7.4Q16.2 7.4 16.8 8.1L19 10.9L20.9 11.5Q22.2 11.9 22.2 13.2L22.2 15.4' +
  'Q22.2 16.4 21.2 16.4Z' +
  discSub(6.6, 16.6, 2.7) + discSub(17.2, 16.6, 2.7);

/**
 * Bullet train in side profile, nose right.
 *
 * Four cues carry the read at 30 px: a long low body on a flat roofline, a rake
 * confined to the front third so the nose never reads as a delivery van bonnet,
 * a window band punched through the flank, and two rail wheels hanging below the
 * underframe. The roof runs level from x=1.5 to x=15, then one cubic drops it to
 * the tip at (22.5, 14.5) with a horizontal tangent leaving the roof and a
 * vertical one arriving at the nose face, which then falls to the underframe at
 * y=17. The window band is wound counter clockwise, so the halo stroke fills it
 * with the contrast colour and it reads as glass rather than as a gap. The
 * wheels are solid discs: hubs closed up at icon size.
 */
const TRAIN_D = 'M2.5 8L15 8C15.7 8 22.5 12.5 22.5 14.5L22.5 16' +
  'Q22.5 17 21.5 17L2.5 17Q1.5 17 1.5 16L1.5 9Q1.5 8 2.5 8Z' +
  roundRectSub(3.5, 10, 10, 2.5, 1.2, false) +
  discSub(6.5, 18.2, 1.8) +
  discSub(16.5, 18.2, 1.8);

/** Hull with an aft cabin and a long fore deck, bow right. */
const BOAT_D = 'M1.6 12.9L6 12.9L6 8.8Q6 8 6.8 8L12.6 8Q13.4 8 13.7 8.7L15.3 12.9' +
  'L22.2 12.9Q23 12.9 22.5 13.9L20.8 18Q20.2 19.3 18.8 19.3L5.6 19.3' +
  'Q4.2 19.3 3.6 18.2L1.4 13.9Q0.9 12.9 1.6 12.9Z';

/**
 * Bicycle: two wheel rings with tube and stay quads between them. Built from
 * primitives so the geometry stays exact, then frozen into one path string.
 */
const CYCLE_D = (function buildCycle() {
  const rearX = 5.7;
  const frontX = 18.3;
  const hubY = 16;
  const rOuter = 5.5;
  const rInner = 3.7;
  const crankX = 12;
  const crankY = 16;
  const seatX = 10;
  const seatY = 9.2;
  const headX = 16.9;
  const headY = 9;
  const tube = 0.9;
  const stay = 0.75;

  return [
    ringSub(rearX, hubY, rOuter, rInner),
    ringSub(frontX, hubY, rOuter, rInner),
    barSub(crankX, crankY, headX, headY, tube),
    barSub(crankX, crankY, seatX, seatY, tube),
    barSub(seatX, seatY, headX, headY, tube),
    barSub(crankX, crankY, rearX, hubY, stay),
    barSub(seatX, seatY, rearX, hubY, stay),
    barSub(headX, headY, frontX, hubY, tube),
    barSub(8.1, 8.4, 11.6, 8.4, 0.85),
    barSub(15.3, 7.4, 18.7, 7.4, 0.8),
    discSub(crankX, crankY, 1.6)
  ].join('');
}());

/**
 * Motorbike in side profile, front wheel right.
 *
 * What separates it from the bicycle at icon size: solid wheels instead of
 * rings, one chunky body (seat, tank bulge, engine block) instead of a thin
 * tube frame, a raked fork reaching forward to the front wheel, and a
 * handlebar that kicks up past the tank.
 */
const MOTO_D = (function buildMoto() {
  const rearX = 5.2;
  const frontX = 18.8;
  const hubY = 16.8;
  const wheel = 3.2;
  return [
    discSub(rearX, hubY, wheel),
    discSub(frontX, hubY, wheel),
    // Engine block between the wheels, tank over it, seat slab running back
    // over the rear wheel as the fender.
    roundRectSub(8, 11.2, 7.4, 4.4, 1.2),
    roundRectSub(9.6, 7.4, 6.2, 4.6, 2),
    barSub(2.6, 9.9, 10.4, 9.9, 1.05),
    // Swingarm to the rear hub, fork down to the front hub, handlebar and
    // headlamp at the headstock.
    barSub(rearX, hubY, 9.6, 14.2, 0.95),
    barSub(16.2, 9.2, frontX, hubY, 1.15),
    barSub(15.6, 9.4, 18.6, 7.4, 0.8),
    discSub(17.3, 9.8, 1.45)
  ].join('');
}());

/**
 * Coach in side profile, front right: a long box on two wheels with a row of
 * punched windows and a taller windscreen. The flat vertical front is what
 * keeps it from reading as the train, whose nose rakes.
 */
const BUS_D = (function buildBus() {
  return [
    roundRectSub(1.6, 6.4, 20.8, 10.6, 1.8),
    roundRectSub(3, 8.2, 4.4, 3.6, 0.7, false),
    roundRectSub(8.4, 8.2, 4.4, 3.6, 0.7, false),
    roundRectSub(13.8, 8.2, 4.4, 3.6, 0.7, false),
    roundRectSub(19.2, 8, 2.2, 5, 0.6, false),
    discSub(6, 17.4, 2.3),
    discSub(18, 17.4, 2.3)
  ].join('');
}());

/**
 * Hiker mid stride, facing right: head, torso with a pack on the back, the
 * front arm swinging forward, both legs in the air of a step. Drawn upright
 * (see `upright` on its MODE_META entry) and sized smaller than the vehicles so
 * its height matches theirs on screen.
 */
const WALK_D = (function buildWalk() {
  const hipX = 11.6;
  const hipY = 13;
  return [
    discSub(13.2, 4.4, 2),
    barSub(12.8, 6.8, hipX, hipY, 1.5),
    roundRectSub(8.6, 7.4, 3.2, 5.6, 1.2),
    barSub(12.6, 8.2, 15.8, 11.4, 0.95),
    barSub(hipX, hipY, 14.8, 16, 1.1),
    barSub(14.8, 16, 15.6, 20.6, 1),
    barSub(15.2, 20.6, 17.2, 20.6, 0.8),
    barSub(hipX, hipY, 8.8, 16.4, 1.1),
    barSub(8.8, 16.4, 7.2, 20.4, 1),
    barSub(7.6, 20.4, 5.8, 20.4, 0.8)
  ].join('');
}());

/**
 * The leg modes, in picker order. `d` is the shared silhouette path. A mode
 * with `upright` is never rotated to the path tangent, only mirrored to face
 * the direction of travel.
 * @type {Array<{id: string, label: string, d: string, upright?: boolean}>}
 */
export const MODE_META = [
  { id: 'plane', label: 'Flight', d: PLANE_D },
  { id: 'car', label: 'Car', d: CAR_D },
  { id: 'moto', label: 'Bike', d: MOTO_D },
  { id: 'cycle', label: 'Cycle', d: CYCLE_D },
  { id: 'bus', label: 'Bus', d: BUS_D },
  { id: 'train', label: 'Train', d: TRAIN_D },
  { id: 'boat', label: 'Boat', d: BOAT_D },
  { id: 'walk', label: 'Walk', d: WALK_D, upright: true }
];

/**
 * Ids that older drafts and links may still carry, mapped to the mode that
 * replaced them. 'bike' used to be the bicycle; it is 'cycle' now, because
 * 'bike' is the motorbike to most of the people this page is for.
 * @type {Object<string, string>}
 */
const LEGACY_MODES = { bike: 'cycle' };

/**
 * The current id for a mode, or null when the id is not a mode at all.
 * @param {*} id A mode id, possibly from an old draft.
 * @returns {string|null} A MODE_META id, or null.
 */
export function normalizeMode(id) {
  if (typeof id !== 'string') return null;
  const mapped = Object.prototype.hasOwnProperty.call(LEGACY_MODES, id) ? LEGACY_MODES[id] : id;
  return MODE_META.some(function (m) { return m.id === mapped; }) ? mapped : null;
}

/** Drawn height in pixels at unit scale, per mode. */
const BASE_SIZE = { plane: 64, car: 52, moto: 52, cycle: 52, bus: 54, train: 52, boat: 52, walk: 40 };

const PATH_CACHE = new Map();

/**
 * Path2D for a mode, built once and reused.
 * @param {string} mode Mode id.
 * @returns {Path2D|null} Cached path, or null for an unknown mode.
 */
function pathFor(mode) {
  if (PATH_CACHE.has(mode)) return PATH_CACHE.get(mode);
  const meta = metaFor(mode);
  const p = meta ? new Path2D(meta.d) : null;
  PATH_CACHE.set(mode, p);
  return p;
}

/**
 * The MODE_META entry for a mode id, legacy ids included.
 * @param {string} mode Mode id.
 * @returns {{id: string, label: string, d: string, upright?: boolean}|null} The entry, or null.
 */
function metaFor(mode) {
  const id = normalizeMode(mode);
  if (!id) return null;
  return MODE_META.find(function (m) { return m.id === id; }) || null;
}

/**
 * Draw a vehicle silhouette centred on a point and turned to face along the
 * route.
 *
 * A halo is stroked first so the shape stays readable over busy imagery, then
 * the body is filled over it. Ground vehicles flip vertically when the heading
 * points left, so a car never travels wheels up. The plane is symmetric from
 * above and never flips. An upright mode (the walker) is not rotated at all,
 * only mirrored to face the way it is heading.
 *
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {string} mode A MODE_META id.
 * @param {object} theme A member of THEMES, read for `vehicle.fill` and `vehicle.stroke`.
 * @param {number} x Centre x in drawing space.
 * @param {number} y Centre y in drawing space.
 * @param {number} angle Heading in radians, 0 pointing right.
 * @param {number} scale Multiplier on the mode's base drawn size. Pass the
 *   renderer unit scale `u`, times any per frame emphasis.
 * @param {boolean} [faceLeft] Which way the vehicle faces, when the caller
 *   knows better than the instantaneous heading: a heading hovering around
 *   straight up would otherwise mirror the vehicle on every wobble.
 * @returns {void}
 */
export function drawVehicle(ctx, mode, theme, x, y, angle, scale, faceLeft) {
  const meta = metaFor(mode);
  const path = meta ? pathFor(meta.id) : null;
  if (!meta || !path) return;

  const base = BASE_SIZE[meta.id] || 52;
  const k = (base / 24) * scale;
  if (!(k > 0)) return;

  let a = Number.isFinite(angle) ? angle : 0;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  const facingLeft = typeof faceLeft === 'boolean' ? faceLeft : Math.abs(a) > Math.PI / 2;

  ctx.save();
  ctx.translate(x, y);
  if (meta.upright) {
    if (facingLeft) ctx.scale(-1, 1);
  } else {
    ctx.rotate(a);
    if (meta.id !== 'plane' && facingLeft) ctx.scale(1, -1);
  }
  ctx.scale(k, k);
  ctx.translate(-12, -12);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.vehicle.stroke;
  ctx.stroke(path);
  ctx.fillStyle = theme.vehicle.fill;
  ctx.fill(path);

  ctx.restore();
}
