// js/parts.js — part catalog, rest-pose transforms, and stats derived from the build.
// No rendering here (three.js math only), so it runs headless in node.
//
// Two layers of constraint (same reasoning as Skybreak's README):
//   1. Load budget: the core gives a total, every part spends some (scaled by its size).
//   2. Shape decides the numbers: mass and inertia come from what you placed and where.
//      Heavy things far from a joint make that joint slow; heavy bodies make legs slow; long legs stride further.
//
// Part record in a blueprint:
//   { id, type, parent, p:[x,y,z], r:[rx,ry,rz] (deg, XYZ), s:[sx,sy,sz], c:'armor', v:'variant', rd:0..1, lim:[min,max] }
//   p/r/s are in BODY space at the rest pose (all joints at 0). A negative s[0] means the part is a mirror image.
//   Origin of every part is its geometric centre; local +Y is its "outward" axis (blades, barrels, nozzles point +Y).

import * as THREE from 'three';
import { CFG } from './config.js';

export const PARTS = {
  core: {
    name: '核心', desc: '驾驶舱与动力核心。决定负载上限。每台机甲恰好一个。',
    size: [0.8, 0.6, 0.6], shape: 'box', rd: 0.35, load: 0, mass: 30, hp: 150, budget: CFG.build.budgetDefault,
    color: 'armor',
  },
  block: {
    name: '方块', desc: '基础结构。可改圆角。',
    size: [0.5, 0.5, 0.5], shape: 'box', rd: 0.25, load: 2, mass: 6, hp: 24, color: 'armor',
  },
  wedge: {
    name: '三角', desc: '斜面块，体积是方块的一半。',
    size: [0.5, 0.5, 0.5], shape: 'wedge', load: 1, mass: 3, hp: 12, color: 'armor',
  },
  round: {
    name: '圆块', desc: '球 / 圆柱 / 胶囊。拉伸成椭球做曲面装甲。',
    size: [0.5, 0.5, 0.5], shape: 'round', variants: ['sphere', 'cylinder', 'capsule'], load: 1.4, mass: 3.4, hp: 16,
    color: 'armor',
  },
  pole: {
    name: '枪杆', desc: '轻而长的杆。挥动时是钝器，转起来能挡子弹。沿 Y 拉长。',
    size: [0.1, 1.0, 0.1], shape: 'pole', load: 1.5, mass: 2.2, hp: 14, color: 'frame',
    weapon: { kind: 'blunt', dmg: 6, seg: [-0.5, 0.5], width: 0.05 },
  },
  blade: {
    name: '刀', desc: '单刃弯刀。挥砍伤害随刃速增长，能劈开子弹。',
    size: [0.05, 1.2, 0.22], shape: 'blade', load: 6, mass: 4.5, hp: 30, color: 'light',
    weapon: { kind: 'edge', dmg: 14, seg: [-0.5, 0.6], width: 0.1 },
  },
  sword: {
    name: '剑', desc: '双刃直剑，尖端可刺。',
    size: [0.05, 1.3, 0.18], shape: 'sword', load: 7, mass: 4, hp: 30, color: 'light',
    weapon: { kind: 'edge', dmg: 16, seg: [-0.6, 0.65], width: 0.09 },
  },
  gun: {
    name: '火枪', desc: '速射。子弹看得见、能被劈掉，连射会过热。枪口朝 +Y。',
    size: [0.18, 0.9, 0.2], shape: 'gun', load: 14, mass: 7, hp: 20, color: 'steel',
    weapon: { kind: 'gun', dmg: 5, rate: 8, muzzle: 0.45 },
  },
  cannon: {
    name: '炮', desc: '慢、重、溅射，有后坐力。只有刀剑能劈开炮弹。',
    size: [0.3, 1.3, 0.3], shape: 'cannon', load: 26, mass: 18, hp: 40, color: 'steel',
    weapon: { kind: 'cannon', dmg: 26, rate: 0.7, muzzle: 0.65 },
  },
  sling: {
    name: '引力弹弓', desc: '发射引力球：拉模式把对手拽到身前，推模式把对手甩开。动作帧里选模式。',
    size: [0.36, 0.5, 0.36], shape: 'sling', load: 18, mass: 8, hp: 25, color: 'accent',
    weapon: { kind: 'sling', cd: 3.5, muzzle: 0.25 },
  },
  thruster: {
    name: '推进器', desc: '冲刺、跳跃悬停。喷口朝 +Y。推重比决定冲刺速度。',
    size: [0.28, 0.4, 0.28], shape: 'thruster', load: 8, mass: 5, hp: 16, color: 'frame', thrust: 260,
  },
  joint: {
    name: '关节', desc: '铰链，绕本地 X 轴转。挂在它上面的零件会跟着动。spin 型可无限旋转。',
    size: [0.28, 0.24, 0.24], shape: 'joint', variants: ['hinge', 'spin'], load: 3, mass: 4, hp: 30, color: 'frame',
    joint: true,
  },
  wheel: {
    name: '轮子', desc: '地面高速，转向慢，不能跳。轴沿本地 Y。',
    size: [0.8, 0.22, 0.8], shape: 'wheel', load: 5, mass: 8, hp: 30, color: 'ink', wheel: true,
  },
};

