import * as THREE from 'three';
// js/presets.js — preset builds, made of the same parts players use (nothing special-cased).
// Coordinates: body space at the rest pose, ground at y=0, facing +Z, the mech's right side is -X.
// Right-side parts are written once and mirrored to the left (negative X scale = mirror image).

import { makePart, mirrorXform } from './blueprint.js';
import { DEFAULT_PALETTE } from './config.js';

class Builder {
  constructor(name, palette) { this.bp = { v: 1, name, style: 'tech', palette: { ...DEFAULT_PALETTE, ...palette }, parts: [], actions: [] }; this.n = 0; }
  // returns [id] or [id, mirrorId]
  add(type, parent, p, o = {}) {
    const pt = makePart(type, parent == null ? null : (Array.isArray(parent) ? parent[0] : parent), p, o.r || [0, 0, 0], o.s || [1, 1, 1]);
    for (const k of ['c', 'v', 'rd', 'lim', 'tp', 'tz', 'lf', 'bd']) if (o[k] !== undefined) pt[k] = o[k];
    pt.id = ++this.n;
    this.bp.parts.push(pt);
    if (!o.mirror) return [pt.id];
    const x = mirrorXform(pt.p, pt.r, pt.s);
    const mp = Array.isArray(parent) && parent.length > 1 ? parent[1] : pt.parent;
    const q = Object.assign(JSON.parse(JSON.stringify(pt)), { id: ++this.n, parent: mp }, x);
    pt.m = q.id; q.m = pt.id;
    this.bp.parts.push(q);
    return [pt.id, q.id];
  }
  action(a) { this.bp.actions.push(Object.assign({ next: '', window: 0.35 }, a)); }
}

// size in metres -> scale factor for a part whose base size is `base`
const sz = (w, h, d, base = [0.5, 0.5, 0.5]) => [w / base[0], h / base[1], d / base[2]];
const JS = (k) => [k, k, k];

