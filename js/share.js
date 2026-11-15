// js/share.js — mechs as text, and the anonymous form used by the online ladder board.
//
// Share code: 'PF1.' + base64url(deflate(JSON)) of the whole build (parts, colours, actions, names). It is the build
// itself, not a lookup key: nothing is stored anywhere, you paste it to a friend and they paste it into their hangar.
// About 1.3k-2.8k characters for the presets (Skybreak planes are under 1.5k: a mech has more parts and all its moves).
//
// Anonymous form (for the ladder board, see js/board.js): no free text at all, so nothing typed by a player can reach
// the board. The mech name and the move names are blanked and move ids become a0, a1, ... The server checks the
// same rules (worker.js mechProblem) and refuses anything else.

import { sanitize } from './blueprint.js';

const PREFIX = 'PF1.';
const R3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
function round(o) {
  if (Array.isArray(o)) return o.map(round);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = round(v); return r; }
  return R3(o);
}

const b64url = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (str) => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

export async function toShareCode(bp) {
  const json = JSON.stringify(round(sanitize(bp)));
  return PREFIX + b64url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}

export async function fromShareCode(text) {
  const m = String(text || '').trim().match(/PF1\.([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('不是分享码（应该以 PF1. 开头）');
  let json;
  try { json = new TextDecoder().decode(await pipe(unb64url(m[1]), new DecompressionStream('deflate-raw'))); }
  catch { throw new Error('分享码不完整或被改坏了'); }
  return sanitize(JSON.parse(json));
}

// the build with every bit of free text taken out; null if it uses something the board can't take (an imported model)
export function anonymize(bp) {
  const b = round(sanitize(bp));
  if (b.parts.some(p => p.type === 'mod')) return null;
  const ids = new Map(b.actions.map((a, i) => [a.id, 'a' + i]));
  b.name = '';
  b.actions = b.actions.map(a => ({ ...a, id: ids.get(a.id), name: '', next: a.next && ids.has(a.next) ? ids.get(a.next) : '' }));
  return b;
}

// a board mech back into something the hangar shows nicely: a name and numbered moves
export function fromBoard(raw, label) {
  const b = sanitize(raw);
  b.name = label;
  b.actions.forEach((a, i) => { a.name = a.mode === 'idle' ? '待机' : `动作${i}`; });
  return b;
}
