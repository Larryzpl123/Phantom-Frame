// js/ai.js — an opponent that can drive any build. It reads the build's actions, labels each one
// (melee / ranged / gravity / guard) with how far it reaches, then fights by distance.
//
// How good it is comes from one number, skill (0..1), set by the ladder level (see aiSkill). What skill buys:
//   react   — it sees you with a delay (the strongest knob, same lesson as Skybreak's ladder)
//   dodge   — when you start a swing that can reach it, it dashes out sideways / back, or jumps a sweep
//   punish  — when your swing ends and you're in its range, it hits you before you recover
//   spacing — it fights at the edge of its own reach, outside yours when it out-ranges you
//   flank   — it circles to your off side, away from your weapon arm
//   combo   — it finishes its combos and doesn't mash
//   guard   — it raises a spinning guard against incoming bullets, timed to their arrival
//   aim     — its guns and cannons lead where you're going

import * as THREE from 'three';
import { CFG } from './config.js';
import { describeAction, actionLength } from './actions.js';

const lerp = (a, b, t) => a + (b - a) * t;

export function analyzeBuild(m) {
  const bp = m.bp;
  // reach: farthest edge point from the core in the stance it actually stands in
  let reach = 1.5, side = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), c = m.center();
  for (const rec of m.parts.values()) {
    if (!rec.weapon || (rec.weapon.kind !== 'edge' && rec.weapon.kind !== 'blunt')) continue;
    m.worldSeg(rec, A, B);
    reach = Math.max(reach, Math.hypot(A.x - c.x, A.z - c.z), Math.hypot(B.x - c.x, B.z - c.z));
    side += Math.sign(rec.pt.p[0]);
  }
  const moves = [];
  for (const a of bp.actions || []) {
    if (a.mode === 'idle') continue;
    const d = describeAction(bp, a);
    let kind = 'melee', range = [0, reach * 0.92 + d.lunge * 0.25];
    if (a.ai) { kind = a.ai.kind; range = a.ai.range; }
    else if (d.fires.some(f => f.startsWith('sling:pull'))) { kind = 'sling'; range = [8, 26]; }
    else if (d.fires.some(f => f.startsWith('sling:push'))) { kind = 'sling'; range = [0, 5]; }
    else if (d.fires.includes('gun') || d.fires.includes('cannon')) { kind = 'ranged'; range = [4, 45]; }
    else if (d.spins && a.mode === 'hold') { kind = 'guard'; range = [0, 60]; }
    const sweep = a.keys.some(k => typeof k.yaw === 'number' && Math.abs(k.yaw) > 60);
    // how soon the move is dangerous: the first key with a lunge or a big pose change, roughly
    const startup = (a.keys.find(k => k.lunge) || a.keys[Math.min(1, a.keys.length - 1)]).t;
    moves.push({ a, kind, range, len: d.length, startup, sweep, chain: !!a.next, startable: !!a.key });
  }
  return { reach, side: Math.sign(side) || -1, moves, melee: moves.filter(x => x.kind === 'melee' && x.startable) };
}

// ---------- the ladder ----------
const RANKS = ['见习', '列兵', '士官', '尉官', '校官', '将官', '王牌', '宗师', '传说', '极'];

export function skillAt(lv) {
  const pts = CFG.ladder.skillAt;
  if (lv >= pts[pts.length - 1][0]) return 1;
  for (let i = 1; i < pts.length; i++) {
    const [l1, t1] = pts[i];
    if (lv <= l1) { const [l0, t0] = pts[i - 1]; return t0 + (t1 - t0) * (lv - l0) / (l1 - l0); }
  }
  return 1;
}

