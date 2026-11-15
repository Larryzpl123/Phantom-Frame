// js/main.js — boot, menu, mode switching (menu / battle / hangar), main loop.

import * as THREE from 'three';
import { Battle } from './battle.js';
import { PRESETS } from './presets.js';
import { Mech } from './mech.js';
import { buildTechEnvironment } from './tech.js';
import { roster, refreshDisk, ladderProgress, ladderBeat } from './save.js';
import { aiSkill, ladderFoe } from './ai.js';
import { MAPS, MAP_KEYS } from './maps.js';
import { Hangar } from './hangar.js';

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: $('view') });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const hud = {
  root: $('hud'), nameA: $('nameA'), nameB: $('nameB'), hpA: $('hpA'), hpB: $('hpB'), intA: $('intA'), intB: $('intB'),
  boost: $('boost'), heat: $('heat'), heatWrap: $('heatWrap'), ki: $('ki'), kiWrap: $('kiWrap'), kiLabel: $('kiLabel'), moves: $('moves'), flash: $('flash'),
  result: $('result'), resultText: $('resultText'), resultSub: $('resultSub'), again: $('again'), round: $('round'), fighters: $('fighters'),
};

let mode = 'menu';            // 'menu' | 'battle' | 'hangar'
let battle = null, hangar = null, returnTo = 'menu', lastFight = null;
let pick = { me: null, foe: null };

// ---------- menu ----------
const menuScene = new THREE.Scene();
const menuEnv = buildTechEnvironment(menuScene, renderer);
menuEnv.userData.sun.target.position.set(0, 0, 0);
const menuCam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 600);
let showcase = null;
const still = { move: new THREE.Vector3(), face: null, jump: false, hover: false, dash: null };

function entry(id) { return roster().find(r => r.id === id) || roster()[0]; }
const byName = (n) => (roster().find(r => r.name === n) || roster()[0]).id;

function setShowcase(bp) {
  if (showcase) showcase.dispose();
  showcase = new Mech(bp, menuScene);
  window.__showcase = showcase;
  const h = $('heroName');
  h.textContent = bp.name;
  h.className = bp.style === 'ink' ? 'ink' : 'tech';
  const st = showcase.stats;
  const weapons = [...new Set(st.weapons.map(id => bp.parts.find(p => p.id === id).type))];
  const NAMES = { pole: '枪杆', blade: '刀', sword: '剑', gun: '火枪', cannon: '炮', sling: '引力弹弓' };
  $('heroDesc').textContent = `${bp.style === 'ink' ? '水墨' : '科技'}机 · ${st.parts} 零件 · 负载 ${st.load.toFixed(0)}/${st.budget.toFixed(0)} · ${weapons.map(w => NAMES[w]).join(' / ') || '无武器'}`;
}

function renderRoster() {
  const list = roster();
  for (const [elId, key] of [['rosterMe', 'me'], ['rosterFoe', 'foe']]) {
    const el = $(elId); el.innerHTML = '';
    for (const r of list) {
      const b = document.createElement('button');
      const bp = r.get();
      b.setAttribute('aria-pressed', pick[key] === r.id ? 'true' : 'false');
      b.innerHTML = `<b class="${bp && bp.style === 'ink' ? 'ink' : ''}"></b><small>${{ folder: '文件夹', local: '浏览器存档', preset: '内置' }[r.src]}</small>`;
      b.querySelector('b').textContent = r.name;
      b.addEventListener('click', () => { pick[key] = r.id; renderRoster(); if (key === 'me') setShowcase(entry(pick.me).get()); });
      el.appendChild(b);
    }
  }
}

function showMenu() {
  mode = 'menu';
  if (battle) { battle.dispose(); battle = null; }
  if (hangar) hangar.hide();
  $('menu').hidden = false;
  if (!roster().some(r => r.id === pick.me)) pick.me = byName('极点');
  if (!roster().some(r => r.id === pick.foe)) pick.foe = byName('玄岳');
  renderRoster();
  renderLadderButton();
  setShowcase(entry(pick.me).get());
}

// ---------- battle ----------
// opponents for multi-mech modes: the picked foe first, then the rest of the roster, round-robin
function opponents(n) {
  const list = roster().filter(r => r.id !== pick.me);
  const first = entry(pick.foe);
  const pool = [first, ...list.filter(r => r.id !== first.id)];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length].get());
}

function matchOpts() {
  const mode = $('mode').value, lv = +$('level').value, map = $('map').value;
  const me = entry(pick.me).get();
  if (mode === 'duel') return { mode: 'duel', map, fighters: [{ bp: me, team: 0 }, { bp: entry(pick.foe).get(), team: 1, level: lv }] };
  if (mode === 'ffa') return { mode: 'ffa', map, fighters: [{ bp: me }, ...opponents(3).map(bp => ({ bp, level: lv }))] };
  const n = mode === 'team3' ? 3 : 2;
  const mates = roster().filter(r => r.id !== pick.me);
  const allies = Array.from({ length: n - 1 }, (_, i) => (mates[i % mates.length] || entry(pick.me)).get());
  return { mode: 'team', map, fighters: [{ bp: me, team: 0 }, ...allies.map(bp => ({ bp, team: 0, level: lv })), ...opponents(n).map(bp => ({ bp, team: 1, level: lv }))] };
}

