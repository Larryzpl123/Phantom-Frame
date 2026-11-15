// js/save.js — where builds live.
//   1. Mech folders next to the game: <name>/<name>.json (via the local server, see server.py). 极点 lives in 极点/.
//   2. The browser's localStorage, as a fallback when the game isn't running through start.command.
//   3. Built-in presets in presets.js, used only if no folder with that name exists.

import { sanitize, clone } from './blueprint.js';
import { PRESETS } from './presets.js';

const KEY = 'jidian.builds.v1';
let disk = new Map();          // name -> sanitized blueprint
export let serverOK = false;

function readAll() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}
function writeAll(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch { return false; } }

export async function refreshDisk() {
  try {
    const r = await fetch('api/mechs', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const list = await r.json();
    const m = new Map();
    for (const it of list) {
      try { const j = await (await fetch(encodeURI(it.path), { cache: 'no-store' })).json(); m.set(it.name, sanitize(j)); }
      catch (e) { console.warn('skip mech', it.name, e); }
    }
    disk = m; serverOK = true;
  } catch { serverOK = false; }
}

export function loadSaved(name) {
  const raw = readAll()[name];
  if (!raw) return null;
  try { return sanitize(raw); } catch { return null; }
}

// returns 'disk' | 'local' | null
export async function saveBuild(bp) {
  const o = readAll(); o[bp.name] = clone(bp); const local = writeAll(o);
  if (serverOK) {
    try {
      const r = await fetch('api/mechs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mech': '1' }, body: JSON.stringify(bp) });
      if (r.ok) { disk.set(bp.name, sanitize(clone(bp))); return 'disk'; }
    } catch { /* fall through */ }
  }
  return local ? 'local' : null;
}

// everything that can be picked; a folder beats a local save beats a built-in preset of the same name
export function roster() {
  const out = [], seen = new Set();
  for (const [name, bp] of disk) { out.push({ id: 'disk:' + name, name, src: 'folder', get: () => clone(bp) }); seen.add(name); }
  const saved = readAll();
  for (const name of Object.keys(saved)) if (!seen.has(name)) { out.push({ id: 'saved:' + name, name, src: 'local', get: () => loadSaved(name) }); seen.add(name); }
  for (const [id, f] of Object.entries(PRESETS)) {
    const name = f().name;
    if (!seen.has(name)) { out.push({ id: 'preset:' + id, name, src: 'preset', get: () => PRESETS[id]() }); seen.add(name); }
  }
  return out;
}

export function exportFile(bp) {
  const blob = new Blob([JSON.stringify(bp, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (bp.name || 'mech') + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function importFile(file) { return file.text().then(t => sanitize(JSON.parse(t))); }

// ---------- AI ladder progress (per browser) ----------
const LKEY = 'jidian.ladder.v1';
export function ladderProgress() {
  try { const o = JSON.parse(localStorage.getItem(LKEY) || '{}'); return { unlocked: Math.max(1, o.unlocked | 0 || 1), best: o.best | 0 }; }
  catch { return { unlocked: 1, best: 0 }; }
}
export function ladderBeat(level) {
  const p = ladderProgress();
  p.best = Math.max(p.best, level); p.unlocked = Math.max(p.unlocked, level + 1);
  try { localStorage.setItem(LKEY, JSON.stringify(p)); } catch { /* private window: progress lives for this session only */ }
  return p;
}