// everything about the AI at a ladder level; past skillCap only its HP and damage keep growing
export function aiSkill(level) {
  const C = CFG.ladder;
  const lv = Math.max(1, Math.floor(level));
  const t = skillAt(lv);
  const over = Math.max(0, lv - C.skillCap);
  return {
    level: lv, t, rank: RANKS[Math.min(RANKS.length - 1, Math.floor((lv - 1) / 3))],
    react: lerp(0.55, 0.08, t),       // s of delay on what it sees of you
    think: lerp(0.45, 0.07, t),       // s between decisions
    dodge: lerp(0.05, 0.85, t),       // chance to evade a swing that can reach it
    punish: lerp(0.1, 0.95, t),       // chance to hit you while you recover
    aggro: lerp(0.35, 0.9, t),        // chance to start an attack when one fits
    combo: lerp(0.25, 1.0, t),        // chance to press on for the next move of a combo
    flank: lerp(0.0, 0.9, t),         // how hard it circles to your off side
    guard: lerp(0.15, 0.95, t),       // chance to raise a guard against bullets
    aim: lerp(0.0, 1.0, t),           // how much it leads moving targets
    wobble: lerp(0.5, 0.05, t),       // random sloppiness in movement
    hpMul: 1 + over * C.hpPerLevel,
    dmgMul: (1 + over * C.dmgPerLevel) * lerp(C.lowDmg, 1, t),   // low levels also hit softer
  };
}

// which mech the ladder puts in front of you: one per tier (3 levels each), cycling through the roster order
// opponents by tier: the presets in a rough easy-to-hard order for a human (melee duelists first; kiting gun /
// cannon builds later, they're the hardest to learn against), then any
// other builds on the roster in roster order
export const LADDER_ORDER = ['双锋', '玄岳', '磐岩', '蛛刃', '赤隼', '极点'];
export function ladderFoe(level, names) {
  const tier = Math.floor((Math.max(1, level) - 1) / 3);
  const order = [...LADDER_ORDER.filter(n => names.includes(n)), ...names.filter(n => !LADDER_ORDER.includes(n))];
  return order[tier % order.length];
}

// ---------- the AI pilot ----------
export class AI {
  constructor(me, foe, combat, level = 8) {
    this.me = me; this.foe = foe; this.combat = combat;
    this.level = level;
    this.S = aiSkill(level || 1);
    this.info = analyzeBuild(me);
    this.foeInfo = foe ? analyzeBuild(foe) : { reach: 2, side: -1, moves: [], melee: [] };
    this.t = 0; this.time = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1; this.strafeT = 2;
    this.cool = new Map(); this.holdUntil = 0; this.holdKey = null;
    this.hist = [];                      // what it has seen of the foe, for the reaction delay
    this.evadeT = 0; this.evadeDir = new THREE.Vector3();
    this.lastFoeAct = null; this.foeActEndedAt = -9;
    const meleeR = this.info.melee.length ? Math.max(...this.info.melee.map(x => x.range[1])) : 0;
    this.meleeR = meleeR;
    this.stream = this.info.moves.some(x => x.kind === 'ranged' && x.startable && x.a.mode === 'hold');
    this.intent = { move: new THREE.Vector3(), face: 0, jump: false, hover: false, dash: null };
  }

  setFoe(f) { this.foe = f; this.foeInfo = analyzeBuild(f); this.hist = []; this.lastFoeAct = null; }

  // the foe as it was `react` seconds ago
  perceive() {
    const f = this.foe;
    this.hist.push({ t: this.time, pos: f.pos.clone(), vel: f.vel.clone(), act: f.player.cur ? f.player.cur.id : null, actT: f.player.t, yaw: f.yaw });
    while (this.hist.length > 2 && this.hist[1].t <= this.time - this.S.react) this.hist.shift();
    return this.hist[0];
  }