function ladderOpts(level) {
  const names = roster().map(r => r.name);
  const foeName = ladderFoe(level, names);
  const foe = roster().find(r => r.name === foeName) || entry(pick.foe);
  return {
    mode: 'duel', map: MAP_KEYS[(level - 1) % MAP_KEYS.length], rounds: CFG_LADDER_ROUNDS, ladder: { level },
    fighters: [{ bp: entry(pick.me).get(), team: 0 }, { bp: foe.get(), team: 1, level }],
  };
}
const CFG_LADDER_ROUNDS = 2;

function startBattle(opts, from = 'menu') {
  if (battle) battle.dispose();
  if (hangar) hangar.hide();
  $('menu').hidden = true;
  returnTo = from;
  lastFight = { opts, from };
  mode = 'battle';
  const L = opts.ladder;
  battle = new Battle(renderer, Object.assign({}, opts, {
    onRestart: () => startBattle(L ? ladderOpts(L.level) : lastFight.opts, lastFight.from),
    onWin: L ? () => ladderBeat(L.level) : null,
    onNext: L ? () => startBattle(ladderOpts(L.level + 1), lastFight.from) : null,
  }), hud);
  window.__battle = battle;
}
function leaveBattle() {
  if (battle) { battle.dispose(); battle = null; }
  if (returnTo === 'hangar') openHangar(); else showMenu();
}

function renderLadderButton() {
  const p = ladderProgress();
  const S = aiSkill(p.unlocked);
  const foe = ladderFoe(p.unlocked, roster().map(r => r.name));
  $('ladder').textContent = `AI 天梯 · 第 ${p.unlocked} 关 · ${S.rank} · 对手 ${foe}`;
}

// ---------- hangar ----------
function openHangar(bp) {
  if (battle) { battle.dispose(); battle = null; }
  $('menu').hidden = true;
  mode = 'hangar';
  if (!hangar) hangar = new Hangar(renderer, {
    onTest: (b) => startBattle({ mode: 'duel', map: $('map').value, fighters: [{ bp: b, team: 0 }, { bp: entry(pick.foe).get(), team: 1, level: +$('level').value }] }, 'hangar'),
    onBack: () => showMenu(),
  });
  hangar.show(bp);
  window.__hangar = hangar;
}

$('go').addEventListener('click', () => startBattle(matchOpts()));
$('ladder').addEventListener('click', () => startBattle(ladderOpts(ladderProgress().unlocked)));
$('map').innerHTML = MAP_KEYS.map(k => `<option value="${k}">${MAPS[k].name}</option>`).join('');
$('toHangar').addEventListener('click', () => openHangar(entry(pick.me).get()));
$('again').addEventListener('click', () => battle && battle.restartOrNext());
$('back').addEventListener('click', leaveBattle);

addEventListener('keydown', (e) => {
  if (mode === 'hangar') { hangar.keydown(e); return; }
  if (e.repeat) return;
  if (e.code === 'Escape') { if (mode === 'battle') leaveBattle(); return; }
  if (mode === 'menu') { if (e.code === 'Enter') $('go').click(); return; }
  if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
  battle.keydown(e.code);
});
addEventListener('keyup', (e) => { if (mode === 'battle') battle.keyup(e.code); else if (mode === 'hangar') hangar.keyup(e); });
$('view').addEventListener('mousedown', (e) => { if (mode === 'battle') battle.keydown('Mouse' + e.button); });
addEventListener('mouseup', (e) => { if (mode === 'battle') battle.keyup('Mouse' + e.button); });
$('view').addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('blur', () => { if (battle) for (const k of [...battle.keys]) battle.keyup(k); });
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); battle && battle.resize(); hangar && hangar.resize(); });

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (mode === 'battle' && battle) { battle.update(dt); battle.render(); }
  else if (mode === 'hangar' && hangar) { hangar.update(dt); hangar.render(); }
  else if (showcase) {
    showcase.update(dt, still);
    const a = now * 0.00012;
    menuCam.aspect = innerWidth / innerHeight;
    if (innerWidth > 760) menuCam.setViewOffset(innerWidth, innerHeight, innerWidth * 0.17, 0, innerWidth, innerHeight); else menuCam.clearViewOffset();
    menuCam.updateProjectionMatrix();
    menuCam.position.set(Math.sin(a + 1.9) * 15 + 2, 3.4, Math.cos(a + 1.9) * 15 + 2);
    menuCam.lookAt(2.2, 2.4, 2.5);
    if (window.__camOverride) { const o = window.__camOverride; menuCam.clearViewOffset(); menuCam.updateProjectionMatrix(); menuCam.position.set(...o.p); menuCam.lookAt(...o.l); }
    renderer.render(menuScene, menuCam);
  }
  requestAnimationFrame(frame);
}
refreshDisk().then(() => { showMenu(); requestAnimationFrame(frame); window.__ready = true; });
window.__openHangar = openHangar;
window.__showPreset = (id) => setShowcase(PRESETS[id]());   // test hook
