// js/mech.js — a blueprint brought to life: three.js rig, joint servos, actions, legs/wheels/thrusters, part HP.
//
// Hierarchy: root (world position + yaw) -> body (lifts the rest pose so its lowest point sits on y=0)
//            -> core node -> part nodes ... ; a joint's children hang off its rotor, which turns about local X.
// Each node's matrix = inverse(parent rest) * own rest, so the rest pose reproduces the blueprint exactly.

import * as THREE from 'three';
import { CFG } from './config.js';
import { PARTS, restAABB, restMatrix, halfExtents, computeStats, partMass, partHP, byId, children, subtree, findSupport } from './parts.js';
import { ActionPlayer, servo } from './actions.js';
import { partGeometry } from './partMesh.js';
import { inkMaterial, outlineMaterial, makeShared, inkPhantomMaterial } from './ink.js';
import { techMaterial, techPhantomMaterial } from './tech.js';
import { specFromStats } from './spec.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export class Mech {
  constructor(bp, scene, opts = {}) {
    this.bp = bp;
    this.scene = scene;
    this.team = opts.team ?? 0;
    this.name = bp.name;
    this.shared = makeShared();
    this.palette = { ...bp.palette };
    this.ink = bp.style === 'ink';
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    scene.add(this.root);
    this.pos = this.root.position;
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.onGround = true;
    this.boost = CFG.thrust.cap;
    this.dashT = 0; this.iframe = 0; this.stun = 0; this.hitT = 0;
    this.dead = false;
    this.player = new ActionPlayer(bp);
    this.ki = CFG.phantom.cap; this.phantomOn = false; this.phantomRoots = [];
    this.mats = new Map();
    this.outline = outlineMaterial(this.shared);
    this.build();
    this.snapToIdle();
  }

  // start in the stance instead of the rest pose
  snapToIdle() {
    for (const r of this.parts.values()) {
      if (!r.joint) continue;
      const t = this.player.target(r.id);
      if (typeof t === 'number') { r.joint.a = t; r.rotor.matrix.makeRotationAxis(AXIS_X, t); }
    }
    this.root.updateMatrixWorld(true);
  }

  mat(slot) {
    const hex = this.palette[slot] || slot;
    const WASH = { armor: 1, light: 0.55, frame: 0.35, steel: 0.5, accent: 0.6, ink: 0.3, glow: 0 };
    if (!this.mats.has(hex)) this.mats.set(hex, this.ink
      ? inkMaterial(hex, this.shared, { glow: slot === 'glow', wash: WASH[slot] ?? 0.6 })
      : techMaterial(hex, { glow: slot === 'glow', metal: slot === 'frame' || slot === 'steel' ? 0.75 : 0.5, rough: slot === 'light' ? 0.5 : 0.34 }));
    return this.mats.get(hex);
  }

  build() {
    const bp = this.bp;
    const map = byId(bp);
    this.parts = new Map();
    const rest = new Map();
    for (const p of bp.parts) rest.set(p.id, restMatrix(p));
    const order = [];
    const ch = children(bp);
    const core = bp.parts.find(p => p.type === 'core');
    const walk = (id) => { order.push(id); for (const c of ch.get(id) || []) walk(c.id); };
    walk(core.id);
    for (const id of order) {
      const pt = map.get(id);
      const node = new THREE.Group();
      node.matrixAutoUpdate = false;
      const parentRec = pt.parent != null ? this.parts.get(pt.parent) : null;
      if (parentRec) node.matrix.copy(_m.copy(rest.get(pt.parent)).invert().multiply(rest.get(id)));
      else node.matrix.copy(rest.get(id));
      (parentRec ? (parentRec.rotor || parentRec.node) : this.body).add(node);
      const geo = partGeometry(pt);
      const mesh = new THREE.Mesh(geo, this.mat(pt.c));
      mesh.castShadow = true; mesh.receiveShadow = !this.ink;
      const out = this.ink ? new THREE.Mesh(geo, this.outline) : new THREE.Object3D();
      let holder = node, rotor = null, spinNode = null;
      if (pt.type === 'joint') {
        rotor = new THREE.Group(); rotor.matrixAutoUpdate = false; node.add(rotor);
        // half the capsule turns with the rotor so you can see it move
        mesh.add(out); node.add(mesh);
      } else if (pt.type === 'wheel') {
        spinNode = new THREE.Group(); node.add(spinNode); spinNode.add(mesh); mesh.add(out);
      } else { mesh.add(out); node.add(mesh); }
      mesh.userData.partId = id;
      const P = PARTS[pt.type] || PARTS.block;
      const rec = {
        id, pt, node, rotor, spinNode, mesh, he: halfExtents(pt), hp: partHP(pt), maxHp: partHP(pt), alive: true,
        mass: partMass(pt), weapon: P.weapon || null, heat: 0, cd: 0, lock: 0,
        prevA: new THREE.Vector3(), prevB: new THREE.Vector3(), hasPrev: false,
      };
      if (rotor) rec.joint = { a: 0, w: 0 };
      this.parts.set(id, rec);
      void holder;
    }
    this.coreRec = this.parts.get(core.id);
    // weapons, and the few parts holding each one, take reduced damage (see CFG.grip)
    for (const rec of this.parts.values()) {
      if (!rec.weapon) continue;
      rec.tough = true;
      let p = rec.pt, n = 0;
      while (p.parent != null && n < CFG.grip.depth) { const r = this.parts.get(p.parent); if (!r || r === this.coreRec) break; r.tough = true; p = r.pt; n++; }
    }
    // two-handed grips: the gripping arm's joints (not shared with the held weapon's chain, no spin joints)
    this.grips = [];
    for (const rec of this.parts.values()) {
      const g = rec.pt.grip;
      if (!g || !this.parts.has(g.part)) continue;
      const jointsOf = (pt) => { const out = []; let p = pt; while (p.parent != null) { const r = this.parts.get(p.parent); if (!r) break; if (r.joint) out.push(r); p = r.pt; } return out; };
      const held = this.parts.get(g.part);
      const heldIds = new Set(jointsOf(held.pt).map(r => r.id));
      const chain = jointsOf(rec.pt).filter(r => !heldIds.has(r.id) && r.pt.v !== 'spin');
      if (chain.length) this.grips.push({ hand: rec, held, at: g.at, chain });
    }
    let top = -Infinity, bot = Infinity;
    for (const p of bp.parts) { const b = restAABB(p); top = Math.max(top, b.max.y); bot = Math.min(bot, b.min.y); }
    this.shared.uGround.value = bot; this.shared.uHeight.value = Math.max(0.5, top - bot);
    // vertical extent of the body itself (weapons and poles left out), for aim assist
    let bt = -Infinity, bb = Infinity;
    for (const p of bp.parts) { if (PARTS[p.type]?.weapon || PARTS[p.type]?.thrust) continue; const b = restAABB(p); bt = Math.max(bt, b.max.y); bb = Math.min(bb, b.min.y); }
    this.span = [bb, bt];
    this.refresh();
    this.body.updateMatrixWorld(true);
  }

  // re-derive stats from the parts still attached (called at build and whenever something breaks off)
  refresh() {
    const live = { ...this.bp, parts: this.bp.parts.filter(p => this.parts.get(p.id)?.alive) };
    this.liveBp = live;
    this.stats = computeStats(live);
    this.spec = specFromStats(this.stats);
    const sup = this.stats.support;
    if (this.groundY === undefined) this.groundY = sup.groundY;      // keep the original stance height
    // only the legs and wheels it was built with can carry it: once the real legs are gone, the lowest
    // remaining parts (hands, a lance tip) are not new feet
    if (this.legJoints0) {
      sup.legs = sup.legs.filter(L => L.chain.every(j => this.legJoints0.has(j)));
      sup.wheels = sup.wheels.filter(id => this.wheels0.has(id));
    }
    this.legs = sup.legs.map((L, i) => {
      const foot = this.parts.get(L.footPart);
      const contactLocal = new THREE.Vector3(...L.contact).applyMatrix4(_m.copy(restMatrix(foot.pt)).invert());
      const old = this.legs && this.legs.find(o => o.footPart === L.footPart);
      return Object.assign(L, {
        contactLocal, planted: old ? old.planted : null, swing: null, group: i % 2,
        ankle: L.chain.length >= 3 ? L.chain[0] : null,
      });
    });
    // gait groups: alternate by side, front/back
    const sorted = this.legs.slice().sort((a, b) => (a.contact[2] - b.contact[2]) || (a.contact[0] - b.contact[0]));
    sorted.forEach((L, i) => { L.group = (i + (L.side > 0 ? 0 : 1)) % 2; });
    if (this.legs.length === 2) { this.legs[0].group = 0; this.legs[1].group = 1; }
    this.legJoints = new Set(); for (const L of this.legs) for (const j of L.chain) this.legJoints.add(j);
    if (!this.legJoints0) { this.legJoints0 = new Set(this.legJoints); this.omega0 = { ...this.stats.omegas }; this.wheels0 = new Set(sup.wheels); }
    this.wheels = sup.wheels.map(id => this.parts.get(id)).filter(Boolean);
    this.computeSlump(live);
    this.massRatio = this.stats.mass / this.spec.refMass;
    this.radius = 0.9;
    let r = 0.5;
    for (const rec of this.parts.values()) if (rec.alive && rec.pt.type !== 'pole' && !rec.weapon) r = Math.max(r, Math.hypot(rec.pt.p[0], rec.pt.p[2]) + 0.25);
    this.radius = Math.min(2.2, r);
  }

  // Without enough legs or wheels to stand on, the body can't hold its height: it drops until the torso
  // rests on the ground. Torso = parts rigidly fixed to the core (no joint in between), so arms and the
  // stumps of legs don't count. With one leg left it kneels on it: tilt toward the lost side, IK the
  // surviving foot to the ground.
  computeSlump(live) {
    if (!this.slump) { this.slump = { drop: 0, tilt: 0 }; this.slumpCur = { drop: 0, tilt: 0, v: 0 }; }
    const canStand = this.legs.length >= CFG.walk.minLegs || this.wheels.length >= CFG.wheel.minWheels;
    this.kneel = !canStand && this.legs.length > 0;
    if (canStand || !this.legJoints0) { this.slump.drop = 0; this.slump.tilt = 0; return; }
    const map = byId(live);
    const rigid = (p) => { for (let a = p; a; a = a.parent != null ? map.get(a.parent) : null) if (a.type === 'joint') return false; return true; };
    const corners = [];
    for (const p of live.parts) {
      if (!rigid(p)) continue;
      const b = restAABB(p);
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) corners.push([x, y]);
    }
    if (!corners.length) return;
    const lost = this.legs.length ? -this.legs[0].side : 0;           // which side went missing
    const tilt = this.kneel ? -lost * 0.2 : 0;                         // roll about +Z: that side goes down
    const sn = Math.sin(tilt), cs = Math.cos(tilt);
    let low = Infinity;
    for (const [x, y] of corners) low = Math.min(low, x * sn + y * cs);
    this.slump.drop = Math.max(0, low - this.groundY);
    if (this.kneel) this.slump.drop = Math.min(this.slump.drop, this.stats.legLen * 0.45);   // squat on the leg that's left
    this.slump.tilt = tilt;
  }

  updateSlump(dt) {
    const T = this.slump, C = this.slumpCur;
    if (C.drop < T.drop) {
      C.v += CFG.g * dt;
      C.drop = Math.min(T.drop, C.drop + C.v * dt);
      if (C.drop >= T.drop) { this.onLand && this.onLand(Math.max(7, C.v)); C.v = 0; }
    } else { C.drop = T.drop; C.v = 0; }
    C.tilt += (T.tilt - C.tilt) * Math.min(1, dt * 6);
  }

  get legsIK() { return this.onGround && (this.legs.length >= CFG.walk.minLegs || this.kneel); }

  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  // ----- online: the host sends this pose, guests draw it (see js/online.js) -----
  get netJoints() {
    if (!this._netJ) this._netJ = [...this.parts.values()].filter(r => r.joint).map(r => r.id).sort((a, b) => a - b);
    return this._netJ;
  }
  netState() {
    const R = (x) => Math.round(x * 1000) / 1000;
    let heat = 0; for (const r of this.parts.values()) if (r.weapon && r.weapon.kind === 'gun') heat = Math.max(heat, r.heat / CFG.gun.overheat);
    let a = 0, b = 0; for (const r of this.parts.values()) { b += r.maxHp; if (r.alive) a += Math.max(0, r.hp); }
    const out = [R(this.pos.x), R(this.pos.y), R(this.pos.z), R(this.yaw), R(this.yawOff || 0),
      R(this.body.position.y), R(this.body.rotation.z), R(this.body.rotation.x), this.phantomOn ? 1 : 0,
      R(this.boost), R(this.ki), R(heat), R(Math.max(0, this.coreRec.hp / this.coreRec.maxHp)), R(a / b), R(this.vel.dot(this.forward(_v)))];
    for (const id of this.netJoints) out.push(R(this.parts.get(id).joint.a));
    return out;
  }
  // a = netState() from the host (already interpolated); dt only drives the shader clock and hit flash
  applyNet(a, dt) {
    this.pos.set(a[0], a[1], a[2]); this.yaw = a[3]; this.yawOff = a[4];
    this.root.rotation.y = a[3] + a[4];
    this.body.position.y = a[5]; this.body.rotation.z = a[6]; this.body.rotation.x = a[7];
    this.body.updateMatrix();
    const J = this.netJoints;
    for (let i = 0; i < J.length; i++) {
      const r = this.parts.get(J[i]);
      r.joint.a = a[15 + i]; r.rotor.matrix.makeRotationAxis(AXIS_X, r.joint.a);
    }
    if (this.wheels.length) {
      for (const w of this.wheels) {
        if (!w.alive) continue;
        const rr = Math.abs(PARTS.wheel.size[0] * w.pt.s[0]) / 2;
        w.spinNode.rotation.y += (a[14] / rr) * dt * (w.pt.p[0] >= 0 ? 1 : -1);
      }
    }
    this.root.updateMatrixWorld(true);
    this.shared.uBodyInv.value.copy(this.body.matrixWorld).invert();
    this.shared.uTime.value += dt;
    this.shared.uFlash.value = Math.max(0, this.shared.uFlash.value - dt * 6);
    if (!this.ink) for (const mt of this.mats.values()) if (mt.emissiveIntensity === 1) mt.emissive.setScalar(this.shared.uFlash.value * 0.8);
    if ((a[8] === 1) !== this.phantomOn) this.setPhantom(a[8] === 1);
    this.boost = a[9]; this.ki = a[10];
    this.net = { heat: a[11], core: a[12], integ: a[13] };
  }

  // ----- per frame -----
  // intent: { move: Vector3 (world xz, length<=1), face: yaw or null, jump, hover, dash: Vector3|null }
  update(dt, intent) {
    if (this.dead) { this.updateDeath(dt); return; }
    this.shared.uFlash.value = Math.max(0, this.shared.uFlash.value - dt * 6);
    this.shared.uTime.value += dt;
    this.updatePhantom(dt);
    if (!this.ink) for (const mt of this.mats.values()) if (mt.emissiveIntensity === 1) mt.emissive.setScalar(this.shared.uFlash.value * 0.8);
    this.iframe = Math.max(0, this.iframe - dt);
    this.stun = Math.max(0, this.stun - dt);
    this.hitT = Math.max(0, this.hitT - dt);
    for (const r of this.parts.values()) { r.cd = Math.max(0, r.cd - dt); r.heat = Math.max(0, r.heat - CFG.gun.cool * dt); r.lock = Math.max(0, r.lock - dt); }

    if (this.stun <= 0) this.player.update(dt); else { this.player.events.length = 0; this.player.lunges.length = 0; }
    this.locomote(dt, intent);
    this.driveJoints(dt);
    const yo = this.player.yawOffset() * (this.mirrorDrive ? -1 : 1);
    this.yawOff = yo;
    this.root.rotation.y = this.yaw + yo;
    this.root.updateMatrixWorld(true);
    this.shared.uBodyInv.value.copy(this.body.matrixWorld).invert();
    this.solveGrips();
    if (this.legsIK) this.solveLegs(dt);
    this.spinWheels(dt);
  }

  locomote(dt, it) {
    const S = this.spec;
    const fwd = this.forward(_v3);
    const acting = this.player.busy;
    const k = (acting ? 0.55 : 1) * (this.stun > 0 ? 0.2 : 1);
    const ground = this.onGround;
    // facing
    if (it.face != null && this.stun <= 0) {
      let d = it.face - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const rate = (this.legs.length >= CFG.walk.minLegs ? S.turn : this.wheels.length >= CFG.wheel.minWheels ? S.wheelTurn : (ground ? S.turn * 0.3 : S.turn * 0.6)) * (acting ? 0.6 : 1);
      this.yaw += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    }
    // dash
    if (it.dash && this.dashT <= 0 && this.boost >= CFG.thrust.dashCost && S.dash > 0 && this.stun <= 0) {
      this.boost -= CFG.thrust.dashCost;
      this.dashT = CFG.thrust.dashTime; this.iframe = 0.18;
      this.dashDir = it.dash.clone().setY(0).normalize();
      this.onDash && this.onDash();
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vel.x = this.dashDir.x * S.dash; this.vel.z = this.dashDir.z * S.dash;
      if (!ground) this.vel.y = Math.max(this.vel.y, 0);
    } else {
      const want = _v.copy(it.move || _v.set(0, 0, 0)).setY(0);
      if (ground && this.legs.length >= CFG.walk.minLegs) {
        want.multiplyScalar(S.walk * k);
        this.approach(want, 34, dt);
      } else if (ground && this.wheels.length >= CFG.wheel.minWheels) {
        const along = want.dot(fwd) * S.roll * k;
        const vf = this.vel.dot(fwd);
        const nvf = vf + Math.sign(along - vf) * Math.min(Math.abs(along - vf), CFG.wheel.accel * dt);
        const lat = _v2.copy(this.vel).addScaledVector(fwd, -vf).multiplyScalar(Math.max(0, 1 - 8 * dt));
        this.vel.x = fwd.x * nvf + lat.x; this.vel.z = fwd.z * nvf + lat.z;
      } else {
        // no ground drive: slide to a stop on the ground, drift with thrusters in the air
        if (ground) this.approach(_v2.set(0, 0, 0), CFG.ground.friction, dt);
        else if (S.dash > 0) this.vel.addScaledVector(want, CFG.thrust.drift * dt);
      }
    }
    for (const l of this.player.lunges) this.vel.addScaledVector(fwd, l / Math.sqrt(Math.max(0.5, this.massRatio)));
    // jump / hover
    if (it.jump && ground && this.stun <= 0) {
      if (S.jump > 0) { this.vel.y = S.jump; this.onGround = false; }
      else if (S.hover && this.boost > 10) { this.vel.y = 6; this.onGround = false; }
    }
    if (!this.onGround) {
      this.vel.y -= CFG.g * dt;
      if (it.hover && S.hover && this.boost > 0 && this.vel.y < 4) {
        this.vel.y += (CFG.g + S.lift) * dt;
        this.boost -= CFG.thrust.hoverCost * dt;
        this.thrusting = true;
      } else this.thrusting = this.dashT > 0;
      this.vel.x *= 1 - CFG.ground.airFriction * dt * 0.3; this.vel.z *= 1 - CFG.ground.airFriction * dt * 0.3;
    } else {
      this.thrusting = this.dashT > 0;
      this.boost = Math.min(CFG.thrust.cap, this.boost + CFG.thrust.regen * dt);
    }
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y <= 0) { this.pos.y = 0; if (this.vel.y < 0) { if (!this.onGround) this.onLand && this.onLand(-this.vel.y); this.vel.y = 0; } this.onGround = true; }
    else if (this.pos.y > 0.02) this.onGround = false;
    const r = Math.hypot(this.pos.x, this.pos.z), R = CFG.arena.radius - this.radius;
    if (r > R) { this.pos.x *= R / r; this.pos.z *= R / r; }
    // body height: legs keep knees soft; bob a little while walking
    this.updateSlump(dt);
    const crouch = this.legs.length >= CFG.walk.minLegs ? CFG.walk.crouch * this.stats.legLen : 0;
    this.body.position.y = -this.groundY - crouch - this.slumpCur.drop;
    this.body.rotation.z = this.slumpCur.tilt;
    this.body.updateMatrix();
  }

  approach(want, accel, dt) {
    const dx = want.x - this.vel.x, dz = want.z - this.vel.z;
    const L = Math.hypot(dx, dz), s = Math.min(L, accel * dt);
    if (L > 1e-6) { this.vel.x += dx / L * s; this.vel.z += dz / L * s; }
  }

  driveJoints(dt) {
    const om = this.stats.omegas;
    const ikNow = this.legsIK;
    this.ikBlocked = new Set();
    this.gripOwned = new Set();
    for (const g of this.activeGrips()) for (const j of g.chain) this.gripOwned.add(j.id);
    for (const rec of this.parts.values()) {
      if (!rec.joint || !(rec.alive || rec.phantom)) continue;
      if (this.gripOwned.has(rec.id)) continue;
      let tgt = this.player.target(rec.id);
      if (this.mirrorDrive && this.mirrorDrive.has(rec.id)) { const t2 = this.player.target(this.mirrorDrive.get(rec.id)); if (t2 !== undefined) tgt = t2; }
      if (ikNow && this.legJoints.has(rec.id)) {
        // an action may borrow a leg (a kick); otherwise the leg IK owns it
        if (tgt !== undefined && this.player.cur && this.player.cur.keys.some(k => rec.id in k.j)) this.ikBlocked.add(rec.id);
        else continue;
      }
      const spin = rec.pt.v === 'spin';
      const t = (tgt && typeof tgt === 'object' && !spin) ? undefined : tgt;
      servo(rec.joint, t, om[rec.id] || this.omega0[rec.id] || CFG.joint.omegaMax, spin ? null : rec.pt.lim, dt, CFG.joint.spinAccel);
      rec.rotor.matrix.makeRotationAxis(AXIS_X, rec.joint.a);
    }
  }

  // ----- legs: procedural stepping + CCD IK on each leg's hinge chain -----
  solveLegs(dt) {
    const S = this.spec;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const stride = Math.max(0.3, 0.42 * this.stats.legLen);
    const stepT = CFG.walk.stepTime * Math.max(0.6, Math.min(1.6, Math.sqrt(S.walkRef / Math.max(1, S.walk))));
    const lead = _v2.set(this.vel.x, 0, this.vel.z).multiplyScalar(stepT * 0.55);
    const swingCount = [0, 0];
    for (const L of this.legs) if (L.swing) swingCount[L.group]++;
    if (this.kneel) {
      for (const L of this.legs) { this.ik(L, this.legHome(L, _v)); }
      return;
    }
    for (const L of this.legs) {
      if (L.chain.some(j => this.ikBlocked.has(j))) { L.planted = null; continue; }
      const home = this.legHome(L, _v).add(lead);
      if (!L.planted) L.planted = home.clone();
      if (L.swing) {
        L.swing.t += dt / stepT;
        const u = Math.min(1, L.swing.t);
        L.swing.to.copy(home);
        L.cur = L.swing.from.clone().lerp(L.swing.to, u);
        L.cur.y += Math.sin(Math.PI * u) * Math.min(stride, 0.25 + speed * 0.05) * CFG.walk.stepHeight;
        if (u >= 1) { L.planted.copy(L.swing.to); L.planted.y = 0; L.swing = null; swingCount[L.group]--; this.onStep && this.onStep(L.planted); }
      } else {
        L.cur = L.planted.clone();
        const far = L.planted.distanceTo(home);
        const other = 1 - L.group;
        if (far > stride * (speed > 0.5 ? 0.5 : 0.8) && swingCount[other] === 0) {
          L.swing = { from: L.planted.clone(), to: home.clone(), t: 0 };
          swingCount[L.group]++;
        }
      }
      this.ik(L, L.cur);
    }
  }

  legHome(L, out) {
    // rest contact point in world, at ground height
    out.set(...L.contact);
    out.y += -this.groundY;
    out.x += L.side * CFG.walk.stanceWidth;
    out.z += L.side * CFG.walk.stanceStagger * 0.5;
    out.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw + (this.yawOff || 0)).add(this.pos);
    out.y = 0;
    return out;
  }

  ik(L, target) {
    const map = this.parts;
    const foot = map.get(L.footPart);
    const solve = L.ankle ? L.chain.slice(1) : L.chain;
    const om = this.stats.omegas;
    const eff = new THREE.Vector3(), piv = new THREE.Vector3(), ax = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    const hipRec = map.get(L.chain[L.chain.length - 1]);
    for (let it = 0; it < 6; it++) {
      for (const jid of solve) {
        const rec = map.get(jid);
        if (!rec.alive) continue;
        rec.node.updateMatrixWorld(true);
        eff.copy(L.contactLocal).applyMatrix4(foot.node.matrixWorld);
        piv.setFromMatrixPosition(rec.node.matrixWorld);
        ax.copy(AXIS_X).transformDirection(rec.node.matrixWorld);
        if (rec.node.matrixWorld.determinant() < 0) ax.negate();
        a.subVectors(eff, piv); b.subVectors(target, piv);
        a.addScaledVector(ax, -a.dot(ax)); b.addScaledVector(ax, -b.dot(ax));
        if (a.lengthSq() < 1e-6 || b.lengthSq() < 1e-6) continue;
        let ang = Math.atan2(_v3.crossVectors(a, b).dot(ax), a.dot(b));
        const maxStep = (om[jid] || 10) * 0.08 + 0.15;
        ang = Math.max(-maxStep, Math.min(maxStep, ang));
        const lim = rec.pt.lim || [-160, 160];
        rec.joint.a = Math.max(lim[0] * Math.PI / 180, Math.min(lim[1] * Math.PI / 180, rec.joint.a + ang));
        rec.rotor.matrix.makeRotationAxis(AXIS_X, rec.joint.a);
      }
    }
    hipRec.node.updateMatrixWorld(true);
    // ankle: rotate so the foot's up axis matches world up (flat foot)
    if (L.ankle) {
      const rec = map.get(L.ankle);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(foot.node.matrixWorld);
      ax.copy(AXIS_X).transformDirection(rec.node.matrixWorld);
      if (rec.node.matrixWorld.determinant() < 0) ax.negate();
      const t = new THREE.Vector3(0, 1, 0);
      const ang = Math.atan2(ax.dot(_v3.crossVectors(up, t)), up.dot(t) - ax.dot(up) * ax.dot(t));
      const lim = rec.pt.lim || [-160, 160];
      rec.joint.a = Math.max(lim[0] * Math.PI / 180, Math.min(lim[1] * Math.PI / 180, rec.joint.a + ang));
      rec.rotor.matrix.makeRotationAxis(AXIS_X, rec.joint.a);
      rec.node.updateMatrixWorld(true);
    }
  }

  // grips that should hold right now: the hand is attached, the held part exists (or its ghost is out),
  // and the current action doesn't let go (action.grip === false, e.g. spinning the lance one-handed)
  activeGrips() {
    if (!this.grips || !this.grips.length) return [];
    if (this.player.cur && this.player.cur.grip === false) return [];
    return this.grips.filter(g => !g.transferred && g.hand.alive && (g.held.alive || (g.held.phantom && this.phantomOn)) && g.chain.every(j => j.alive));
  }

  // CCD IK: turn the gripping arm's joints so the hand sits on the held part at `at` metres along its axis
  solveGrips() {
    const grips = this.activeGrips();
    if (!grips.length) return;
    const tgt = new THREE.Vector3(), eff = new THREE.Vector3(), piv = new THREE.Vector3(), ax = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const g of grips) {
      const top = g.chain[g.chain.length - 1];
      for (let it = 0; it < 10; it++) {
        for (const rec of g.chain) {
          rec.node.updateMatrixWorld(true);
          g.held.node.updateMatrixWorld(true);
          tgt.set(0, g.at, 0).applyMatrix4(g.held.node.matrixWorld);
          eff.setFromMatrixPosition(g.hand.node.matrixWorld);
          piv.setFromMatrixPosition(rec.node.matrixWorld);
          ax.copy(AXIS_X).transformDirection(rec.node.matrixWorld);
          if (rec.node.matrixWorld.determinant() < 0) ax.negate();
          a.subVectors(eff, piv); b.subVectors(tgt, piv);
          a.addScaledVector(ax, -a.dot(ax)); b.addScaledVector(ax, -b.dot(ax));
          if (a.lengthSq() < 1e-6 || b.lengthSq() < 1e-6) continue;
          const ang = Math.atan2(_v3.crossVectors(a, b).dot(ax), a.dot(b));
          const lim = rec.pt.lim || [-180, 180];
          rec.joint.a = Math.max(lim[0] * Math.PI / 180, Math.min(lim[1] * Math.PI / 180, rec.joint.a + ang * 0.8));
          rec.rotor.matrix.makeRotationAxis(AXIS_X, rec.joint.a);
        }
      }
      top.node.updateMatrixWorld(true);
    }
  }

  spinWheels(dt) {
    if (!this.wheels.length) return;
    const fwd = this.forward(_v);
    const v = this.vel.dot(fwd);
    for (const w of this.wheels) {
      if (!w.alive) continue;
      const r = Math.abs(PARTS.wheel.size[0] * w.pt.s[0]) / 2;
      w.spinNode.rotation.y += (v / r) * dt * (w.pt.p[0] >= 0 ? 1 : -1);
    }
  }

  // ----- world-space helpers for combat -----
  worldSeg(rec, A, B) {
    const P = PARTS[rec.pt.type];
    const H = P.size[1] * Math.abs(rec.pt.s[1]);
    A.set(0, rec.weapon.seg[0] * H, 0).applyMatrix4(rec.node.matrixWorld);
    B.set(0, rec.weapon.seg[1] * H, 0).applyMatrix4(rec.node.matrixWorld);
  }
  muzzle(rec, pos, dir) {
    const H = PARTS[rec.pt.type].size[1] * Math.abs(rec.pt.s[1]);
    pos.set(0, H / 2, 0).applyMatrix4(rec.node.matrixWorld);
    dir.set(0, 1, 0).transformDirection(rec.node.matrixWorld);
  }
  // world-space [bottom, top] of the body right now (follows a slump after losing legs)
  bodySpan() {
    const off = this.pos.y - this.groundY - (this.slumpCur ? this.slumpCur.drop : 0);
    return [this.span[0] + off, this.span[1] + off];
  }

  center(out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.coreRec.node.matrixWorld); }

  // ----- damage -----
  damage(rec, amount, from) {
    if (!rec.alive || this.dead || this.iframe > 0) return false;
    rec.hp -= amount * (rec.tough ? CFG.grip.armor : 1);
    this.shared.uFlash.value = 0.4;
    this.hitT = 0.25;
    if (rec.hp <= 0) this.breakOff(rec, from);
    return true;
  }

  breakOff(rec, from) {
    rec.alive = false;
    if (rec === this.coreRec) { this.die(); return; }
    const ids = subtree(this.bp, rec.id);
    const world = new THREE.Matrix4().copy(rec.node.matrixWorld);
    const carriesWeapon = ids.some(id => { const r = this.parts.get(id); return r && (r.weapon || r.phantom); });
    const anchor = this.aliveAncestor(rec.pt);
    const v = new THREE.Vector3((Math.random() - 0.5) * 6, 5 + Math.random() * 4, (Math.random() - 0.5) * 6);
    if (from) v.addScaledVector(from, 4);
    const w = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8);
    this.debris = this.debris || [];
    if (carriesWeapon && anchor && this.isArm(anchor.id)) {
      // the real piece flies off as a copy; the original stays on the arm as the weapon's ghost
      const flying = rec.node.clone(true);
      flying.matrix.copy(world);
      this.scene.add(flying);
      this.debris.push({ node: flying, v, w, t: 0 });
      const mat = this.phantomMaterial();
      for (const id of ids) {
        const r = this.parts.get(id); if (!r) continue;
        r.alive = false; r.phantom = true; r.hasPrev = false;
        r.mesh.material = mat;
        for (const c of r.mesh.children) c.visible = false;
      }
      this.phantomRoots = this.phantomRoots.filter(n => !ids.includes(n.id));
      this.phantomRoots.push(rec);
      rec.node.visible = this.phantomOn;
    } else if (carriesWeapon && this.handOver(rec, ids, world, v, w)) {
      // the weapon's ghost moved to the other hand (see handOver)
    } else {
      for (const id of ids) { const r = this.parts.get(id); if (r) { r.alive = false; r.phantom = false; } }
      this.phantomRoots = this.phantomRoots.filter(n => !ids.includes(n.id));
      rec.node.parent.remove(rec.node);
      rec.node.matrix.copy(world);
      rec.node.visible = true;
      this.scene.add(rec.node);
      this.debris.push({ node: rec.node, v, w, t: 0 });
    }
    this.onBreak && this.onBreak(rec, world);
    this.refresh();
  }

  // Two-handed weapon, and the arm that carried it is gone: the hand that was gripping it takes the weapon's ghost.
  // The weapon assembly (the joint it hangs from, and everything on it) is re-hung on the other arm in the mirror
  // position of where it was, and that arm now plays the lost arm's keyframes mirrored (same angle on the mirror
  // joint = mirror-image motion), with the body's yaw offsets flipped. So the whole technique carries on left-handed.
  handOver(rec, ids, world, v, w) {
    const inBroken = new Set(ids);
    const g = (this.grips || []).find(g => inBroken.has(g.held.id) && !inBroken.has(g.hand.id) && g.hand.alive && g.chain.every(j => j.alive) && !g.transferred);
    if (!g) return false;
    let mount = this.parts.get(g.held.pt.parent);
    while (mount && !mount.joint) mount = this.parts.get(mount.pt.parent);
    if (!mount || !inBroken.has(mount.id)) return false;
    const mate = mount.pt.m != null ? this.parts.get(mount.pt.m) : null;
    // flying copy of everything that broke, then move the weapon assembly to the other arm
    const flying = rec.node.clone(true); flying.matrix.copy(world); this.scene.add(flying);
    this.debris.push({ node: flying, v, w, t: 0 });
    if (mate && mate.alive && mate.node.parent) {
      mate.node.parent.add(mount.node);            // same parent, same rest matrix as the mirror joint: an exact mirror
      mount.node.matrix.copy(mate.node.matrix);
      mate.node.visible = false;
    } else {
      g.hand.node.updateMatrixWorld(true);
      const local = new THREE.Matrix4().copy(g.hand.node.matrixWorld).invert().multiply(mount.node.matrixWorld);
      g.hand.node.add(mount.node); mount.node.matrix.copy(local);
    }
    rec.node.parent && rec.node.parent.remove(rec.node);
    const keep = new Set(subtree(this.bp, mount.id));
    const mat = this.phantomMaterial();
    for (const id of ids) {
      const r = this.parts.get(id); if (!r) continue;
      r.alive = false;
      if (keep.has(id)) { r.phantom = true; r.hasPrev = false; r.mesh.material = mat; for (const c of r.mesh.children) c.visible = false; }
      else r.phantom = false;
    }
    this.phantomRoots = this.phantomRoots.filter(n => !ids.includes(n.id));
    this.phantomRoots.push(mount);
    mount.node.visible = this.phantomOn;
    g.transferred = true;
    // mirror drive: each joint of the gripping arm follows its mirror partner's keyframes
    this.mirrorDrive = this.mirrorDrive || new Map();
    for (const j of [...g.chain, ...(mate ? [mate] : [])]) if (j.pt.m != null) this.mirrorDrive.set(j.id, j.pt.m);
    // the gripping arm's spin joint too (wrist roll), so 转枪 still spins
    for (const r of this.parts.values()) if (r.joint && r.alive && r.pt.v === 'spin' && r.pt.m != null && inBroken.has(r.pt.m) && this.isArm(r.id)) this.mirrorDrive.set(r.id, r.pt.m);
    this.onHandOver && this.onHandOver();
    return true;
  }

  aliveAncestor(pt) {
    let p = pt;
    while (p.parent != null) { const r = this.parts.get(p.parent); if (!r) return null; if (r.alive) return r; p = r.pt; }
    return null;
  }

  // part of an arm: not the core, and not hanging off a leg joint
  isArm(id) {
    if (id === this.coreRec.id) return false;
    let p = this.parts.get(id).pt;
    while (p) {
      if (this.legJoints0.has(p.id)) return false;
      if (p.parent == null) break;
      p = this.parts.get(p.parent).pt;
    }
    return true;
  }

  phantomMaterial() {
    if (!this._phMat) this._phMat = this.ink
      ? inkPhantomMaterial(this.palette.armor || '#3cb4ae', this.shared)
      : techPhantomMaterial((this.colorTeam ?? this.team) === 0 ? '#3de0d0' : '#ff8a3d', this.shared);
    return this._phMat;
  }

  setPhantom(on) {
    if (this.phantomOn === on) return;
    this.phantomOn = on;
    for (const r of this.phantomRoots) { r.node.visible = on; for (const id of subtree(this.bp, r.id)) { const q = this.parts.get(id); if (q) q.hasPrev = false; } }
    this.onPhantom && this.onPhantom(on);
  }

  updatePhantom(dt) {
    const P = CFG.phantom;
    if (!this.phantomRoots.length) { this.ki = Math.min(P.cap, this.ki + P.regen * dt); if (this.phantomOn) this.setPhantom(false); return; }
    if (this.phantomOn) { this.ki -= P.drain * dt; if (this.ki <= 0) { this.ki = 0; this.setPhantom(false); } }
    else { this.ki = Math.min(P.cap, this.ki + P.regen * dt); if (this.ki >= P.summon) this.setPhantom(true); }
  }

  die() {
    this.dead = true;
    this.deathT = 0;
    this.onDeath && this.onDeath();
  }

  updateDeath(dt) {
    this.deathT += dt;
    this.body.rotation.x = Math.min(1.35, this.deathT * 1.6);
    const d0 = this.slumpCur ? this.slumpCur.drop : 0;
    this.body.position.y = -this.groundY - d0 - Math.min(Math.max(0, this.stats.legLen * 0.5 - d0), this.deathT * 2);
    this.body.updateMatrix();
    this.root.updateMatrixWorld(true);
    this.shared.uBodyInv.value.copy(this.body.matrixWorld).invert();
  }

  updateDebris(dt) {
    if (!this.debris) return;
    for (const d of this.debris) {
      d.t += dt;
      d.v.y -= CFG.g * dt;
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      d.node.matrix.decompose(p, q, s);
      p.addScaledVector(d.v, dt);
      if (p.y < 0.15) { p.y = 0.15; d.v.multiplyScalar(0.4); d.v.y = Math.abs(d.v.y) * 0.3; d.w.multiplyScalar(0.6); }
      q.multiply(new THREE.Quaternion().setFromAxisAngle(_v.copy(d.w).normalize(), d.w.length() * dt));
      d.node.matrix.compose(p, q, s);
      d.node.updateMatrixWorld(true);
      if (d.t > CFG.detach.life) { d.node.visible = false; }
    }
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.debris) for (const d of this.debris) this.scene.remove(d.node);
    for (const m of this.mats.values()) m.dispose();
    if (this._phMat) this._phMat.dispose();
    this.outline.dispose();
  }
}