// A humanoid frame. P: kx (width), ky (height), kb (bulk of armour), sleek (rounded shell armour).
// The joint skeleton is identical for every style, so actions and leg IK work the same; only the shells differ.
function humanoid(b, P) {
  const X = (x) => x * P.kx, Y = (y) => y * P.ky, kb = P.kb, ky = P.ky;
  const A = P.armor || 'armor', F = 'frame', S = !!P.sleek;
  const ax = X(-0.6) - 0.12 * kb;                   // arm line (right side)
  // ---- torso ----
  const core = S
    ? b.add('core', null, [0, Y(2.96), 0], { s: [0.72 / 0.8, 0.62 / 0.6 * ky, 0.52 / 0.6], rd: 0.9, tp: -0.4, c: A })[0]
    : b.add('core', null, [0, Y(2.98), 0], { s: [1.25 * kb, 1.1 * ky, 1.03 * kb], rd: 0.5, c: A })[0];
  if (S) {
    b.add('block', core, [0, Y(3.17), 0.05], { s: sz(1.2, 0.42, 0.66), rd: 1, tp: -0.24, c: A });            // broad chest, V taper
    b.add('block', core, [0, Y(2.87), 0.07], { s: sz(0.66, 0.24, 0.5), rd: 1, tp: -0.45, c: 'light' });     // lower chest plate
    b.add('round', core, [0, Y(3.06), 0.33], { r: [90, 0, 0], s: sz(0.27, 0.06, 0.27), v: 'cylinder', c: F });
    b.add('round', core, [0, Y(3.06), 0.37], { s: sz(0.15, 0.15, 0.08), c: 'glow' });                // reactor
    b.add('block', core, [0, Y(2.64), 0.02], { s: sz(0.36, 0.16, 0.3), rd: 1, tp: -0.15, c: F });        // abdomen segments, narrow waist
    b.add('block', core, [0, Y(2.5), 0.03], { s: sz(0.32, 0.14, 0.27), rd: 1, tp: -0.15, c: F });
  } else {
    b.add('block', core, [0, Y(3.02), 0.31 * kb], { s: sz(0.5 * kb, 0.34 * ky, 0.06), rd: 0.9, c: 'light' });
    b.add('block', core, [0, Y(2.6), 0.02], { s: sz(0.46 * kb, 0.24 * ky, 0.34 * kb), rd: 0.6, c: F });
  }
  b.add('round', core, [0, Y(3.42), 0], { s: sz(0.17, 0.18, 0.17), v: 'capsule', c: F });
  let head;
  if (S) {
    head = b.add('block', core, [0, Y(3.64), -0.02], { s: sz(0.27, 0.29, 0.38), rd: 1, tp: 0.32, c: A })[0];   // helmet
    b.add('block', head, [0, Y(3.54), 0.12], { s: sz(0.2, 0.15, 0.16), rd: 1, tp: -0.45, c: F });          // face mask, narrow chin
    b.add('round', head, [0, Y(3.64), 0.165], { r: [0, 0, 90], s: sz(0.05, 0.25, 0.05), v: 'capsule', c: 'glow' }); // visor slit
  } else {
    head = b.add('block', core, [0, Y(3.6), 0.02], { s: sz(0.3 * P.head, 0.3 * P.head, 0.34 * P.head), rd: 0.6, c: A })[0];
    b.add('block', head, [0, Y(3.62), 0.02 + 0.17 * P.head], { s: sz(0.24 * P.head, 0.055, 0.04), rd: 1, c: 'glow' });
    b.add('block', head, [0, Y(3.5), 0.02 + 0.14 * P.head], { s: sz(0.14 * P.head, 0.08, 0.08), rd: 0.6, c: F });
  }
  // back thrusters (sleek: bigger, splayed like folded wings)
  if (S) b.add('thruster', core, [X(-0.3), Y(3.15), -0.36], { r: [-125, 0, 22], s: JS(1.15), c: F, mirror: true });
  else b.add('thruster', core, [X(-0.24), Y(3.0), -0.36 * kb], { r: [-120, 0, 0], s: JS(1.0), c: F, mirror: true });
  // pelvis
  const pelvis = S
    ? b.add('block', core, [0, Y(2.27), 0], { s: sz(0.62, 0.3, 0.42), rd: 1, tp: -0.4, c: A })[0]
    : b.add('block', core, [0, Y(2.27), 0], { s: sz(0.62 * kb, 0.32 * ky, 0.42 * kb), rd: 0.5, c: A })[0];
  b.add('block', pelvis, [0, Y(2.08), 0.04], { s: sz(0.2 * kb, 0.2, 0.26 * kb), rd: S ? 1 : 0.6, c: F });
  if (S) b.add('block', pelvis, [0, Y(2.1), -0.25], { r: [14, 0, 0], s: sz(0.46, 0.32, 0.07), rd: 0.9, tp: -0.3, c: A });   // rear skirt
  // ---- legs ----
  const hipR = b.add('joint', pelvis, [X(-0.27), Y(2.12), 0], { r: [0, 90, 0], s: JS(1.1 * kb), lim: [-35, 35], mirror: true });
  const hipP = b.add('joint', hipR, [X(-0.27), Y(2.12), 0], { s: [1.15 * kb, 1.25 * kb, 1.25 * kb], lim: [-110, 70], mirror: true });
  if (S) {
    b.add('round', hipP, [X(-0.27), Y(1.72), 0], { s: sz(0.36, 0.8, 0.4), v: 'capsule', tp: -0.3, c: A, mirror: true });
    b.add('block', hipP, [X(-0.17), Y(1.98), 0.25], { r: [-14, 0, 0], s: sz(0.28, 0.4, 0.07), rd: 0.9, tp: -0.35, c: 'light', mirror: true }); // front skirt
    b.add('block', hipR, [X(-0.44), Y(2.04), 0], { r: [0, 0, -12], s: sz(0.07, 0.44, 0.34), rd: 0.9, tp: -0.3, c: A, mirror: true });       // side skirt
  }
  else b.add('block', hipP, [X(-0.27), Y(1.72), 0], { s: sz(0.3 * kb, 0.66 * ky, 0.34 * kb), rd: 0.5, c: A, mirror: true });
  const knee = b.add('joint', hipP, [X(-0.27), Y(1.3), 0.02], { s: JS(1.1 * kb), lim: [0, 150], mirror: true });
  if (S) {
    b.add('block', knee, [X(-0.27), Y(0.8), 0], { s: sz(0.42, 1.0, 0.5), rd: 1, tp: 0.3, c: A, mirror: true });   // shin, flares at the ankle
    b.add('round', knee, [X(-0.27), Y(1.0), -0.14], { s: sz(0.28, 0.6, 0.3), tp: 0.2, c: A, mirror: true });        // calf
    b.add('block', knee, [X(-0.27), Y(1.36), 0.17], { r: [-8, 0, 0], s: sz(0.28, 0.38, 0.18), rd: 1, tp: 0.5, c: 'light', mirror: true }); // knee guard
  } else {
    b.add('block', knee, [X(-0.27), Y(0.8), 0], { s: sz(0.34 * kb, 0.92 * ky, 0.42 * kb), rd: 0.5, c: A, mirror: true });
    b.add('round', knee, [X(-0.27), Y(1.3), 0.15 * kb], { s: sz(0.2 * kb, 0.22, 0.12), c: 'light', mirror: true });
  }
  b.add('thruster', knee, [X(-0.27), Y(0.95), -0.27 * kb - (S ? 0.04 : 0)], { r: [-117, 0, 0], s: JS(0.8), c: F, mirror: true });
  const ankle = b.add('joint', knee, [X(-0.27), 0.27, 0], { s: [1, 0.85, 0.85].map(v => v * kb), lim: [-50, 50], mirror: true });
  if (S) {
    b.add('block', ankle, [X(-0.27), 0.09, 0.05], { s: sz(0.36, 0.18, 0.7), rd: 1, tp: 0.25, c: A, mirror: true });
    b.add('block', ankle, [X(-0.27), 0.09, 0.35], { r: [90, 0, 0], s: sz(0.3, 0.26, 0.16), rd: 1, tp: 0.4, c: 'light', mirror: true }); // toe
  } else b.add('block', ankle, [X(-0.27), 0.09, 0.08], { s: sz(0.34 * kb, 0.18, 0.66 * kb), rd: 0.55, c: A, mirror: true });
  // ---- arms ----
  const sP = b.add('joint', core, [X(-0.6), Y(3.18), 0], { s: [1.1 * kb, 1.2 * kb, 1.2 * kb], lim: [-200, 80], mirror: true });
  const sR = b.add('joint', sP, [X(-0.6), Y(3.18), 0], { r: [0, 90, 0], s: JS(1.05 * kb), lim: [-110, 110], mirror: true });
  if (S) {
    b.add('block', sR, [ax - 0.1, Y(3.32), 0], { r: [0, 0, 14], s: sz(0.6, 0.5, 0.62), rd: 1, tp: -0.36, c: A, mirror: true });     // pauldron
    b.add('block', sR, [ax - 0.15, Y(3.54), 0.02], { r: [0, 0, 14], s: sz(0.46, 0.14, 0.52), rd: 1, tp: 0.25, c: 'light', mirror: true }); // layered top plate
    b.add('round', sR, [ax, Y(2.86), 0], { s: sz(0.18, 0.5, 0.2), v: 'capsule', c: F, mirror: true });
    b.add('round', sR, [ax, Y(2.56), -0.1], { s: sz(0.2, 0.22, 0.14), c: A, mirror: true });              // elbow guard
  } else {
    b.add('block', sR, [X(-0.6) - 0.14 * kb, Y(3.28), 0], { s: sz(0.4 * kb, 0.38 * kb, 0.46 * kb), rd: 0.65, c: A, mirror: true });
    b.add('block', sR, [ax, Y(2.86), 0], { s: sz(0.19 * kb, 0.5 * ky, 0.21 * kb), rd: 0.5, c: F, mirror: true });
  }
  const elbow = b.add('joint', sR, [ax, Y(2.56), 0], { s: JS(0.95 * kb), lim: [-150, 5], mirror: true });
  if (S) b.add('round', elbow, [ax, Y(2.19), 0], { s: sz(0.33, 0.66, 0.35), v: 'capsule', tp: 0.32, c: A, mirror: true });
  else b.add('block', elbow, [ax, Y(2.2), 0], { s: sz(0.25 * kb, 0.58 * ky, 0.27 * kb), rd: 0.5, c: A, mirror: true });
  const wR = b.add('joint', elbow, [ax, Y(1.86), 0], { r: [0, 0, 90], s: [0.75, 0.85, 0.85], v: 'spin', mirror: true });
  b.add('block', wR, [ax, Y(1.76), 0], { s: sz(0.15 * kb, 0.17, 0.17 * kb), rd: S ? 1 : 0.5, c: F, mirror: true });
  const wP = b.add('joint', wR, [ax, Y(1.72), 0], { s: S ? [0.8, 0.9, 0.9] : [0.65, 0.75, 0.75], lim: [-130, 130], mirror: true });
  return { core, head, pelvis, hipR, hipP, knee, ankle, sP, sR, elbow, wR, wP, handX: ax, handY: Y(1.72), forearmY: Y(2.2) };
}

