// js/main.js — boot, menu, mode switching (menu / battle / hangar), main loop.

import * as THREE from 'three';
import { Battle } from './battle.js';
import { PRESETS } from './presets.js';
import { Mech } from './mech.js';
import { buildTechEnvironment } from './tech.js';
import { roster, refreshDisk, ladderProgress, ladderBeat, ladderSet } from './save.js';
import { Board } from './board.js';
import { anonymize, fromBoard } from './share.js';
import { aiSkill, ladderFoe } from './ai.js';
import { MAPS, MAP_KEYS } from './maps.js';
import { Hangar } from './hangar.js';
import { OnlineSession } from './online.js';

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
// the mech I fight with: the one brought from the hangar (出战 / 联机 in the hangar dock), or a roster pick
let fromHangar = null;
const HANGAR_ID = '__hangar';
function myBp() { return pick.me === HANGAR_ID && fromHangar ? JSON.parse(JSON.stringify(fromHangar)) : entry(pick.me).get(); }
function myName() { return pick.me === HANGAR_ID && fromHangar ? fromHangar.name : entry(pick.me).name; }
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
    if (key === 'me' && fromHangar) {                  // what's on the hangar stand right now, saved or not
      const b = document.createElement('button');
      b.setAttribute('aria-pressed', pick.me === HANGAR_ID ? 'true' : 'false');
      b.innerHTML = `<b class="${fromHangar.style === 'ink' ? 'ink' : ''}"></b><small>机库当前</small>`;
      b.querySelector('b').textContent = fromHangar.name;
      b.addEventListener('click', () => { pick.me = HANGAR_ID; renderRoster(); setShowcase(myBp()); });
      el.appendChild(b);
    }
    for (const r of list) {
      const b = document.createElement('button');
      const bp = r.get();
      b.setAttribute('aria-pressed', pick[key] === r.id ? 'true' : 'false');
      b.innerHTML = `<b class="${bp && bp.style === 'ink' ? 'ink' : ''}"></b><small>${{ folder: '文件夹', local: '浏览器存档', preset: '内置' }[r.src]}</small>`;
      b.querySelector('b').textContent = r.name;
      b.addEventListener('click', () => { pick[key] = r.id; renderRoster(); if (key === 'me') setShowcase(myBp()); });
      el.appendChild(b);
    }
  }
}

function showMenu() {
  mode = 'menu';
  if (battle) { battle.dispose(); battle = null; }
  if (hangar) hangar.hide();
  $('menu').hidden = false;
  showPanel(session && session.role ? 'online' : 'main');
  if (!(pick.me === HANGAR_ID && fromHangar) && !roster().some(r => r.id === pick.me)) pick.me = byName('极点');
  if (!roster().some(r => r.id === pick.foe)) pick.foe = byName('玄岳');
  renderRoster();
  renderLadderButton();
  setShowcase(myBp());
}

// ---------- battle ----------
// opponents for multi-mech modes: the picked foe first, then the rest of the roster, round-robin
function opponents(n) {
  const list = roster().filter(r => r.id !== pick.me && r.name !== myName());
  const first = entry(pick.foe);
  const pool = [first, ...list.filter(r => r.id !== first.id)];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length].get());
}

function matchOpts() {
  const mode = $('mode').value, lv = +$('level').value, map = $('map').value;
  const me = myBp();
  if (mode === 'duel') return { mode: 'duel', map, fighters: [{ bp: me, team: 0 }, { bp: entry(pick.foe).get(), team: 1, level: lv }] };
  if (mode === 'ffa') return { mode: 'ffa', map, fighters: [{ bp: me }, ...opponents(3).map(bp => ({ bp, level: lv }))] };
  const n = mode === 'team3' ? 3 : 2;
  const mates = roster().filter(r => r.id !== pick.me && r.name !== myName());
  const allies = Array.from({ length: n - 1 }, (_, i) => mates.length ? mates[i % mates.length].get() : myBp());
  return { mode: 'team', map, fighters: [{ bp: me, team: 0 }, ...allies.map(bp => ({ bp, team: 0, level: lv })), ...opponents(n).map(bp => ({ bp, team: 1, level: lv }))] };
}

function ladderOpts(level) {
  const names = roster().map(r => r.name);
  const foeName = ladderFoe(level, names);
  const foe = roster().find(r => r.name === foeName) || entry(pick.foe);
  return {
    mode: 'duel', map: MAP_KEYS[(level - 1) % MAP_KEYS.length], rounds: CFG_LADDER_ROUNDS, ladder: { level },
    fighters: [{ bp: myBp(), team: 0 }, { bp: foe.get(), team: 1, level }],
  };
}
const CFG_LADDER_ROUNDS = 2;

