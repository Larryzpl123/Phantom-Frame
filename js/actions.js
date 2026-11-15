// js/actions.js — keyframed joint actions, combos, and the joint servo. Pure logic, no rendering.
//
// Action: { id, name, key, mode, next, window, keys:[{ t, j:{jointId: deg | {spin: rad/s}}, ev:[{part, mode}], lunge }] }
//   mode 'once' : plays through, then back to the idle stance
//   mode 'hold' : plays to the last key and stays there while the key is held; events on the last key repeat
//                 (a gun keeps firing, a spin joint keeps spinning)
//   mode 'idle' : the stance used whenever nothing else is playing (one per build)
//   next        : combo — press the action's key again while it plays and `next` starts right after it
//
// Joints are servos: each frame the angle moves toward the target at most omega*dt (omega from parts.js,
// i.e. torque / carried inertia). So the keyframe timing is what you ask for; heavy limbs arrive late.

const DEG = Math.PI / 180;
export const actionLength = (a) => a.keys.length ? a.keys[a.keys.length - 1].t : 0;
const smooth = (x) => x * x * (3 - 2 * x);

// target for one joint at time t inside an action; returns undefined if the action doesn't drive that joint
export function sampleJoint(action, jid, t) {
  const ks = action.keys;
  let prev = null, next = null;
  for (const k of ks) {
    if (!(jid in k.j)) continue;
    if (k.t <= t) prev = k; else { next = k; break; }
  }
  if (!prev && !next) return undefined;
  if (!prev) prev = next;
  const a = prev.j[jid];
  if (typeof a === 'object') return { spin: a.spin };
  if (!next || typeof next.j[jid] === 'object') return a * DEG;
  const b = next.j[jid];
  const u = smooth(Math.min(1, Math.max(0, (t - prev.t) / Math.max(1e-4, next.t - prev.t))));
  return (a + (b - a) * u) * DEG;
}

// body yaw offset (deg in data, rad out) for spinning/sweeping the whole mech; keys without `yaw` are skipped
export function sampleYaw(action, t) {
  let prev = null, next = null;
  for (const k of action.keys) {
    if (k.yaw === undefined) continue;
    if (k.t <= t) prev = k; else { next = k; break; }
  }
  if (!prev && !next) return 0;
  if (!prev) return next.yaw * DEG;
  if (!next) return prev.yaw * DEG;
  const u = smooth(Math.min(1, Math.max(0, (t - prev.t) / Math.max(1e-4, next.t - prev.t))));
  return (prev.yaw + (next.yaw - prev.yaw) * u) * DEG;
}

export class ActionPlayer {
  constructor(bp) {
    this.actions = new Map((bp.actions || []).map(a => [a.id, a]));
    this.idle = (bp.actions || []).find(a => a.mode === 'idle') || null;
    this.cur = null; this.t = 0; this.queued = null; this.held = new Set();
    this.events = [];           // filled by update(): [{part, mode, action}]
    this.lunges = [];           // forward speed kicks
    this.busy = false;
  }

  // a key can have two moves: the normal one and a squatting one (action.low, played while C is held)
  byKey(code) {
    let any = null;
    for (const a of this.actions.values()) {
      if (a.key !== code || a.mode === 'idle') continue;
      if (!!a.low === !!this.low) return a;
      if (!any && !a.low) any = a;
    }
    return any;
  }

  press(code) {
    this.held.add(code);
    if (this.cur) {
      if (this.cur.key === code && this.cur.next && this.actions.has(this.cur.next)) this.queued = this.cur.next;
      else if (!this.cur.next && this.cur.key === code && this.cur.mode === 'once' && this.t > actionLength(this.cur) * 0.7)
        this.queued = this.cur.id;                        // mash to repeat a single move
      return;
    }
    const a = this.byKey(code);
    if (a) this.start(a.id);
  }
  release(code) { this.held.delete(code); }

  start(id) {
    const a = this.actions.get(id);
    if (!a) return false;
    this.cur = a; this.t = 0; this.queued = null; this._fired = new Set();
    return true;
  }
  stop() { this.cur = null; this.queued = null; }