export const PLACEABLE = ['block', 'wedge', 'round', 'pole', 'blade', 'sword', 'gun', 'cannon', 'sling', 'thruster', 'joint', 'wheel'];

// ---------- size scaling ----------
export const volRatio = (s) => Math.max(0.02, Math.abs(s[0] * s[1] * s[2]));
export function partLoad(pt) { return PARTS[pt.type].load * volRatio(pt.s); }
export function partMass(pt) {
  const P = PARTS[pt.type];
  let m = P.mass * volRatio(pt.s);
  if (pt.type === 'round' && pt.v === 'sphere') m *= 0.52;        // sphere fills ~52% of its box
  if (pt.type === 'round' && pt.v === 'cylinder') m *= 0.79;
  return m;
}
// thin plates get a floor so a single graze doesn't strip them (still cheap enough that spamming them costs load)
export function partHP(pt) {
  const hp = PARTS[pt.type].hp * Math.pow(Math.max(0.2, volRatio(pt.s)), 2 / 3);
  return pt.type === 'joint' ? Math.max(CFG.joint.minHp, hp) : hp;
}
export function jointTorque(pt) { return CFG.joint.torque * volRatio(pt.s); }
export function thrusterThrust(pt) { return PARTS.thruster.thrust * Math.pow(volRatio(pt.s), 2 / 3); }

// ---------- rest transforms ----------
const DEG = Math.PI / 180;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

// Node matrix (no scale; a mirror image is a reflection in local X)
export function restMatrix(pt, out = new THREE.Matrix4()) {
  _e.set(pt.r[0] * DEG, pt.r[1] * DEG, pt.r[2] * DEG, 'XYZ');
  _q.setFromEuler(_e);
  out.compose(new THREE.Vector3(pt.p[0], pt.p[1], pt.p[2]), _q, new THREE.Vector3(Math.sign(pt.s[0]) || 1, 1, 1));
  return out;
}

// Half extents of a part's box in its node frame (scale applied)
export function halfExtents(pt) {
  const z = PARTS[pt.type].size;
  return [Math.abs(z[0] * pt.s[0]) / 2, Math.abs(z[1] * pt.s[1]) / 2, Math.abs(z[2] * pt.s[2]) / 2];
}

export function byId(bp) { const m = new Map(); for (const p of bp.parts) m.set(p.id, p); return m; }

export function children(bp) {
  const m = new Map();
  for (const p of bp.parts) {
    if (p.parent == null) continue;
    if (!m.has(p.parent)) m.set(p.parent, []);
    m.get(p.parent).push(p);
  }
  return m;
}