  update(dt) {
    const me = this.me, foe = this.foe, it = this.intent, S = this.S;
    this.time += dt;
    it.dash = null; it.jump = false;
    if (this.holdKey && this.time > this.holdUntil) { me.player.release(this.holdKey); this.holdKey = null; }
    if (me.dead || foe.dead) { it.move.set(0, 0, 0); return; }
    const seen = this.perceive();

    // track the foe's attacks (as perceived) so we know when one ends
    if (this.lastFoeAct && !seen.act) this.foeActEndedAt = this.time;
    this.lastFoeAct = seen.act;

    const to = new THREE.Vector3().subVectors(seen.pos, me.pos).setY(0);
    const dist = to.length(); to.normalize();
    const side = new THREE.Vector3(to.z, 0, -to.x);
    // squat when the foe is short (tank, quadruped, a torso sitting on the floor) and close enough to swing at
    if (foe.bodySpan && this.meleeR) {
      const top = foe.bodySpan()[1], mine = me.center().y;
      it.crouch = top < mine * 0.75 && dist < this.meleeR + 3;
    }

    // ---- aim: lead the target with ranged builds ----
    let aimAt = seen.pos;
    if (this.info.moves.some(m => m.kind === 'ranged') && S.aim > 0) {
      const tof = dist / CFG.gun.speed;
      aimAt = seen.pos.clone().addScaledVector(seen.vel, tof * S.aim);
    }
    it.face = Math.atan2(aimAt.x - me.pos.x, aimAt.z - me.pos.z);

    // ---- movement every frame ----
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe *= -1; this.strafeT = lerp(1.2, 3.5, Math.random()); }
    // flank: drift to the foe's off side (away from its weapon arm)
    const foeRight = new THREE.Vector3(-Math.cos(seen.yaw), 0, Math.sin(seen.yaw));      // the foe's right (-X in its frame)
    const weaponSide = foeRight.clone().multiplyScalar(-this.foeInfo.side);              // weapon arm side in world
    const offSide = weaponSide.clone().negate();
    const flankSign = Math.sign(side.dot(offSide)) || this.strafe;
    const strafeDir = Math.random() < S.flank ? flankSign : this.strafe;
    // spacing: fight at the edge of our reach; if we out-range the foe, stay outside its reach
    const myR = this.meleeR || CFG.ai.rangedPref, foeR = this.foeInfo.reach;
    const lowHp = me.coreRec.hp / me.coreRec.maxHp < 0.35 && S.t > 0.5;
    let pref = this.meleeR ? myR * 0.85 : CFG.ai.rangedPref;
    if (this.meleeR && myR > foeR + 0.8) pref = Math.max(foeR + 0.9, myR * 0.8);
    // a gun build (a held, streaming gun) that is out-reached up close keeps its distance and shoots
    if (this.stream && myR < foeR + 0.5) pref = CFG.ai.rangedPref;
    if (lowHp) pref += 1.5;
    const err = dist - pref;
    if (this.evadeT > 0) { this.evadeT -= dt; it.move.copy(this.evadeDir); }
    else {
      it.move.copy(to).multiplyScalar(Math.max(-1, Math.min(1, err * 0.6))).addScaledVector(side, strafeDir * lerp(0.35, 0.75, S.t));
      if (S.wobble) it.move.x += (Math.random() - 0.5) * S.wobble, it.move.z += (Math.random() - 0.5) * S.wobble;
      if (it.move.length() > 1) it.move.normalize();
    }
    it.hover = !me.onGround && foe.pos.y > me.pos.y + 1;

    // finish combos: press again in the back half of the move
    const cur = me.player.cur;
    if (cur && cur.next && me.player.t > actionLength(cur) * 0.5 && !this.comboTried) {
      this.comboTried = true;
      if (Math.random() < S.combo && dist < myR * 1.25) me.player.press(cur.key || this.lastKey);
    }
    if (!cur) this.comboTried = false;

    // ---- decisions ----
    this.t -= dt;
    if (this.t > 0 || me.stun > 0) return;
    this.t = S.think * lerp(0.7, 1.3, Math.random());
    const ready = (mv) => (this.cool.get(mv.a.id) || 0) <= this.time;
    const faceErr = Math.abs(Math.atan2(Math.sin(it.face - me.yaw), Math.cos(it.face - me.yaw)));
    const canDash = me.spec.dash > 0 && me.boost >= CFG.thrust.dashCost;