// ---------- online ----------
let session = null;
function showPanel(which) {
  document.querySelector('#menu > .panel:not(#onlinePanel)').hidden = which !== 'main';
  $('onlinePanel').hidden = which !== 'online';
  if (which === 'online') { $('onMech').textContent = myName(); renderOnline(); }
}
function onStatus(t) { $('onStatus').textContent = t || ''; }
function fillBps() { return roster().map(r => r.get()); }
function renderOnline() {
  const S = session, inRoom = !!(S && S.role);
  $('onEntry').hidden = inRoom; $('onRoom').hidden = !inRoom;
  if (!inRoom) return;
  const L = S.lobbyView();
  $('onRoomCode').textContent = (L && L.code) || S.code || '…';
  const host = S.role === 'host';
  $('onHostSet').hidden = !host; $('onStart').hidden = !host;
  const list = $('onPlayers'); list.innerHTML = '';
  for (const p of (L ? L.players : [])) {
    const li = document.createElement('li');
    li.textContent = p.name;
    const tag = document.createElement('span'); tag.textContent = p.peer === 'h' ? '房主' : '玩家';
    li.appendChild(tag); list.appendChild(li);
  }
  const set = L ? L.set : null;
  const modeName = { duel: '单挑 1v1', team2: '组队 2v2', ffa: '混战', team3: '组队 3v3' };
  $('onSetView').textContent = set ? `${modeName[set.mode]} · ${MAPS[set.map] ? MAPS[set.map].name : set.map} · ${set.rounds > 1 ? '三局两胜' : '一局'}${host ? '' : ' · 等房主开始'}` : '';
  if (host && L && set.mode === 'duel' && L.players.length > 2) $('onSetView').textContent += ' · 单挑只上前两人';
}
$('onMap').innerHTML = MAP_KEYS.map(k => `<option value="${k}">${MAPS[k].name}</option>`).join('');
$('toOnline').addEventListener('click', () => { onStatus(''); showPanel('online'); });
$('onBack').addEventListener('click', () => { if (session && session.role) session.leave(); renderOnline(); showPanel('main'); });
function newSession() {
  if (session && session.role) session.leave();
  session = new OnlineSession({
    onLobby: () => renderOnline(),
    status: onStatus,
    onStart: (opts) => startBattle(opts, 'online'),
    onClosed: (why) => { onStatus(why); if (mode === 'battle' && battle) { battle.dispose(); battle = null; showMenu(); } renderOnline(); },
  });
  return session;
}
const hostSettings = () => ({ mode: $('onMode').value, map: $('onMap').value, rounds: +$('onRounds').value, fill: +$('onFill').value });
$('onCreate').addEventListener('click', async () => {
  const S = newSession();
  onStatus('正在创建房间…');
  try { S.settings = hostSettings(); await S.create(myBp()); onStatus('把房间号发给朋友，他们点「加入」。'); }
  catch (e) { onStatus('创建失败：' + e.message); S.leave(); }
  renderOnline();
});
$('onJoin').addEventListener('click', async () => {
  const code = $('onCode').value.trim();
  if (!code) { onStatus('先填房间号'); return; }
  const S = newSession();
  onStatus('正在连接房主…');
  try { await S.join(code, myBp()); onStatus('已连上，等房主开始。'); }
  catch (e) { onStatus('加入失败：' + e.message); S.leave(); }
  renderOnline();
});
for (const id of ['onMode', 'onMap', 'onRounds', 'onFill']) $(id).addEventListener('change', () => session && session.role === 'host' && session.setSettings(hostSettings()));
$('onStart').addEventListener('click', () => session && session.start(fillBps()));
$('onLeave').addEventListener('click', () => { if (session) session.leave(); onStatus('已离开房间'); renderOnline(); });

