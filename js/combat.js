// js/combat.js — bullets, shells, gravity orbs, melee edges, parries.
//
// Hit tests are against each part's oriented box. Edges (blades, swords, poles) are sampled at a few points;
// each point's motion this frame is a segment, tested against the target's boxes. Damage scales with that
// point's speed, so the tip of a long lance hits harder than the shaft near the hands.
// Anti-ranged rule: a bullet whose path passes close to a fast-moving edge is cut (destroyed). Cannon shells
// need a faster edge, and only blades/swords can cut them — a pole just gets hit.

import * as THREE from 'three';
import { CFG } from './config.js';
import { PARTS } from './parts.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const SAMPLES = 6;

// segment p0->p1 vs box (half extents he, expanded by r) in the box's frame given by world matrix M. Returns t in [0,1] or -1
function segBox(p0, p1, M, he, r) {
  _inv.copy(M).invert();
  const a = _c.copy(p0).applyMatrix4(_inv), b = _d.copy(p1).applyMatrix4(_inv);
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const A = a.getComponent(i), D = b.getComponent(i) - A, h = he[i] + r;
    if (Math.abs(D) < 1e-9) { if (A < -h || A > h) return -1; continue; }
    let ta = (-h - A) / D, tb = (h - A) / D;
    if (ta > tb) { const x = ta; ta = tb; tb = x; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0;
}

// closest distance between segments p1q1 and p2q2; also returns s (param on first) and t (on second)
function segSeg(p1, q1, p2, q2, out) {
  const d1 = _a.subVectors(q1, p1), d2 = _b.subVectors(q2, p2), r = _c.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a < 1e-9 && e < 1e-9) { s = t = 0; }
  else if (a < 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1.dot(r);
    if (e < 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const P = _d.copy(p1).addScaledVector(d1, s);
  const Q = new THREE.Vector3().copy(p2).addScaledVector(d2, t);
  out.s = s; out.t = t;
  return P.distanceTo(Q);
}

export class Combat {
  constructor(scene, fx) {
    this.scene = scene; this.fx = fx;
    this.mechs = [];
    this.shots = [];
    this.rehit = new Map();
    this.hitStop = 0;
    this.shake = 0;
    this.time = 0;
    this.stats = { cut: 0, hits: 0 };
    this.nid = 0;
    this.viewOnly = false;      // online guest: draw weapons and shots, decide nothing (the host does)
    this.geo = {
      gun: new THREE.SphereGeometry(1, 8, 6),
      cannon: new THREE.SphereGeometry(1, 12, 8),
      sling: new THREE.IcosahedronGeometry(1, 2),
    };
  }

  add(m) {
    this.mechs.push(m);
    m.trails = new Map();
    for (const rec of m.parts.values()) if (rec.weapon && (rec.weapon.kind === 'edge' || rec.weapon.kind === 'blunt'))
      m.trails.set(rec.id, m.ink ? this.fx.makeTrail('#1f5f5d') : this.fx.makeTrail((m.colorTeam ?? m.team) === 0 ? '#3de0d0' : '#ff8a3d', true));
  }

  // ----- firing -----
  // Nobody aims up and down by hand (the mech turns to face its target, that's all), so a barrel that points
  // roughly at an enemy in the horizontal plane gets its pitch corrected onto that enemy's body.
  // Without it a gun at shoulder height shoots clean over a tank or a crouching spider.
  aimAssist(m, pos, dir) {
    const A = CFG.aim;
    const h = Math.hypot(dir.x, dir.z);
    if (h < 0.2) return;                                         // pointing up or down on purpose
    let best = null, bestAng = A.cone * Math.PI / 180;
    const c = new THREE.Vector3();
    for (const o of this.mechs) {
      if (o === m || o.dead || o.team === m.team) continue;
      o.center(c);
      const dx = c.x - pos.x, dz = c.z - pos.z, L = Math.hypot(dx, dz);
      if (L < 0.5 || L > A.range) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * dir.x + dz * dir.z) / (L * h))));
      if (ang < bestAng) { bestAng = ang; best = { L, span: o.bodySpan() }; }
    }
    if (!best) return;
    // only correct a shot that would pass above or below the body; one already on it keeps its line
    const cur = Math.atan2(dir.y, h);
    const yAt = pos.y + Math.tan(cur) * best.L;
    const lo = best.span[0] + A.margin, hi = Math.max(lo, best.span[1] - A.margin);
    if (yAt >= lo && yAt <= hi) return;
    let want = Math.atan2(Math.max(lo, Math.min(hi, yAt)) - pos.y, best.L);
    const lim = A.pitch * Math.PI / 180;
    want = cur + Math.max(-lim, Math.min(lim, want - cur));
    const kx = dir.x / h, kz = dir.z / h;
    dir.set(kx * Math.cos(want), Math.sin(want), kz * Math.cos(want));
  }

  fire(m, rec, mode, repeat) {
    const ghost = !rec.alive && rec.phantom && m.phantomOn;
    if ((!rec.alive && !ghost) || m.dead) return;
    const w = rec.weapon;
    if (!w) return;
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    m.muzzle(rec, pos, dir);
    if (w.kind !== 'sling' || mode === 'pull') this.aimAssist(m, pos, dir);
    const k = Math.cbrt(Math.abs(rec.pt.s[0] * rec.pt.s[1] * rec.pt.s[2])) * (ghost ? CFG.phantom.dmg : 1);
    if (w.kind === 'gun') {
      if (rec.cd > 0 || rec.lock > 0) return;
      rec.cd = 1 / w.rate;
      rec.heat += CFG.gun.heatPerShot;
      if (rec.heat >= CFG.gun.overheat) { rec.lock = CFG.gun.lockout; rec.heat = CFG.gun.overheat; }
      dir.x += (Math.random() - 0.5) * 0.02; dir.y += (Math.random() - 0.5) * 0.02; dir.normalize();
      this.spawn('gun', m, pos, dir.multiplyScalar(CFG.gun.speed), CFG.gun.radius * k, w.dmg * k, CFG.gun.life);
      this.fx.flare(pos, m.team === 0 ? '#7ff5ea' : '#ffb36b', 0.7);
    } else if (w.kind === 'cannon') {
      if (rec.cd > 0 || rec.lock > 0) return;
      rec.cd = 1 / w.rate;
      this.spawn('cannon', m, pos, dir.clone().multiplyScalar(CFG.cannon.speed), CFG.cannon.radius * k, w.dmg * k, CFG.cannon.life);
      m.vel.addScaledVector(dir.setY(0), -CFG.cannon.recoil / Math.max(0.5, m.massRatio));
      this.fx.flare(pos, '#ffb36b', 2.4); this.fx.sparks(pos, dir, 8, '#ffb36b', 0.25, 6);
      this.shake = Math.max(this.shake, 0.25);
    } else if (w.kind === 'sling') {
      if (rec.cd > 0 || repeat) return;
      rec.cd = w.cd;
      const s = this.spawn('sling', m, pos, dir.clone().multiplyScalar(CFG.sling.speed), CFG.sling.radius, 0, CFG.sling.life);
      s.mode = mode || 'pull';
    }
  }

  spawn(type, owner, pos, vel, r, dmg, life) {
    const hot = (owner.colorTeam ?? owner.team) === 0 ? '#9ffbf2' : '#ffc27a';
    const mat = type === 'sling'
      ? new THREE.MeshBasicMaterial({ color: '#b49bff', transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })
      : new THREE.MeshBasicMaterial({ color: type === 'cannon' ? '#ffb36b' : hot });
    const mesh = new THREE.Mesh(this.geo[type], mat);
    mesh.scale.set(r, r, type === 'gun' ? r * 7 : r);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const s = { type, owner, pos: mesh.position, prev: pos.clone(), vel, r, dmg, life, mesh, dead: false, nid: ++this.nid };
    this.shots.push(s);
    this.onShot && this.onShot(s);
    return s;
  }

  // ----- per frame -----
  update(dt) {
    this.time += dt;
    for (const m of this.mechs) {
      if (m.dead) continue;
      for (const e of m.player.events) {
        const rec = m.parts.get(e.part);
        if (rec) this.fire(m, rec, e.mode, e.repeat);
      }
    }
    this.updateEdges(dt);
    this.updateShots(dt);
  }

  updateEdges(dt) {
    const A = new THREE.Vector3(), B = new THREE.Vector3(), P0 = new THREE.Vector3(), P1 = new THREE.Vector3();
    for (const m of this.mechs) {
      for (const rec of m.parts.values()) {
        const w = rec.weapon;
        if (!w || (w.kind !== 'edge' && w.kind !== 'blunt')) continue;
        const trail = m.trails.get(rec.id);
        const live = (rec.alive || (rec.phantom && m.phantomOn)) && !m.dead;
        if (!live) { if (trail) this.fx.pushTrail(trail, rec.prevA, rec.prevB, false); rec.hasPrev = false; continue; }
        m.worldSeg(rec, A, B);
        if (!rec.hasPrev) { rec.prevA.copy(A); rec.prevB.copy(B); rec.hasPrev = true; rec.speed = 0; continue; }
        // speed of each sample point (for parries and damage)
        let vmax = 0;
        rec.samples = rec.samples || [];
        for (let i = 0; i < SAMPLES; i++) {
          const u = i / (SAMPLES - 1);
          P0.lerpVectors(rec.prevA, rec.prevB, u); P1.lerpVectors(A, B, u);
          const v = P0.distanceTo(P1) / Math.max(1e-4, dt);
          rec.samples[i] = v; vmax = Math.max(vmax, v);
          if (v < CFG.melee.minSpeed || this.viewOnly) continue;
          for (const o of this.mechs) {
            if (o === m || o.dead || o.team === m.team) continue;
            if (o.pos.distanceTo(m.pos) > 16) continue;
            let best = null, bt = 2;
            for (const t of o.parts.values()) {
              if (!t.alive) continue;
              const tt = segBox(P0, P1, t.node.matrixWorld, t.he, w.width * 0.5);
              if (tt >= 0 && tt < bt) { bt = tt; best = t; }
            }
            if (!best) continue;
            const key = rec.id + ':' + o.name + ':' + best.id + ':' + m.name;
            if ((this.rehit.get(key) || 0) > this.time) continue;
            this.rehit.set(key, this.time + CFG.melee.rehit);
            const f = Math.min(CFG.melee.maxFactor, Math.max(CFG.melee.minFactor, v / CFG.melee.refSpeed));
            const k = Math.cbrt(Math.abs(rec.pt.s[0] * rec.pt.s[1] * rec.pt.s[2]));
            const dmg = w.dmg * Math.min(1.6, k) * f * (rec.phantom ? CFG.phantom.dmg : 1);
            const at = P0.clone().lerp(P1, bt);
            const dir = P1.clone().sub(P0).normalize();
            this.hit(o, best, dmg, at, dir, m);
          }
        }
        rec.speed = vmax;
        if (trail) this.fx.pushTrail(trail, A, B, vmax > CFG.parry.speed * 1.4);
        rec.prevA.copy(A); rec.prevB.copy(B);
      }
    }
  }

  hit(o, part, dmg, at, dir, from) {
    dmg *= (from && from.dmgMul) || 1;
    if (!o.damage(part, dmg, dir)) return;
    this.stats.hits++;
    const kb = CFG.melee.knock * dmg / Math.max(0.5, o.massRatio);
    o.vel.x += dir.x * kb; o.vel.z += dir.z * kb;
    if (from && from.ink) {
      this.fx.splash(at, dir, Math.min(9, 3 + dmg * 0.22), '#121a1c', 0.28, 5);
      this.fx.stain(at.x + dir.x, at.z + dir.z, 0.6 + dmg * 0.04);
    } else {
      this.fx.sparks(at, dir, Math.min(16, 5 + dmg * 0.4), '#ffc27a', 0.2, 9);
      this.fx.flare(at, '#ffb36b', 0.5 + dmg * 0.025);
    }
    this.hitStop = Math.max(this.hitStop, CFG.melee.hitStop * Math.min(2, dmg / 12));
    this.shake = Math.max(this.shake, Math.min(0.5, dmg / 50));
    this.onHit && this.onHit(o, part, dmg, from, at, dir);
  }

  // can an edge of mech o cut the shot whose path is p0->p1 ?
  tryParry(o, s, p0, p1) {
    const A = new THREE.Vector3(), B = new THREE.Vector3(), q = {};
    for (const rec of o.parts.values()) {
      const w = rec.weapon;
      const ghost = !rec.alive && rec.phantom && o.phantomOn;
      if ((!rec.alive && !ghost) || !w || (w.kind !== 'edge' && w.kind !== 'blunt') || !rec.samples) continue;
      if (s.type === 'cannon' && (w.kind !== 'edge' || ghost)) continue;
      o.worldSeg(rec, A, B);
      const d = segSeg(p0, p1, A, B, q);
      if (d > s.r + w.width + CFG.parry.radius) continue;
      const v = rec.samples[Math.round(q.t * (SAMPLES - 1))] || 0;
      const need = s.type === 'cannon' ? CFG.parry.heavySpeed : CFG.parry.speed;
      if (v >= need) { if (ghost) o.ki = Math.max(0, o.ki - CFG.phantom.cutCost); return A.lerp(B, q.t); }
    }
    return null;
  }

  updateShots(dt) {
    for (const s of this.shots) {
      if (s.dead) continue;
      s.life -= dt;
      s.prev.copy(s.pos);
      if (s.type === 'cannon') s.vel.y -= CFG.cannon.gravity * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.type === 'sling') s.mesh.rotation.y += dt * 9;
      else s.mesh.lookAt(_a.copy(s.pos).add(s.vel));
      let done = false;
      if (this.viewOnly) {                       // guest: the host says when a shot ends ('sx'); just fly
        if (s.life <= 0) { s.dead = true; this.scene.remove(s.mesh); s.mesh.material.dispose(); }
        continue;
      }
      for (const o of this.mechs) {
        if (o === s.owner || o.dead || o.team === s.owner.team) continue;
        if (o.pos.distanceTo(s.pos) > 14) continue;
        if (s.type !== 'sling') {
          const cut = this.tryParry(o, s, s.prev, s.pos);
          if (cut) {
            this.stats.cut++;
            if (o.ink) { this.fx.splash(cut, s.vel.clone().normalize().negate(), 8, '#e6fffa', 0.35, 7); this.fx.splash(cut, null, 4, '#121a1c', 0.3, 4); }
            else { this.fx.sparks(cut, s.vel.clone().normalize().negate(), 10, '#7ff5ea', 0.2, 8); }
            this.fx.flare(cut, '#ffffff', 1.2);
            this.onCut && this.onCut(o, s, cut);
            done = true; break;
          }
        }
        let best = null, bt = 2;
        for (const t of o.parts.values()) {
          if (!t.alive) continue;
          const tt = segBox(s.prev, s.pos, t.node.matrixWorld, t.he, s.r);
          if (tt >= 0 && tt < bt) { bt = tt; best = t; }
        }
        if (best) {
          const at = s.prev.clone().lerp(s.pos, bt);
          const dir = s.vel.clone().normalize();
          if (s.type === 'sling') this.gravityHit(o, s, at);
          else {
            this.hit(o, best, s.dmg, at, dir, s.owner);
            if (s.type === 'cannon') this.splashDamage(o, at, s);
          }
          done = true; break;
        }
      }
      if (!done && this.blocks && this.blocks(s.pos)) {
        // hit a map obstacle: shells burst against it, bullets spark, gravity balls fizzle
        if (s.type === 'cannon') { for (const o of this.mechs) if (o !== s.owner && !o.dead && o.team !== s.owner.team && o.pos.distanceTo(s.pos) < 6) this.splashDamage(o, s.pos, s); this.fx.flare(s.pos, '#ffb36b', 4); }
        else this.fx.sparks(s.pos, s.vel.clone().normalize().negate(), s.type === 'sling' ? 6 : 4, s.type === 'sling' ? '#b49bff' : '#ffc27a', 0.15, 5);
        done = true;
      }
      if (!done && s.pos.y < 0) {
        if (s.type === 'cannon') { for (const o of this.mechs) if (o !== s.owner && !o.dead && o.team !== s.owner.team) this.splashDamage(o, s.pos, s); this.fx.flare(s.pos, '#ffb36b', 4); this.fx.sparks(s.pos, new THREE.Vector3(0, 1, 0), 18, '#ffb36b', 0.3, 10); this.fx.stain(s.pos.x, s.pos.z, 1.8, '#050708'); }
        else this.fx.sparks(s.pos.setY(0.1), null, 3, '#ffc27a', 0.15, 4);
        done = true;
      }
      if (done || s.life <= 0) { s.dead = true; this.scene.remove(s.mesh); s.mesh.material.dispose(); this.onShotEnd && this.onShotEnd(s); }
    }
    this.shots = this.shots.filter(s => !s.dead);
  }

  splashDamage(o, at, s) {
    const R = CFG.cannon.splash;
    const c = new THREE.Vector3();
    for (const t of o.parts.values()) {
      if (!t.alive) continue;
      c.setFromMatrixPosition(t.node.matrixWorld);
      const d = c.distanceTo(at);
      if (d < R) o.damage(t, s.dmg * CFG.cannon.splashFrac * (1 - d / R), null);
    }
    this.fx.flare(at, '#ffb36b', 3.5); this.fx.sparks(at, null, 14, '#ffb36b', 0.3, 9);
    this.shake = Math.max(this.shake, 0.4);
  }

  gravityHit(o, s, at) {
    const src = s.owner.pos;
    const dir = new THREE.Vector3().subVectors(s.mode === 'pull' ? src : o.pos, s.mode === 'pull' ? o.pos : src).setY(0);
    const dist = dir.length(); dir.normalize();
    // pull: enough to land in front of the shooter, not on top of it
    let mag = CFG.sling.impulse / Math.sqrt(Math.max(0.5, o.massRatio));
    if (s.mode === 'pull') mag = Math.min(mag, Math.max(0, dist - 3) * 2.2);
    o.vel.addScaledVector(dir, mag);
    o.vel.y += CFG.sling.lift;
    o.onGround = false; o.pos.y += 0.05;
    o.stun = CFG.sling.stun;
    o.player.stop();
    this.fx.flare(at, '#b49bff', 3); this.fx.sparks(at, dir, 16, '#b49bff', 0.3, 7);
    this.onGravity && this.onGravity(o, s);
  }

  // online guest: the host says shot `nid` ended at p (cannon shells burst there)
  endShot(nid, p) {
    const s = this.shots.find(x => x.nid === nid && !x.dead);
    const at = p ? new THREE.Vector3(...p) : s ? s.pos.clone() : null;
    if (s) { s.dead = true; this.scene.remove(s.mesh); s.mesh.material.dispose(); }
    if (!at) return;
    const type = s ? s.type : 'gun';
    if (type === 'cannon') { this.fx.flare(at, '#ffb36b', 4); this.fx.sparks(at, null, 16, '#ffb36b', 0.3, 10); this.shake = Math.max(this.shake, 0.3); }
    else this.fx.sparks(at, null, 3, '#ffc27a', 0.15, 4);
  }

  clear() { for (const s of this.shots) { this.scene.remove(s.mesh); } this.shots = []; this.mechs = []; this.rehit.clear(); }
}