    // 1. bullets coming -> guard
    const guard = this.info.moves.find(x => x.kind === 'guard' && x.startable);
    if (guard && !me.player.busy) {
      const threat = this.combat.shots.find(s => s.owner === foe && s.type !== 'sling' && s.pos.distanceTo(me.pos) < 22 &&
        s.vel.clone().normalize().dot(new THREE.Vector3().subVectors(me.pos, s.pos).normalize()) > 0.9);
      if (threat && Math.random() < S.guard) { this.press(guard.a.key, 0.45 + s2a(threat, me)); return; }
    }

    // 2. the foe is swinging at us (as perceived) and we're inside its reach -> evade
    if (seen.act && dist < foeR + 1.2 && !me.player.busy) {
      const fm = this.foeInfo.moves.find(m => m.a.id === seen.act);
      if (fm && fm.kind === 'melee' && seen.actT < fm.startup + 0.15 && Math.random() < S.dodge) {
        if (fm.sweep && me.spec.jump > 0 && Math.random() < 0.5) { it.jump = true; return; }
        const dir = fm.sweep ? to.clone().negate() : side.clone().multiplyScalar(flankSign).addScaledVector(to, -0.3).normalize();
        if (canDash) it.dash = dir; else { this.evadeT = 0.45; this.evadeDir.copy(dir); }
        return;
      }
    }

    // 3. punish: the foe just finished swinging and we can reach
    const meleeFit = this.info.melee.filter(m => ready(m) && dist <= m.range[1] && dist >= m.range[0]);
    if (!me.player.busy && meleeFit.length && this.time - this.foeActEndedAt < 0.5 && Math.random() < S.punish && faceErr < 0.6) {
      const mv = meleeFit.reduce((a, b) => (b.startup < a.startup ? b : a));
      this.use(mv); return;
    }

    // 4. pick a move that fits the distance
    if (!me.player.busy && Math.random() < S.aggro) {
      const fits = this.info.moves.filter(x => x.startable && x.kind !== 'guard' && ready(x) && dist >= x.range[0] && dist <= x.range[1]);
      if (fits.length && (faceErr < 0.5 || fits[0].kind !== 'melee')) {
        // prefer the move whose reach is just enough (skilled), or any (unskilled)
        fits.sort((a, b) => (a.range[1] - dist) - (b.range[1] - dist));
        const mv = Math.random() < S.t ? fits[0] : fits[(Math.random() * fits.length) | 0];
        this.use(mv); return;
      }
    }

    // 5. close the gap / reset the gap
    if (canDash && err > 4 && dist < 30 && Math.random() < lerp(0.15, 0.5, S.t)) it.dash = to.clone();
    else if (canDash && err < -2.5 && Math.random() < lerp(0.05, 0.4, S.t)) it.dash = to.clone().negate().addScaledVector(side, strafeDir).normalize();
    else if (Math.random() < 0.03 && me.onGround) it.jump = true;
  }

  use(mv) {
    // a held gun is a stream: hold it longer and come back to it sooner than a one-shot cannon
    const stream = mv.kind === 'ranged' && mv.a.mode === 'hold';
    this.press(mv.a.key, mv.a.mode === 'hold' ? (stream ? lerp(1.0, 1.8, this.S.t) : 0.8) : 0);
    const cd = mv.kind === 'melee' ? lerp(0.9, 0.25, this.S.t) : mv.kind === 'sling' ? 4 : stream ? lerp(1.4, 0.5, this.S.t) : lerp(2.2, 1.0, this.S.t);
    this.cool.set(mv.a.id, this.time + cd + Math.random() * 0.4);
    this.comboTried = false;
  }

  press(key, hold) {
    if (!key) return;
    this.me.player.press(key);
    this.lastKey = key;
    if (hold) { this.holdKey = key; this.holdUntil = this.time + hold; }
    else this.me.player.release(key);
  }
}

// seconds until a shot reaches us
function s2a(shot, me) { return Math.min(1.2, shot.pos.distanceTo(me.pos) / Math.max(1, shot.vel.length())); }