  // advance; returns nothing, fills this.events and this.lunges
  update(dt) {
    this.events.length = 0; this.lunges.length = 0;
    const a = this.cur;
    if (!a) { this.busy = false; return; }
    const L = actionLength(a);
    const t0 = this.t;
    this.t += dt;
    const holding = a.mode === 'hold' && this.held.has(a.key);
    if (a.mode === 'hold' && holding && this.t > L) this.t = L;
    for (let i = 0; i < a.keys.length; i++) {
      const k = a.keys[i];
      const last = i === a.keys.length - 1;
      const crossed = (k.t > t0 || (t0 === 0 && k.t === 0)) && k.t <= this.t && !this._fired.has(i);
      const repeat = holding && last && this.t >= L;
      if (crossed || repeat) {
        if (crossed) this._fired.add(i);
        if (k.ev) for (const e of k.ev) this.events.push({ part: e.part, mode: e.mode, action: a.id, repeat: !crossed });
        if (crossed && k.lunge) this.lunges.push(k.lunge);
      }
    }
    if (this.t >= L && !holding) {
      if (a.mode === 'hold' || !this.queued) { this.cur = null; this.busy = false; return; }
      const q = this.queued; this.start(q);
    }
    this.busy = !!this.cur;
  }

  yawOffset() { return this.cur ? sampleYaw(this.cur, this.t) : 0; }

  // target for joint jid right now: number (rad), {spin}, or undefined (no one drives it)
  target(jid) {
    if (this.cur) { const v = sampleJoint(this.cur, jid, this.t); if (v !== undefined) return v; }
    if (this.idle) { const v = sampleJoint(this.idle, jid, actionLength(this.idle)); if (v !== undefined) return v; }
    return undefined;
  }
}

// One servo step. state: {a (rad), w (spin rad/s)}. lim in degrees. Returns the new angle.
export function servo(state, target, omega, lim, dt, spinAccel) {
  if (target && typeof target === 'object') {                 // continuous spin
    const want = target.spin;
    const dw = want - state.w;
    state.w += Math.sign(dw) * Math.min(Math.abs(dw), spinAccel * dt);
    state.w = Math.max(-omega * 1.6, Math.min(omega * 1.6, state.w));
    state.a += state.w * dt;
    return state.a;
  }
  let goal = target === undefined ? 0 : target;
  if (Math.abs(state.w) > 0.01 || Math.abs(state.a) > Math.PI * 2.2) {
    // coming out of a spin: carry on to the nearest equivalent angle instead of unwinding
    const turns = Math.round((state.a - goal) / (Math.PI * 2));
    goal += turns * Math.PI * 2;
    state.w *= Math.max(0, 1 - 6 * dt);
    if (Math.abs(state.w) < 0.5) state.w = 0;
  }
  if (lim && !(Math.abs(state.a) > Math.PI * 2.2)) goal = Math.max(lim[0] * DEG, Math.min(lim[1] * DEG, goal));
  const d = goal - state.a;
  const step = omega * dt;
  state.a += Math.abs(d) <= step ? d : Math.sign(d) * step;
  if (Math.abs(state.a) > Math.PI * 40) state.a %= Math.PI * 2;
  return state.a;
}

// Dry-run an action on a pure angle model to label it for the AI: how long it is, what it fires, whether it spins.
export function describeAction(bp, action) {
  const kinds = new Set();
  let spins = false;
  const parts = new Map(bp.parts.map(p => [p.id, p]));
  for (const k of action.keys) {
    for (const v of Object.values(k.j)) if (typeof v === 'object') spins = true;
    for (const e of k.ev || []) { const p = parts.get(e.part); if (p) kinds.add(p.type === 'sling' ? 'sling:' + e.mode : p.type); }
  }
  return { length: actionLength(action), fires: [...kinds], spins, lunge: action.keys.reduce((m, k) => Math.max(m, k.lunge || 0), 0) };
}