// angle table helper: {rSP: deg, ...} -> {jointId: deg}
function J(H, o) {
  const out = {};
  const side = { r: 0, l: 1 };
  const NAME = { SP: 'sP', SR: 'sR', E: 'elbow', wP: 'wP', wR: 'wR' };
  for (const [k, v] of Object.entries(o)) {
    const s = side[k[0]]; const name = NAME[k.slice(1)];
    out[H[name][s]] = v;
  }
  return out;
}

/* ================= 极点 =================
   Ink-wash (水墨) mech in a sci-fi world. Shape language: 柳叶 — every armour plate is a soft-pointed leaf,
   swept back like a brush stroke, layered light-over-cyan-over-ink-black frame. Heroic proportions:
   ~9.5 heads tall, shoulders ~4 heads wide, narrow waist, legs 53% of height, heavy forearms and shins.
   One weapon: a lance ~2.3x its height. Strength target: about 110% of the other presets. */
function jidianFrame(b) {
  // Clean functional body: no fans, crests, fins, spurs or skirts. Rounded tapered volumes with one corner
  // radius family, armour shells over a dark frame, heroic proportions; the ink wash does the rest.
  const A = 'armor', F = 'frame', L = 'light';
  const S = (w, h, d) => sz(w, h, d);
  // ---- torso ----
  const core = b.add('core', null, [0, 2.98, 0], { s: [0.64 / 0.8, 0.6 / 0.6, 0.48 / 0.6], rd: 0.6, tp: -0.35, c: F })[0];
  b.add('block', core, [0, 3.16, 0.05], { s: S(1.04, 0.44, 0.6), rd: 0.55, tp: -0.28, c: A });          // upper chest shell
  b.add('block', core, [0, 2.86, 0.08], { s: S(0.64, 0.24, 0.48), rd: 0.6, tp: -0.4, c: L });           // lower chest plate
  b.add('block', core, [0, 2.63, 0.02], { s: S(0.36, 0.16, 0.3), rd: 0.6, tp: -0.15, c: F });            // waist
  b.add('block', core, [0, 2.49, 0.03], { s: S(0.32, 0.14, 0.27), rd: 0.6, tp: -0.15, c: F });
  b.add('thruster', core, [-0.22, 3.08, -0.33], { r: [-128, 0, 0], s: JS(1.05), c: F, mirror: true });
  // ---- head ----
  b.add('round', core, [0, 3.45, 0], { s: S(0.16, 0.18, 0.16), v: 'capsule', c: F });
  const head = b.add('block', core, [0, 3.66, -0.01], { s: S(0.27, 0.3, 0.35), rd: 0.6, tp: 0.25, c: A })[0];
  b.add('block', head, [0, 3.56, 0.12], { s: S(0.18, 0.14, 0.14), rd: 0.6, tp: -0.4, c: F });
  b.add('round', head, [0, 3.67, 0.16], { r: [0, 0, 90], s: S(0.045, 0.23, 0.045), v: 'capsule', c: 'glow' });
  // ---- pelvis ----
  const pelvis = b.add('block', core, [0, 2.3, 0], { s: S(0.58, 0.3, 0.42), rd: 0.55, tp: -0.42, c: A })[0];
  b.add('block', pelvis, [0, 2.1, 0.04], { s: S(0.2, 0.2, 0.26), rd: 0.6, c: F });
  // ---- legs ----
  const hipR = b.add('joint', pelvis, [-0.26, 2.12, 0], { r: [0, 90, 0], s: JS(1.1), lim: [-35, 35], mirror: true });
  const hipP = b.add('joint', hipR, [-0.26, 2.12, 0], { s: [1.15, 1.25, 1.25], lim: [-110, 70], mirror: true });
  b.add('block', hipP, [-0.26, 1.72, 0], { s: S(0.37, 0.8, 0.41), rd: 0.55, tp: -0.3, c: A, mirror: true });       // thigh
  const knee = b.add('joint', hipP, [-0.27, 1.28, 0.03], { s: JS(1.1), lim: [0, 150], mirror: true });
  b.add('round', knee, [-0.27, 1.32, 0.16], { s: S(0.26, 0.28, 0.16), c: L, mirror: true });                      // knee cap
  b.add('block', knee, [-0.27, 0.8, 0], { s: S(0.43, 1.02, 0.5), rd: 0.55, tp: 0.3, c: A, mirror: true });         // shin
  b.add('block', knee, [-0.27, 0.86, 0.2], { s: S(0.28, 0.72, 0.1), rd: 0.6, tp: 0.25, c: L, mirror: true });      // shin guard
  b.add('thruster', knee, [-0.27, 0.95, -0.3], { r: [-117, 0, 0], s: JS(0.8), c: F, mirror: true });
  const ankle = b.add('joint', knee, [-0.28, 0.26, 0], { s: [1, 0.85, 0.85], lim: [-50, 50], mirror: true });
  b.add('block', ankle, [-0.28, 0.1, 0.06], { s: S(0.37, 0.2, 0.74), rd: 0.55, tp: 0.2, c: A, mirror: true });
  // ---- arms ----
  const sP = b.add('joint', core, [-0.58, 3.2, 0], { s: [1.1, 1.2, 1.2], lim: [-200, 80], mirror: true });
  const sR = b.add('joint', sP, [-0.58, 3.2, 0], { r: [0, 90, 0], s: JS(1.05), lim: [-110, 110], mirror: true });
  b.add('block', sR, [-0.8, 3.3, 0], { r: [0, 0, 12], s: S(0.5, 0.44, 0.56), rd: 0.6, tp: -0.3, c: A, mirror: true });   // shoulder
  b.add('round', sR, [-0.74, 2.88, 0], { s: S(0.19, 0.5, 0.21), v: 'capsule', c: F, mirror: true });
  const elbow = b.add('joint', sR, [-0.74, 2.58, 0], { s: JS(0.95), lim: [-150, 5], mirror: true });
  b.add('block', elbow, [-0.74, 2.22, 0], { s: S(0.33, 0.66, 0.35), rd: 0.55, tp: 0.28, c: A, mirror: true });   // forearm
  const wR = b.add('joint', elbow, [-0.74, 1.9, 0], { r: [0, 0, 90], s: [0.75, 0.85, 0.85], v: 'spin', mirror: true });
  const hand = b.add('block', wR, [-0.74, 1.8, 0], { s: S(0.16, 0.17, 0.18), rd: 0.6, c: F, mirror: true });
  const wP = b.add('joint', wR, [-0.74, 1.76, 0], { s: [1, 1.05, 1.05], lim: [-130, 130], mirror: true });
  return { core, head, pelvis, hipR, hipP, knee, ankle, sP, sR, elbow, wR, wP, hand, handX: -0.74, handY: 1.76 };
}