// Rest-pose world AABB of one part
export function restAABB(pt) {
  const M = restMatrix(pt);
  const h = halfExtents(pt);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]).applyMatrix4(M);
    box.expandByPoint(v);
  }
  // round & joint & wheel shapes don't fill their corners; shrink the vertical extent of tilted ones a little
  return box;
}

export function ancestors(bp, id, map = byId(bp)) {
  const out = [];
  let p = map.get(id);
  while (p && p.parent != null) { p = map.get(p.parent); if (p) out.push(p); }
  return out;
}

export function subtree(bp, id, ch = children(bp)) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const k = stack.pop();
    out.push(k);
    for (const c of ch.get(k) || []) stack.push(c.id);
  }
  return out;
}

// ---------- legs ----------
// A leg is the chain of joints between a ground-touching part and the point where it meets the other legs.
export function findSupport(bp) {
  const map = byId(bp);
  let groundY = Infinity;
  const boxes = new Map();
  for (const p of bp.parts) { const b = restAABB(p); boxes.set(p.id, b); groundY = Math.min(groundY, b.min.y); }
  const touching = bp.parts.filter(p => boxes.get(p.id).min.y < groundY + CFG.build.groundEps);
  const wheels = touching.filter(p => p.type === 'wheel');
  const feetGroups = new Map(); // nearest joint id -> [parts]
  const skids = [];
  for (const p of touching) {
    if (p.type === 'wheel') continue;
    let a = p.parent != null ? map.get(p.parent) : null;
    while (a && a.type !== 'joint') a = a.parent != null ? map.get(a.parent) : null;
    if (!a) { skids.push(p); continue; }
    if (!feetGroups.has(a.id)) feetGroups.set(a.id, []);
    feetGroups.get(a.id).push(p);
  }
  // joint ancestors of each foot (including its nearest joint)
  const feet = [];
  for (const [jid, parts] of feetGroups) {
    const chain = [map.get(jid), ...ancestors(bp, jid, map).filter(a => a.type === 'joint')];
    feet.push({ jid, parts, chain });
  }
  const legs = [];
  for (const f of feet) {
    const others = feet.filter(o => o !== f);
    const shared = new Set();
    for (const o of others) for (const j of o.chain) shared.add(j.id);
    const chain = f.chain.filter(j => !shared.has(j.id));     // foot-to-hip order
    if (chain.length < 2) continue;
    // contact point: bottom centre of the foot group's footprint
    const fb = new THREE.Box3();
    for (const p of f.parts) fb.union(boxes.get(p.id));
    const contact = new THREE.Vector3((fb.min.x + fb.max.x) / 2, groundY, (fb.min.z + fb.max.z) / 2);
    const hip = chain[chain.length - 1];
    const hipPos = new THREE.Vector3(hip.p[0], hip.p[1], hip.p[2]);
    // the foot part used as the IK end effector: the touching part with the lowest point
    const footPart = f.parts.slice().sort((a, b) => boxes.get(a.id).min.y - boxes.get(b.id).min.y)[0];
    legs.push({
      chain: chain.map(j => j.id), footPart: footPart.id, foot: f.jid,
      contact: contact.toArray(), hip: hip.id, length: hipPos.y - groundY, side: Math.sign(contact.x) || 1,
    });
  }
  return { groundY, legs, wheels: wheels.map(w => w.id), skids: skids.map(s => s.id) };
}

// ---------- inertia for joint speed ----------
export function jointInertia(bp, jointPt, ch = children(bp)) {
  const M = restMatrix(jointPt);
  const origin = new THREE.Vector3().setFromMatrixPosition(M);
  const axis = new THREE.Vector3(1, 0, 0).transformDirection(M);
  let I = 0;
  const ids = subtree(bp, jointPt.id, ch).slice(1);
  const map = byId(bp);
  const d = new THREE.Vector3();
  for (const id of ids) {
    const p = map.get(id);
    const m = partMass(p);
    d.set(p.p[0], p.p[1], p.p[2]).sub(origin);
    const along = d.dot(axis);
    const r2 = d.lengthSq() - along * along;
    // the part's own spread along its longest axis matters for long poles: add m*L^2/12
    const h = halfExtents(p);
    const L = 2 * Math.max(h[0], h[1], h[2]);
    I += m * (r2 + L * L / 12);
  }
  return I;
}

