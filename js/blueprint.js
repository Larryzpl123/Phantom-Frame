// js/blueprint.js — blueprint operations. Pure: every op returns a new blueprint and never mutates its input,
// so undo is just a stack of old blueprints.
//
// Blueprint: { v:1, name, palette:{slot:'#hex'}, parts:[part...], actions:[action...] }
// Part:      see parts.js. Mirror partners point at each other with `m`.
// Action:    see actions.js.

import { PARTS, subtree, children } from './parts.js';
import { DEFAULT_PALETTE, CFG } from './config.js';

export const clone = (o) => JSON.parse(JSON.stringify(o));
const r3 = (a) => a.map(x => Math.round(x * 1000) / 1000);

export function nextId(bp) { return bp.parts.reduce((m, p) => Math.max(m, p.id), 0) + 1; }

export function mirrorXform(p, r, s) {
  return { p: [-p[0], p[1], p[2]], r: [r[0], -r[1], -r[2]], s: [-s[0], s[1], s[2]] };
}

export function makePart(type, parent, p, r = [0, 0, 0], s = [1, 1, 1], extra = {}) {
  const P = PARTS[type];
  const pt = { id: 0, type, parent, p: r3(p), r: r3(r), s: r3(s), c: P.color };
  if (P.rd != null) pt.rd = P.rd;
  if (P.variants) pt.v = P.variants[0];
  if (type === 'joint') pt.lim = [-160, 160];
  return Object.assign(pt, extra);
}

// Add a part (and its mirror image if mirror is on and the part is off the centre plane). Returns {bp, ids}.
export function addPart(bp, part, mirror = false) {
  const out = clone(bp);
  const id = nextId(out);
  const a = Object.assign(clone(part), { id });
  out.parts.push(a);
  const ids = [id];
  if (mirror && Math.abs(a.p[0]) > 0.02) {
    const parent = out.parts.find(q => q.id === a.parent);
    const mParent = parent && parent.m != null ? parent.m : a.parent;
    const x = mirrorXform(a.p, a.r, a.s);
    const b = Object.assign(clone(a), { id: id + 1, parent: mParent }, x);
    delete b.grip;
    a.m = b.id; b.m = a.id;
    out.parts.push(b);
    ids.push(b.id);
  }
  return { bp: out, ids };
}

// Remove a part and everything attached to it (and the mirror partner's subtree). The core can't be removed.
export function removePart(bp, id) {
  const pt = bp.parts.find(p => p.id === id);
  if (!pt || pt.type === 'core') return bp;
  const ch = children(bp);
  const kill = new Set(subtree(bp, id, ch));
  if (pt.m != null && bp.parts.some(p => p.id === pt.m)) for (const k of subtree(bp, pt.m, ch)) kill.add(k);
  const out = clone(bp);
  out.parts = out.parts.filter(p => !kill.has(p.id));
  for (const p of out.parts) { if (p.m != null && kill.has(p.m)) delete p.m; if (p.grip && kill.has(p.grip.part)) delete p.grip; }
  // actions keep working; keys that mention removed joints/weapons are dropped
  for (const a of out.actions || []) for (const k of a.keys) {
    for (const j of Object.keys(k.j || {})) if (kill.has(+j)) delete k.j[j];
    if (k.ev) k.ev = k.ev.filter(e => !kill.has(e.part));
  }
  return out;
}

// Change fields of a part. If it has a mirror partner the partner gets the mirrored change.
export function updatePart(bp, id, patch) {
  const out = clone(bp);
  const pt = out.parts.find(p => p.id === id);
  if (!pt) return bp;
  Object.assign(pt, clone(patch));
  for (const k of ['p', 'r', 's']) if (pt[k]) pt[k] = r3(pt[k]);
  const mate = pt.m != null ? out.parts.find(p => p.id === pt.m) : null;
  if (mate) {
    const x = mirrorXform(pt.p, pt.r, pt.s);
    for (const k of Object.keys(patch)) {
      if (k === 'p' || k === 'r' || k === 's') mate[k] = r3(x[k]);
      else if (k !== 'parent' && k !== 'm' && k !== 'id' && k !== 'grip') mate[k] = clone(patch[k]);
    }
  }
  return out;
}

export function unlinkMirror(bp, id) {
  const out = clone(bp);
  const pt = out.parts.find(p => p.id === id);
  if (!pt || pt.m == null) return bp;
  const mate = out.parts.find(p => p.id === pt.m);
  delete pt.m; if (mate) delete mate.m;
  return out;
}

export function emptyBlueprint(name = '新机体') {
  return {
    v: 1, name, palette: { ...DEFAULT_PALETTE },
    parts: [Object.assign(makePart('core', null, [0, 1.2, 0]), { id: 1 })],
    actions: [],
  };
}

// ---------- validation (imported files are untrusted) ----------
const num = (x, lo, hi, d = 0) => (typeof x === 'number' && isFinite(x)) ? Math.min(hi, Math.max(lo, x)) : d;
const vec = (a, lo, hi, d) => (Array.isArray(a) && a.length === 3) ? a.map((x, i) => num(x, lo, hi, d[i])) : d.slice();
const hex = (s, d) => (typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)) ? s : d;