export function JIDIAN() {
  const b = new Builder('极点', { armor: '#3cb4ae', frame: '#16292b', light: '#e4f3ee', glow: '#e6fffa' });
  b.bp.style = 'ink';
  const H = jidianFrame(b);
  // One great lance, 11.7 m (3x its height), held two-handed. Built along +Z through the right fist at rest:
  // 3.1 m behind the rear hand, 8.6 m ahead. The left hand grips the shaft 0.8 m in front of the right (IK).
  const g = H.wP[0], hx = H.handX, hy = H.handY;
  const pole = b.add('pole', g, [hx, hy, 1.8], { r: [90, 0, 0], s: [1, 9.6, 1], c: 'frame' })[0];
  b.add('round', g, [hx, hy, 6.66], { r: [90, 0, 0], s: sz(0.18, 0.12, 0.18), v: 'cylinder', c: 'glow' });
  b.add('round', g, [hx, hy, 6.76], { r: [90, 0, 0], s: sz(0.13, 0.1, 0.13), v: 'cylinder', c: 'frame' });
  b.add('sword', g, [hx, hy, 7.69], { r: [90, 0, 0], s: [1.4, 1.75 / 1.3, 0.3 / 0.18], c: 'light' });
  b.add('round', g, [hx, hy, -3.06], { s: sz(0.15, 0.15, 0.2), c: 'glow' });
  b.bp.parts.find(p => p.id === H.hand[1]).grip = { part: pole, at: -1.0 };   // pole-local Y: rear hand is at -1.8

  // Right-arm angles below were solved numerically for hand position + lance direction (tools/solve_poses.mjs);
  // the left arm follows the shaft by IK, so it is only keyed when the grip is released (转枪).
  // Stance 中平枪: body turned 35 deg (left shoulder forward), lance across the body pointing at the enemy.
  const POSE = {
    idle:  { rSP: 42, rSR: -32, rE: -85, rwR: 71, rwP: 31 },
    wind:  { rSP: 65, rSR: -22, rE: -81, rwR: 62, rwP: 12 },
    thrust:{ rSP: 40, rSR: -53, rE: -98, rwR: 99, rwP: 41 },
    sweep: { rSP: 61, rSR: -83, rE: -113, rwR: 128, rwP: 10 },
    // 劈: a straight vertical arc, lance at 32 deg up -> 14 deg down, both poses solved from the same seed so the
    // swing between them is a clean chop (the old raise/cut pair rolled the shoulder 145 deg and swung sideways,
    // passing over anything short like 磐岩). The blade ends just above the ground.
    raise: { rSP: 30, rSR: -67, rE: -125, rwR: 106, rwP: 17 },
    cut:   { rSP: 30, rSR: -40, rE: -89, rwR: 108, rwP: 57 },
    sweepLow: { rSP: 58, rSR: -78, rE: -110, rwR: 130, rwP: 21 },   // 横扫's stance with the lance 9 deg down
  };
  const P = (name) => J(H, POSE[name]);
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: P('idle'), yaw: -35 }] });
  // J: 刺 -> 横扫 -> 回旋
  b.action({ id: 'stab', name: '刺', key: 'KeyJ', mode: 'once', next: 'sweep', keys: [
    { t: 0, j: P('idle'), yaw: -35 },
    { t: 0.16, j: P('wind'), yaw: -40 },
    { t: 0.3, j: P('thrust'), yaw: -28, lunge: 11 },
    { t: 0.52, j: P('thrust'), yaw: -28 },
    { t: 0.72, j: P('idle'), yaw: -35 },
  ] });
  b.action({ id: 'sweep', name: '横扫', key: '', mode: 'once', next: 'whirl', keys: [
    { t: 0, j: P('sweep'), yaw: -35 },
    { t: 0.18, j: P('sweep'), yaw: -110 },
    { t: 0.46, j: P('sweep'), yaw: 45, lunge: 4 },
    { t: 0.62, j: P('sweep'), yaw: 40 },
    { t: 0.85, j: P('idle'), yaw: -35 },
  ] });
  b.action({ id: 'whirl', name: '回旋', key: '', mode: 'once', keys: [
    { t: 0, j: P('sweep'), yaw: -35 },
    { t: 0.6, j: P('sweep'), yaw: 325, lunge: 7 },
    { t: 0.72, j: P('sweep'), yaw: 325 },
    { t: 0.95, j: P('idle'), yaw: 325 },
  ] });
  // K: 劈 — raise the lance, bring it down across
  b.action({ id: 'slam', name: '劈', key: 'KeyK', mode: 'once', keys: [
    { t: 0, j: P('idle'), yaw: -35 },
    { t: 0.22, j: P('raise'), yaw: -30 },
    { t: 0.4, j: P('cut'), yaw: -30, lunge: 9 },
    { t: 0.62, j: P('cut'), yaw: -30 },
    { t: 0.85, j: P('idle'), yaw: -35 },
  ] });
  // C + J: 扫地 — squatting, the lance sweeps just above the ground (for tanks, quadrupeds, a torso on the floor)
  b.action({ id: 'sweepLow', name: '扫地', key: 'KeyJ', low: true, mode: 'once', keys: [
    { t: 0, j: P('sweepLow'), yaw: -35 },
    { t: 0.16, j: P('sweepLow'), yaw: -110 },
    { t: 0.44, j: P('sweepLow'), yaw: 45, lunge: 4 },
    { t: 0.6, j: P('sweepLow'), yaw: 40 },
    { t: 0.82, j: P('idle'), yaw: -35 },
  ] });
  // L (hold): 转枪 — let go with the left hand, right arm forward, the wrist spins the lance into a disc
  b.action({ id: 'spin', name: '转枪', key: 'KeyL', mode: 'hold', grip: false, keys: [
    { t: 0, j: J(H, { rSP: -88, rSR: 0, rE: -2, rwR: 0, rwP: 0, lSP: -40, lSR: -28, lE: -80, lwP: 0 }), yaw: 0 },
    { t: 0.22, j: J(H, { rSP: -88, rSR: 0, rE: -2, rwR: { spin: 22 }, rwP: 0, lSP: -40, lSR: -28, lE: -80, lwP: 0 }), yaw: 0 },
  ] });
  return b.bp;
}