export function jointOmega(bp, jointPt, ch) {
  const I = jointInertia(bp, jointPt, ch);
  const w = CFG.joint.omegaK * jointTorque(jointPt) / (I + CFG.joint.I0);
  return Math.min(CFG.joint.omegaMax, Math.max(CFG.joint.omegaMin, w));
}

// ---------- totals ----------
export function computeStats(bp) {
  const cores = bp.parts.filter(p => p.type === 'core');
  const core = cores[0];
  let load = 0, mass = 0, hp = 0, thrust = 0;
  const com = new THREE.Vector3();
  const weapons = [];
  for (const p of bp.parts) {
    load += partLoad(p);
    const m = partMass(p);
    mass += m;
    hp += partHP(p);
    com.x += m * p.p[0]; com.y += m * p.p[1]; com.z += m * p.p[2];
    if (p.type === 'thruster') thrust += thrusterThrust(p);
    if (PARTS[p.type].weapon) weapons.push(p.id);
  }
  com.divideScalar(mass || 1);
  const budget = core ? PARTS.core.budget * volRatio(core.s) ** 0.25 : 0;
  const support = findSupport(bp);
  const ch = children(bp);
  let legTorque = 0;
  const legJoints = new Set();
  for (const L of support.legs) for (const j of L.chain) legJoints.add(j);
  const map = byId(bp);
  for (const j of legJoints) legTorque += jointTorque(map.get(j));
  const omegas = {};
  for (const p of bp.parts) if (p.type === 'joint') omegas[p.id] = jointOmega(bp, p, ch);
  // Two-handed grips: a part with grip = {part, at} holds another part (a pole, a sword). The joints of the
  // gripping arm help swing the held weapon: their torque is added, joint by joint from the shoulder down,
  // to the joints that carry it. A long lance that is hopeless one-handed becomes usable two-handed.
  for (const g of bp.parts) {
    if (!g.grip || !map.has(g.grip.part)) continue;
    const held = map.get(g.grip.part);
    const chainOf = (pt) => ancestors(bp, pt.id, map).filter(a => a.type === 'joint');
    const hc = chainOf(held), gc = chainOf(g);
    const gIds = new Set(gc.map(j => j.id)), hIds = new Set(hc.map(j => j.id));
    const H = hc.filter(j => !gIds.has(j.id)).reverse(), G = gc.filter(j => !hIds.has(j.id)).reverse();
    for (let i = 0; i < H.length; i++) {
      if (!G[i]) break;
      const I = jointInertia(bp, H[i], ch);
      const w = CFG.joint.omegaK * (jointTorque(H[i]) + jointTorque(G[i])) / (I + CFG.joint.I0);
      omegas[H[i].id] = Math.min(CFG.joint.omegaMax, Math.max(CFG.joint.omegaMin, w));
    }
  }
  const legLen = support.legs.length ? support.legs.reduce((a, l) => a + l.length, 0) / support.legs.length : 0;
  const issues = [];
  if (cores.length !== 1) issues.push(cores.length ? '只能有一个核心' : '缺少核心');
  if (load > budget + 1e-6) issues.push(`超出负载 ${load.toFixed(0)}/${budget.toFixed(0)}`);
  if (bp.parts.length > CFG.build.maxParts) issues.push(`零件过多 (${bp.parts.length}/${CFG.build.maxParts})`);
  const canWalk = support.legs.length >= CFG.walk.minLegs;
  const canRoll = support.wheels.length >= CFG.wheel.minWheels;
  if (!canWalk && !canRoll && thrust <= 0) issues.push('没有腿、轮子或推进器：动不了');
  return {
    load, budget, mass, hp, thrust, com: com.toArray(), weapons, support, legTorque, legLen, omegas,
    canWalk, canRoll, issues, parts: bp.parts.length,
  };
}