function startBattle(opts, from = 'menu') {
  if (battle) battle.dispose();
  if (hangar) hangar.hide();
  $('menu').hidden = true;
  returnTo = from;
  lastFight = { opts, from };
  mode = 'battle';
  const L = opts.ladder;
  const online = opts.online;
  // a ladder fight tells the board it started (take-off ticket: a level can't be reported faster than it was played)
  const ticket = L && Board.enabled ? Board.runStart() : null;
  battle = new Battle(renderer, Object.assign({}, opts, {
    onRestart: online ? () => online.start(fillBps()) : () => startBattle(L ? ladderOpts(L.level) : lastFight.opts, lastFight.from),
    onWin: L ? () => { ladderBeat(L.level); reportClear(L.level, opts.fighters[0].bp, ticket); } : null,
    onNext: L ? () => startBattle(ladderOpts(L.level + 1), lastFight.from) : null,
  }), hud);
  window.__battle = battle;
}
function leaveBattle() {
  if (battle) { battle.dispose(); battle = null; }
  if (returnTo === 'online') {
    if (session && session.role === 'host') session.endMatch();
    else if (session && session.role === 'guest') { session.leave(); onStatus('已离开房间'); }
    showMenu(); return;
  }
  if (returnTo === 'hangar') openHangar(); else showMenu();
}

// a ladder level won: put it (and the mech, anonymous) on the board, then say where that leaves me
async function reportClear(level, bp, ticketP) {
  const b = battle;
  if (!Board.enabled) return;
  const mech = anonymize(bp);
  const note = (t) => { if (b === battle && b) { b.boardNote = t; if (!hud.result.hidden) hud.resultSub.textContent += ' · ' + t; else setTimeout(() => { if (b === battle && !hud.result.hidden && !hud.resultSub.textContent.includes(t)) hud.resultSub.textContent += ' · ' + t; }, 1200); } };
  if (!mech) { note('这台用了导入模型，不能上榜'); return; }
  const r = await Board.clear({ level, time: Math.max(1, Math.round(b.matchT)), ticket: await ticketP, mech });
  if (r.status === 409 && Number.isInteger(r.level)) { ladderSet(r.level + 1); note(`天梯榜记录你在第 ${r.level} 关：从第 ${r.level + 1} 关接着打才算榜`); return; }
  if (r.error) { note(r.error === 'offline' ? '天梯榜连不上（这关只记在本机）' : '天梯榜没收：' + r.error); return; }
  note(r.listed ? `天梯榜第 ${r.rank} 名 / ${r.total}` : '锁定呼号后才会出现在天梯榜上（机库 → 🏆 天梯榜）');
}
// on start: if the board has me further along (another device), carry on from there
async function syncLadder() {
  if (!Board.enabled || !Board.me()) return;
  const t = await Board.top();
  if (t.me && t.me.level + 1 > ladderProgress().unlocked) { ladderSet(t.me.level + 1); if (mode === 'hangar') $('hLadder').textContent = `AI 天梯 · 第 ${t.me.level + 1} 关`; }
}

// ---------- 🏆 board window (in the hangar) ----------
const fmtTime = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
async function openBoard() {
  $('boardBox').hidden = false; $('bdBackup').hidden = true;
  $('bdList').textContent = '载入中…';
  if (!Board.me()) await Board.ensureId();
  const t = await Board.top();
  renderBoard(t);
}
function renderBoard(t) {
  const me = Board.me();
  if (t.error) { $('bdList').textContent = '连不上天梯榜：' + t.error; }
  else {
    const list = $('bdList'); list.innerHTML = '';
    if (!t.rows.length) list.textContent = '还没有人上榜。打赢一关 AI 天梯就有你了。';
    for (const r of t.rows) {
      const row = document.createElement('div');
      row.className = 'bdRow' + (me && r.id === me.id ? ' mine' : '');
      row.innerHTML = `<span>#${r.rank}</span><span></span><span>第 ${r.level} 关</span><span>${fmtTime(r.time)}</span><span></span>`;
      row.children[1].textContent = `${r.callsign} #${r.id}`;
      if (r.mech) {
        const b = document.createElement('button'); b.className = 'btn'; b.textContent = '复制机体';
        b.onclick = async () => {
          b.disabled = true;
          const g = await Board.getMech(r.id);
          b.disabled = false;
          if (g.error) { hangar.toast('拿不到这台：' + g.error); return; }
          try { hangar.setBp(fromBoard(g.mech, `天梯${r.rank}`)); hangar.refreshLoadSel(); $('boardBox').hidden = true; hangar.toast(`已把天梯第 ${r.rank} 名的机体放上台子（还没保存）`); }
          catch (e) { hangar.toast('这台载不进来：' + e.message); }
        };
        row.children[4].appendChild(b);
      }
      list.appendChild(row);
    }
  }
  const m = t.me;
  $('bdMe').textContent = !me ? '连不上天梯榜，没法注册。'
    : `你是「${me.callsign} #${me.id}」` + (m && m.level ? ` · 打到第 ${m.level} 关` + (m.rank ? ` · 第 ${m.rank} 名 / ${t.total}` : '') : ' · 还没上榜') +
      (me.locked ? '' : ' · 呼号还没锁定：锁定前不会出现在榜上，可以先换到满意的');
  $('bdReroll').hidden = !me || me.locked; $('bdLock').hidden = !me || me.locked; $('bdBackupBtn').hidden = !me;
}
$('hBoard').addEventListener('click', openBoard);
$('bdClose').addEventListener('click', () => { $('boardBox').hidden = true; });
$('bdReroll').addEventListener('click', async () => { const r = await Board.reroll(); if (r.error) hangar.toast(r.error === 'slow down' ? '慢一点' : r.error); renderBoard(await Board.top()); });
$('bdLock').addEventListener('click', async () => { const r = await Board.lock(); if (r.error) hangar.toast(r.error); renderBoard(await Board.top()); });
$('bdBackupBtn').addEventListener('click', () => { $('bdBackup').hidden = !$('bdBackup').hidden; $('bdCode').value = Board.backupCode(); });
$('bdCopyCode').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('bdCode').value); hangar.toast('备份码已复制'); } catch { $('bdCode').select(); } });
$('bdRestoreBtn').addEventListener('click', async () => {
  const r = await Board.restore($('bdRestore').value);
  if (r.error) { hangar.toast(r.error); return; }
  hangar.toast(`已恢复「${r.callsign} #${r.id}」`); $('bdRestore').value = '';
  await syncLadder(); renderBoard(await Board.top());
});

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
    onTest: (b) => startBattle({ mode: 'duel', map: $('hMap').value, fighters: [{ bp: b, team: 0 }, { bp: entry(pick.foe).get(), team: 1, level: 0 }] }, 'hangar'),
    onBack: () => showMenu(),
  });
  hangar.show(bp || hangar.bp || myBp());
  $('hMap').value = $('map').value;
  const p = ladderProgress();
  $('hLadder').textContent = `AI 天梯 · 第 ${p.unlocked} 关`;
  window.__hangar = hangar;
}