/* ================= 玄岳 =================
   Heavy ink-black frame with cinnabar accents. Great blade, forearm cannon, gravity slingshot on the shoulder. */
export function XUANYUE() {
  const b = new Builder('玄岳', { armor: '#5d666b', frame: '#c2472e', light: '#b9c2c4', glow: '#ff7a5c', steel: '#3b4347', accent: '#e0632f' });
  const H = humanoid(b, { kx: 1.22, ky: 0.97, kb: 1.28, head: 1.15 });
  const g = H.wP[0], hx = H.handX, hy = H.handY;
  b.add('pole', g, [hx, hy, 0.15], { r: [90, 0, 0], s: [1.3, 0.9, 1.3], c: 'frame' });
  b.add('blade', g, [hx, hy, 1.85], { r: [90, 0, 0], s: [1.4, 2.6 / 1.2, 0.36 / 0.22], c: 'light' });
  // forearm cannon on the left arm, pointing down the arm (forward once the arm is raised)
  const lElbow = H.elbow[1];
  b.add('cannon', lElbow, [-hx + 0.24, H.forearmY - 0.05, 0.05], { r: [180, 0, 0], s: [1, 0.85, 1], c: 'steel' });
  // slingshot on the left shoulder, aimed forward
  b.add('sling', H.sR[1], [-hx + 0.05, 3.55, 0.05], { r: [90, 0, 0], s: JS(0.9), c: 'accent' });
  const idle = { rSP: -30, rE: -60, rwP: 50, lSP: -15, lSR: -10, lE: -50 };
  const P = (o) => J(H, Object.assign({}, idle, o));
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: P({}) }] });
  b.action({ id: 'chop', name: '劈', key: 'KeyJ', mode: 'once', next: 'cleave', ai: { kind: 'melee', range: [0, 5.2] }, keys: [
    { t: 0, j: P({}) },
    { t: 0.26, j: P({ rSP: -185, rE: -30, rwP: 40 }) },
    { t: 0.44, j: P({ rSP: -40, rE: -5, rwP: 30 }), lunge: 7 },
    { t: 0.7, j: P({ rSP: -40, rE: -5, rwP: 30 }) },
    { t: 0.9, j: P({}) },
  ] });
  b.action({ id: 'lowChop', name: '下劈', key: 'KeyJ', low: true, mode: 'once', keys: [      // C + J
    { t: 0, j: P({}) },
    { t: 0.24, j: P({ rSP: -185, rE: -30, rwP: 40 }) },
    { t: 0.42, j: P({ rSP: -20, rE: -5, rwP: 62 }), lunge: 6 },
    { t: 0.66, j: P({ rSP: -20, rE: -5, rwP: 62 }) },
    { t: 0.88, j: P({}) },
  ] });
  b.action({ id: 'cleave', name: '横斩', key: '', mode: 'once', ai: { kind: 'melee', range: [0, 5] }, keys: [
    { t: 0, j: P({ rSP: -70, rE: -20, rwP: 80 }), yaw: 0 },
    { t: 0.16, j: P({ rSP: -70, rE: -20, rwP: 80 }), yaw: -70 },
    { t: 0.4, j: P({ rSP: -70, rE: -20, rwP: 80 }), yaw: 70, lunge: 5 },
    { t: 0.75, j: P({}), yaw: 0 },
  ] });
  const cannon = b.bp.parts.find(p => p.type === 'cannon').id;
  const sling = b.bp.parts.find(p => p.type === 'sling').id;
  b.action({ id: 'fire', name: '炮击', key: 'KeyK', mode: 'once', ai: { kind: 'ranged', range: [7, 40] }, keys: [
    { t: 0, j: P({}) },
    { t: 0.3, j: P({ lSP: -92, lSR: 0, lE: 0 }) },
    { t: 0.36, j: P({ lSP: -92, lSR: 0, lE: 0 }), ev: [{ part: cannon }] },
    { t: 0.55, j: P({ lSP: -105, lSR: 0, lE: 0 }) },
    { t: 0.8, j: P({}) },
  ] });
  b.action({ id: 'pull', name: '引力·拉', key: 'KeyU', mode: 'once', ai: { kind: 'sling', range: [8, 26] }, keys: [
    { t: 0, j: P({}) }, { t: 0.18, j: P({}), ev: [{ part: sling, mode: 'pull' }] }, { t: 0.4, j: P({}) },
  ] });
  b.action({ id: 'push', name: '引力·推', key: 'KeyI', mode: 'once', ai: { kind: 'sling', range: [0, 5] }, keys: [
    { t: 0, j: P({}) }, { t: 0.15, j: P({}), ev: [{ part: sling, mode: 'push' }] }, { t: 0.35, j: P({}) },
  ] });
  return b.bp;
}

