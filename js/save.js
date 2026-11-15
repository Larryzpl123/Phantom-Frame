// js/save.js — where builds live.
//   1. The browser's localStorage: 保存 in the hangar always goes here (locally and on GitHub Pages alike).
//      Note: each website keeps its own: builds saved at localhost:8770 don't show up on github.io (use a share code).
//   2. Mech folders next to the game: <name>/<name>.json. The presets ship this way (极点/极点.json ...); with the
//      local server (start.command) the hangar can also write one (存到文件夹).
//   3. Built-in presets in presets.js, if no folder of that name exists.
// A browser save beats a folder beats a built-in preset of the same name (your latest edit wins).

import { sanitize, clone } from './blueprint.js';
import { PRESETS } from './presets.js';

const KEY = 'jidian.builds.v1';
let disk = new Map();          // name -> sanitized blueprint
export let serverOK = false;   // the mech list loaded (local server, or the static api/mechs on GitHub Pages)
export let canWrite = false;   // the local server is there and can write folders (server.py marks its answer)

function readAll() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}
function writeAll(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch { return false; } }

export async function refreshDisk() {
  try {
    const r = await fetch('api/mechs', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    canWrite = r.headers.get('X-Mech-Server') === '1';
    const list = await r.json();
    const m = new Map();
    for (const it of list) {
      try { const j = await (await fetch(encodeURI(it.path), { cache: 'no-store' })).json(); m.set(it.name, sanitize(j)); }
      catch (e) { console.warn('skip mech', it.name, e); }
    }
    disk = m; serverOK = true;
  } catch { serverOK = false; canWrite = false; }
}

export function loadSaved(name) {
  const raw = readAll()[name];
  if (!raw) return null;
  try { return sanitize(raw); } catch { return null; }
}

// 保存: into this browser. returns true / false
export function saveBuild(bp) { const o = readAll(); o[bp.name] = clone(bp); return writeAll(o); }
export function deleteSaved(name) { const o = readAll(); delete o[name]; return writeAll(o); }

// 存到文件夹: only with the local server (start.command). returns true / false
export async function saveToFolder(bp) {
  if (!canWrite) return false;
  try {
    const r = await fetch('api/mechs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mech': '1' }, body: JSON.stringify(bp) });
    if (r.ok) { disk.set(bp.name, sanitize(clone(bp))); return true; }
  } catch { /* offline */ }
  return false;
}

// everything that can be picked; a browser save beats a folder beats a built-in preset of the same name
export function roster() {
  const out = [], seen = new Set();
  const saved = readAll();
  for (const name of Object.keys(saved)) { out.push({ id: 'saved:' + name, name, src: 'local', get: () => loadSaved(name) }); seen.add(name); }
  for (const [name, bp] of disk) if (!seen.has(name)) { out.push({ id: 'disk:' + name, name, src: 'folder', get: () => clone(bp) }); seen.add(name); }
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
// the board knows where this pilot really is (another device, or levels cleared before the board existed)
export function ladderSet(unlocked) {
  const p = ladderProgress();
  p.unlocked = Math.max(1, unlocked | 0); p.best = Math.max(0, p.unlocked - 1);
  try { localStorage.setItem(LKEY, JSON.stringify(p)); } catch { /* */ }
  return p;
}
export function ladderBeat(level) {
  const p = ladderProgress();
  p.best = Math.max(p.best, level); p.unlocked = Math.max(p.unlocked, level + 1);
  try { localStorage.setItem(LKEY, JSON.stringify(p)); } catch { /* private window: progress lives for this session only */ }
  return p;
}