$('go').addEventListener('click', () => startBattle(matchOpts()));
// hangar dock
$('hMap').innerHTML = MAP_KEYS.map(k => `<option value="${k}">${MAPS[k].name}</option>`).join('');
$('hMap').addEventListener('change', () => { $('map').value = $('hMap').value; });
function bringFromHangar() { const bp = hangar && hangar.ready(); if (!bp) return false; fromHangar = bp; pick.me = HANGAR_ID; return true; }
$('hSortie').addEventListener('click', () => { if (bringFromHangar()) showMenu(); });
$('hOnline').addEventListener('click', () => { if (bringFromHangar()) { showMenu(); onStatus(''); showPanel('online'); } });
$('hBoard').hidden = !Board.enabled;
$('hLadder').addEventListener('click', () => { if (bringFromHangar()) startBattle(ladderOpts(ladderProgress().unlocked), 'hangar'); });
$('ladder').addEventListener('click', () => startBattle(ladderOpts(ladderProgress().unlocked)));
$('map').innerHTML = MAP_KEYS.map(k => `<option value="${k}">${MAPS[k].name}</option>`).join('');
$('toHangar').addEventListener('click', () => openHangar(pick.me === HANGAR_ID && fromHangar ? null : myBp()));
$('again').addEventListener('click', () => battle && battle.restartOrNext());
$('back').addEventListener('click', leaveBattle);

addEventListener('keydown', (e) => {
  if (mode === 'hangar') { hangar.keydown(e); return; }
  if (e.repeat) return;
  if (e.code === 'Escape') { if (mode === 'battle') leaveBattle(); else if (mode === 'menu' && !(session && session.role)) openHangar(null); return; }
  if (mode === 'menu') { if (e.code === 'Enter') $('go').click(); return; }
  if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
  battle.keydown(e.code);
});
addEventListener('keyup', (e) => { if (mode === 'battle' && battle) battle.keyup(e.code); else if (mode === 'hangar') hangar.keyup(e); });
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
// the game opens in the hangar: building is the heart of it; 出战 ▸ goes to the battle menu
refreshDisk().then(() => {
  if (!roster().some(r => r.id === pick.me)) pick.me = byName('极点');
  if (!roster().some(r => r.id === pick.foe)) pick.foe = byName('玄岳');
  openHangar(entry(pick.me).get());
  requestAnimationFrame(frame); window.__ready = true;
  syncLadder();
});
window.__showMenu = showMenu;   // test hook
window.__openHangar = openHangar;
window.__showPreset = (id) => setShowcase(PRESETS[id]());   // test hook