/* ================= 赤隼 =================
   Light gunner. Two hand guns, a tonfa blade along the left forearm for cutting bullets up close,
   an extra pair of wing thrusters: fast dashes, long hovers. Weak in a slugging match. */
export function CHISUN() {
  const b = new Builder('赤隼', { armor: '#e6e2da', frame: '#b8322a', light: '#f6f3ee', glow: '#ffb347', steel: '#3a3f45', accent: '#b8322a' });
  const H = humanoid(b, { kx: 0.92, ky: 1.0, kb: 0.88, head: 0.9 });
  const hx = H.handX, hy = H.handY;
  const [gR, gL] = b.add('gun', H.wP, [hx, hy, 0.55], { r: [90, 0, 0], s: [1.15, 1.2, 1.15], c: 'steel', mirror: true });
  const lBlade = b.add('blade', H.elbow[1], [-hx + 0.17, H.forearmY - 0.12, 0], { r: [180, 0, 0], s: [1, 1.05, 1], c: 'light' })[0];
  b.add('thruster', H.core, [-0.42, 3.05, -0.42], { r: [-150, 0, 35], s: JS(0.85), c: 'frame', mirror: true });   // wing pods
  const idle = { rSP: -45, rE: -40, rwP: 85, lSP: -35, lE: -55, lwP: 85 };
  const P = (o) => J(H, Object.assign({}, idle, o));
  const aim = { rSP: -90, rE: 0, rwP: 90, lSP: -90, lE: 0, lwP: 90 };
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: P({}) }] });
  b.action({ id: 'fire', name: '双枪连射（按住）', key: 'KeyJ', mode: 'hold', ai: { kind: 'ranged', range: [5, 34] }, keys: [
    { t: 0, j: P({}) },
    { t: 0.16, j: P(aim), ev: [{ part: gR }, { part: gL }] },
  ] });
  b.action({ id: 'cut', name: '肘刃', key: 'KeyK', mode: 'once', next: 'kick', ai: { kind: 'melee', range: [0, 2.6] }, keys: [
    { t: 0, j: P({}) },
    { t: 0.14, j: P({ lSP: -160, lSR: 0, lE: -120, lwP: 0 }), yaw: 20 },
    { t: 0.3, j: P({ lSP: -10, lSR: 0, lE: -110, lwP: 0 }), yaw: -30, lunge: 5 },
    { t: 0.5, j: P({}), yaw: 0 },
  ] });
  b.action({ id: 'lowCut', name: '低扫', key: 'KeyK', low: true, mode: 'once', keys: [      // C + K: tonfa sweep at the shins
    { t: 0, j: P({ lSP: -30, lSR: 0, lE: 0, lwP: 0 }), yaw: 60 },
    { t: 0.3, j: P({ lSP: -30, lSR: 0, lE: 0, lwP: 0 }), yaw: -60, lunge: 4 },
    { t: 0.5, j: P({}), yaw: 0 },
  ] });
  b.action({ id: 'kick', name: '回身斩', key: '', mode: 'once', ai: { kind: 'melee', range: [0, 2.6] }, keys: [
    { t: 0, j: P({ lSP: -90, lSR: 0, lE: -110, lwP: 0 }), yaw: 0 },
    { t: 0.36, j: P({ lSP: -90, lSR: 0, lE: -110, lwP: 0 }), yaw: 360, lunge: 4 },
    { t: 0.55, j: P({}), yaw: 360 },
  ] });
  return b.bp;
}

/* ================= 双锋 =================
   Duelist. A sword in each hand and fast light arms. J chains three cuts, K is a dash thrust,
   L (hold) spins both wrists so the swords become two discs that cut bullets. */
export function SHUANGFENG() {
  const b = new Builder('双锋', { armor: '#d8dde3', frame: '#27375a', light: '#f4f6f8', glow: '#5cc8ff', steel: '#8a96a8' });
  const H = humanoid(b, { kx: 0.96, ky: 1.03, kb: 1.0, head: 0.95, sleek: true });
  const hx = H.handX, hy = H.handY;
  b.add('round', H.wP, [hx, hy, 0.12], { r: [90, 0, 0], s: sz(0.2, 0.06, 0.2), v: 'cylinder', c: 'frame', mirror: true });    // guard
  b.add('sword', H.wP, [hx, hy, 0.9], { r: [90, 0, 0], s: [1, 1.5 / 1.3, 1], c: 'light', mirror: true });
  const idle = { rSP: -35, rE: -55, rwP: 55, lSP: -20, lE: -70, lwP: 70 };
  const P = (o) => J(H, Object.assign({}, idle, o));
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: P({}), yaw: -15 }] });
  b.action({ id: 'cutR', name: '右斩', key: 'KeyJ', mode: 'once', next: 'cutL', keys: [
    { t: 0, j: P({}), yaw: -15 },
    { t: 0.14, j: P({ rSP: -175, rE: -15, rwP: 90 }), yaw: -25 },
    { t: 0.3, j: P({ rSP: -40, rE: -5, rwP: 90 }), yaw: 10, lunge: 6 },
    { t: 0.5, j: P({}), yaw: -15 },
  ] });
  b.action({ id: 'cutL', name: '左斩', key: '', mode: 'once', next: 'twin', keys: [
    { t: 0, j: P({}), yaw: 10 },
    { t: 0.13, j: P({ lSP: -175, lE: -15, lwP: 90 }), yaw: 25 },
    { t: 0.29, j: P({ lSP: -40, lE: -5, lwP: 90 }), yaw: -10, lunge: 6 },
    { t: 0.48, j: P({}), yaw: 0 },
  ] });
  b.action({ id: 'twin', name: '双刺', key: '', mode: 'once', keys: [
    { t: 0, j: P({ rSP: -60, rE: -90, rwP: 90, lSP: -60, lE: -90, lwP: 90 }), yaw: 0 },
    { t: 0.16, j: P({ rSP: -85, rE: 0, rwP: 90, lSP: -85, lE: 0, lwP: 90 }), yaw: 0, lunge: 10 },
    { t: 0.4, j: P({ rSP: -85, rE: 0, rwP: 90, lSP: -85, lE: 0, lwP: 90 }) },
    { t: 0.6, j: P({}), yaw: -15 },
  ] });
  const low = { rSP: -25, rE: -10, rwP: 60, lSP: -25, lE: -10, lwP: 60 };
  b.action({ id: 'lowCut', name: '下斩', key: 'KeyJ', low: true, mode: 'once', keys: [      // C + J: both swords sweep low
    { t: 0, j: P(low), yaw: 0 },
    { t: 0.14, j: P(low), yaw: -70 },
    { t: 0.38, j: P(low), yaw: 70, lunge: 6 },
    { t: 0.5, j: P(low), yaw: 60 },
    { t: 0.7, j: P({}), yaw: -15 },
  ] });
  b.action({ id: 'thrust', name: '突刺', key: 'KeyK', mode: 'once', keys: [
    { t: 0, j: P({}), yaw: -15 },
    { t: 0.14, j: P({ rSP: -60, rE: -120, rwP: 90 }), yaw: -30 },
    { t: 0.26, j: P({ rSP: -90, rE: 0, rwP: 90 }), yaw: -10, lunge: 14 },
    { t: 0.5, j: P({ rSP: -90, rE: 0, rwP: 90 }), yaw: -10 },
    { t: 0.7, j: P({}), yaw: -15 },
  ] });
  b.action({ id: 'guard', name: '双刃旋（按住）', key: 'KeyL', mode: 'hold', keys: [
    { t: 0, j: P({ rSP: -80, rE: -10, rwP: 0, lSP: -80, lE: -10, lwP: 0 }), yaw: 0 },
    { t: 0.18, j: Object.assign(P({ rSP: -80, rE: -10, rwP: 0, lSP: -80, lE: -10, lwP: 0 }), J(H, { rwR: { spin: 20 }, lwR: { spin: -20 } })), yaw: 0 },
  ] });
  return b.bp;
}