export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.parts)) throw new Error('不是机体文件');
  const bp = { v: 1, name: String(raw.name || '导入机体').slice(0, 24), style: raw.style === 'ink' ? 'ink' : 'tech', palette: { ...DEFAULT_PALETTE }, parts: [], actions: [] };
  if (raw.palette && typeof raw.palette === 'object') for (const k of Object.keys(DEFAULT_PALETTE)) bp.palette[k] = hex(raw.palette[k], DEFAULT_PALETTE[k]);
  const ids = new Set();
  for (const q of raw.parts.slice(0, CFG.build.maxParts)) {
    if (!q || (!PARTS[q.type] && q.type !== 'mod')) continue;
    const id = Math.floor(num(q.id, 1, 1e6, 0));
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const P = PARTS[q.type] || {};
    const pt = {
      id, type: q.type, parent: q.parent == null ? null : Math.floor(num(q.parent, 0, 1e6, 0)),
      p: vec(q.p, -60, 60, [0, 0, 0]), r: vec(q.r, -720, 720, [0, 0, 0]), s: vec(q.s, -12, 12, [1, 1, 1]),
      c: typeof q.c === 'string' && (q.c in DEFAULT_PALETTE) ? q.c : (P.color || 'armor'),
    };
    pt.s = pt.s.map(x => (Math.abs(x) < 0.05 ? (x < 0 ? -0.05 : 0.05) : x));
    if (P.rd != null) pt.rd = num(q.rd, 0, 1, P.rd);
    if (q.tp) pt.tp = num(q.tp, -0.9, 0.9, 0);
    if (q.tz) pt.tz = num(q.tz, -0.9, 0.9, 0);
    if (q.lf) pt.lf = num(q.lf, 0, 1, 0);
    if (q.bd) pt.bd = num(q.bd, -1, 1, 0);
    if (P.variants) pt.v = P.variants.includes(q.v) ? q.v : P.variants[0];
    if (q.type === 'joint') pt.lim = Array.isArray(q.lim) ? [num(q.lim[0], -360, 0, -160), num(q.lim[1], 0, 360, 160)] : [-160, 160];
    if (q.m != null) pt.m = Math.floor(num(q.m, 0, 1e6, 0));
    if (q.grip && typeof q.grip === 'object') pt.grip = { part: Math.floor(num(q.grip.part, 0, 1e6, 0)), at: num(q.grip.at, -60, 60, 0) };
    if (q.type === 'mod') { pt.mod = String(q.mod || '').slice(0, 64); pt.role = ['block', 'blade', 'pole'].includes(q.role) ? q.role : 'block'; }
    bp.parts.push(pt);
  }
  // exactly one root (the core); parents must exist; no cycles
  const map = new Map(bp.parts.map(p => [p.id, p]));
  const cores = bp.parts.filter(p => p.type === 'core');
  if (cores.length !== 1) throw new Error('机体必须恰好有一个核心');
  cores[0].parent = null;
  bp.parts = bp.parts.filter(p => p.type === 'core' || (p.parent != null && map.has(p.parent)));
  const ok = new Set([cores[0].id]);
  let grew = true;
  while (grew) { grew = false; for (const p of bp.parts) if (!ok.has(p.id) && ok.has(p.parent)) { ok.add(p.id); grew = true; } }
  bp.parts = bp.parts.filter(p => ok.has(p.id));
  for (const p of bp.parts) { if (p.m != null && !ok.has(p.m)) delete p.m; if (p.grip && (!ok.has(p.grip.part) || p.grip.part === p.id)) delete p.grip; }
  // actions
  const KEYS = /^(Mouse0|Mouse2|Key[A-Z]|Digit[0-9])$/;
  if (Array.isArray(raw.actions)) for (const a of raw.actions.slice(0, 24)) {
    if (!a || !Array.isArray(a.keys)) continue;
    const act = {
      id: String(a.id || 'a' + bp.actions.length).slice(0, 24), name: String(a.name || '动作').slice(0, 12),
      key: typeof a.key === 'string' && KEYS.test(a.key) ? a.key : '',
      mode: ['once', 'hold', 'idle'].includes(a.mode) ? a.mode : 'once',
      next: a.next ? String(a.next).slice(0, 24) : '', window: num(a.window, 0, 2, 0.35), keys: [],
    };
    if (a.grip === false) act.grip = false;
    if (a.ai && ['melee', 'ranged', 'sling', 'guard'].includes(a.ai.kind) && Array.isArray(a.ai.range)) act.ai = { kind: a.ai.kind, range: [num(a.ai.range[0], 0, 100, 0), num(a.ai.range[1], 0, 100, 10)] };
    for (const k of a.keys.slice(0, 40)) {
      const key = { t: num(k && k.t, 0, 10, 0), j: {} };
      if (k && k.j && typeof k.j === 'object') for (const [jid, ang] of Object.entries(k.j)) {
        if (!ok.has(+jid)) continue;
        if (typeof ang === 'number') key.j[jid] = num(ang, -3600, 3600, 0);
        else if (ang && typeof ang.spin === 'number') key.j[jid] = { spin: num(ang.spin, -60, 60, 0) };
      }
      if (k && Array.isArray(k.ev)) key.ev = k.ev.filter(e => e && ok.has(e.part)).slice(0, 8)
        .map(e => ({ part: e.part, mode: e.mode === 'push' ? 'push' : 'pull' }));
      if (k && k.lunge) key.lunge = num(k.lunge, -40, 40, 0);
      if (k && typeof k.yaw === 'number') key.yaw = num(k.yaw, -1080, 1080, 0);
      act.keys.push(key);
    }
    act.keys.sort((x, y) => x.t - y.t);
    if (act.keys.length) bp.actions.push(act);
  }
  return bp;
}