/* ================= 磐岩 =================
   Wheeled tank. Four wheels, a turret with a recoiling main gun and a coaxial gun, a gravity slingshot,
   and a dozer blade across the nose: the blade's speed is the tank's speed, so ramming cuts. Can't jump. */
export function PANYAN() {
  const b = new Builder('磐岩', { armor: '#6b7358', frame: '#2b2f26', light: '#c9cdb8', glow: '#ffd25c', steel: '#3a3d36', accent: '#e0a030', ink: '#1a1c18' });
  const core = b.add('core', null, [0, 1.05, 0], { s: sz(2.0, 0.66, 2.7, [0.8, 0.6, 0.6]), rd: 0.35, c: 'armor' })[0];
  b.add('block', core, [0, 1.42, -0.2], { s: sz(1.7, 0.12, 2.0), rd: 0.6, c: 'frame' });                      // deck
  b.add('block', core, [0, 0.95, 1.42], { r: [-30, 0, 0], s: sz(1.8, 0.5, 0.3), rd: 0.5, c: 'armor' });        // glacis
  b.add('wheel', core, [-1.22, 0.47, 0.9], { r: [0, 0, 90], s: [1.17, 1.4, 1.17], c: 'ink', mirror: true });
  b.add('wheel', core, [-1.22, 0.47, -0.9], { r: [0, 0, 90], s: [1.17, 1.4, 1.17], c: 'ink', mirror: true });
  b.add('block', core, [-1.22, 1.02, 0], { s: sz(0.42, 0.14, 2.9), rd: 0.7, c: 'armor', mirror: true });      // fenders
  b.add('block', core, [0, 0.86, 1.62], { s: sz(1.1, 0.24, 0.4), rd: 0.6, c: 'frame' });                      // blade mount
  b.add('blade', core, [0, 0.86, 1.86], { r: [90, 0, 90], s: [1.6, 2.3 / 1.2, 0.6 / 0.22], c: 'light' });      // dozer blade, upright
  b.add('thruster', core, [-0.55, 1.15, -1.45], { r: [-90, 0, 0], s: JS(1.2), c: 'frame', mirror: true });
  // turret
  const tur = b.add('block', core, [0, 1.78, -0.15], { s: sz(1.3, 0.56, 1.5), rd: 0.6, tp: -0.15, c: 'armor' })[0];
  b.add('block', tur, [0, 1.84, 0.62], { s: sz(0.9, 0.36, 0.3), rd: 0.6, c: 'frame' });                        // mantlet
  b.add('block', tur, [0.3, 2.1, -0.2], { s: sz(0.34, 0.12, 0.34), rd: 0.6, c: 'glow' });                      // sensor
  const elev = b.add('joint', tur, [0, 1.84, 0.8], { s: JS(1.3), lim: [-20, 15] })[0];
  const cannon = b.add('cannon', elev, [0, 1.84, 1.75], { r: [90, 0, 0], s: [1.05, 1.55, 1.05], c: 'steel' })[0];
  const gun = b.add('gun', tur, [-0.52, 1.72, 0.85], { r: [90, 0, 0], s: [0.9, 0.9, 0.9], c: 'steel' })[0];
  const sling = b.add('sling', tur, [0.5, 2.18, 0.15], { r: [90, 0, 0], s: JS(0.85), c: 'accent' })[0];
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: { [elev]: 0 } }] });
  b.action({ id: 'fire', name: '主炮', key: 'KeyJ', mode: 'once', ai: { kind: 'ranged', range: [6, 45] }, keys: [
    { t: 0, j: { [elev]: 0 } },
    { t: 0.22, j: { [elev]: 0 }, ev: [{ part: cannon }] },
    { t: 0.3, j: { [elev]: -12 } },
    { t: 0.75, j: { [elev]: 0 } },
  ] });
  b.action({ id: 'mg', name: '同轴机枪（按住）', key: 'KeyK', mode: 'hold', ai: { kind: 'ranged', range: [3, 30] }, keys: [
    { t: 0, j: { [elev]: 0 } }, { t: 0.1, j: { [elev]: 0 }, ev: [{ part: gun }] },
  ] });
  b.action({ id: 'ram', name: '冲撞', key: 'KeyL', mode: 'once', ai: { kind: 'melee', range: [0, 4] }, keys: [
    { t: 0, j: { [elev]: 0 } }, { t: 0.12, j: { [elev]: 0 }, lunge: 17 }, { t: 0.8, j: { [elev]: 0 } },
  ] });
  b.action({ id: 'pull', name: '引力·拉', key: 'KeyU', mode: 'once', ai: { kind: 'sling', range: [8, 26] }, keys: [
    { t: 0, j: {} }, { t: 0.18, j: {}, ev: [{ part: sling, mode: 'pull' }] }, { t: 0.4, j: {} },
  ] });
  b.action({ id: 'push', name: '引力·推', key: 'KeyI', mode: 'once', ai: { kind: 'sling', range: [0, 5] }, keys: [
    { t: 0, j: {} }, { t: 0.15, j: {}, ev: [{ part: sling, mode: 'push' }] }, { t: 0.35, j: {} },
  ] });
  return b.bp;
}

/* ================= 蛛刃 =================
   Quadruped with two mantis scythes. Four legs (yaw, lift, knee, ankle each) make it stable and quick
   to turn; the scythes hang folded and snap down. K spins the whole body with the scythes out. */
export function ZHUREN() {
  const b = new Builder('蛛刃', { armor: '#3d4a52', frame: '#1c2226', light: '#b7c3c8', glow: '#c6ff4a', steel: '#59646b' });
  const core = b.add('core', null, [0, 1.95, 0], { s: sz(1.3, 0.55, 1.7, [0.8, 0.6, 0.6]), rd: 0.6, c: 'armor' })[0];
  b.add('block', core, [0, 2.28, -0.1], { s: sz(1.0, 0.22, 1.3), rd: 0.8, tp: -0.2, c: 'light' });            // back plate
  b.add('block', core, [0, 1.72, 0], { s: sz(0.9, 0.18, 1.2), rd: 0.8, c: 'frame' });                          // belly
  const head = b.add('block', core, [0, 2.1, 1.0], { s: sz(0.62, 0.34, 0.45), rd: 0.8, tp: -0.2, c: 'armor' })[0];
  b.add('block', head, [0, 2.13, 1.22], { s: sz(0.44, 0.07, 0.04), rd: 1, c: 'glow' });                        // eye bar
  b.add('thruster', core, [-0.32, 2.15, -0.95], { r: [-120, 0, 0], s: JS(1.0), c: 'frame', mirror: true });
  const legs = {};
  for (const [tag, z] of [['f', 0.6], ['b', -0.6]]) {
    const yaw = b.add('joint', core, [-0.62, 1.95, z], { r: [0, 0, 90], s: JS(1.2), lim: [-40, 40], mirror: true });
    const lift = b.add('joint', yaw, [-0.82, 1.95, z], { r: [0, 90, 0], s: JS(1.25), lim: [-60, 60], mirror: true });
    b.add('block', lift, [-1.26, 2.24, z], { r: [0, 0, -34], s: sz(1.0, 0.24, 0.28), rd: 0.7, c: 'armor', mirror: true });  // thigh
    const knee = b.add('joint', lift, [-1.7, 2.52, z], { r: [0, 90, 0], s: JS(1.15), lim: [-80, 80], mirror: true });
    b.add('block', knee, [-1.88, 1.41, z], { r: [0, 0, -9], s: sz(0.22, 2.2, 0.26), rd: 0.7, tp: -0.35, c: 'light', mirror: true }); // shin
    const ank = b.add('joint', knee, [-2.05, 0.3, z], { r: [0, 90, 0], s: JS(0.7), lim: [-50, 50], mirror: true });
    b.add('round', ank, [-2.05, 0.12, z], { s: sz(0.3, 0.24, 0.34), c: 'frame', mirror: true });               // foot
    legs[tag] = { yaw, lift, knee, ank };
  }
  // scythes: shoulder + elbow, built straight forward; the stance folds them
  const sh = b.add('joint', core, [-0.42, 2.25, 0.95], { s: JS(1.25), lim: [-120, 60], mirror: true });
  b.add('block', sh, [-0.42, 2.25, 1.65], { s: sz(0.2, 0.22, 1.3), rd: 0.8, c: 'armor', mirror: true });      // upper arm
  const el = b.add('joint', sh, [-0.42, 2.25, 2.35], { s: JS(1.0), lim: [-10, 160], mirror: true });
  b.add('blade', el, [-0.42, 2.25, 3.35], { r: [90, 0, 0], s: [1.1, 1.6, 1.1], c: 'light', mirror: true });
  const A = (rs, re, ls, le) => ({ [sh[0]]: rs, [el[0]]: re, [sh[1]]: ls, [el[1]]: le });
  const idle = A(-55, 125, -55, 125);
  b.action({ id: 'idle', name: '待机', key: '', mode: 'idle', keys: [{ t: 0, j: idle }] });
  b.action({ id: 'reapR', name: '右镰', key: 'KeyJ', mode: 'once', next: 'reapL', keys: [
    { t: 0, j: idle },
    { t: 0.14, j: A(-100, 150, -55, 125) },
    { t: 0.28, j: A(25, 40, -55, 125), lunge: 7 },
    { t: 0.48, j: idle },
  ] });
  b.action({ id: 'reapL', name: '左镰', key: '', mode: 'once', next: 'scissor', keys: [
    { t: 0, j: idle },
    { t: 0.13, j: A(-55, 125, -100, 150) },
    { t: 0.27, j: A(-55, 125, 25, 40), lunge: 7 },
    { t: 0.46, j: idle },
  ] });
  b.action({ id: 'scissor', name: '剪', key: '', mode: 'once', keys: [
    { t: 0, j: A(-100, 150, -100, 150) },
    { t: 0.18, j: A(-100, 150, -100, 150) },
    { t: 0.32, j: A(20, 30, 20, 30), lunge: 9 },
    { t: 0.6, j: idle },
  ] });
  b.action({ id: 'whirl', name: '旋镰', key: 'KeyK', mode: 'once', keys: [
    { t: 0, j: idle, yaw: 0 },
    { t: 0.14, j: A(-10, 5, -10, 5), yaw: -30 },
    { t: 0.6, j: A(-10, 5, -10, 5), yaw: 330, lunge: 5 },
    { t: 0.8, j: idle, yaw: 360 },
  ] });
  return b.bp;
}

export const PRESETS = { jidian: JIDIAN, xuanyue: XUANYUE, chisun: CHISUN, shuangfeng: SHUANGFENG, panyan: PANYAN, zhuren: ZHUREN };
