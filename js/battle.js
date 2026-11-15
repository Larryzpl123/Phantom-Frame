// js/battle.js — one match: any number of mechs in teams, an arena, the lock-on camera, HUD, rounds, win/lose.
//
// opts.fighters: [{ bp, team, level }] — index 0 is the player (level ignored); everyone else is an AI at that level
//                (level 0 = a target dummy that just stands and turns).
// opts.mode:     'duel' | 'ffa' | 'team'   (ffa gives every fighter its own team)
// opts.rounds:   round wins needed (ladder: 2 = best of three)
// opts.ladder:   { level } — the AI ladder; past the skill cap the AI's HP and damage grow (see ai.js aiSkill)
// opts.map:      arena key (see maps.js)
// opts.meIndex:  which fighter this screen plays (default 0). Online:
// opts.online:   { role: 'host' | 'guest', net } — see js/online.js. The host runs the whole fight; fighters with
//                { remote: peer } are driven by that guest's inputs. A guest simulates nothing: it draws the
//                host's snapshots and sends its own inputs.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Mech } from './mech.js';
import { Combat } from './combat.js';
import { AI, aiSkill } from './ai.js';
import { FX, LIGHT_DIR } from './ink.js';
import { buildArena } from './maps.js';

const KEYMAP = { Mouse0: 'KeyJ', Mouse2: 'KeyK' };
const keyName = (code) => code.replace('Key', '').replace('Digit', '').replace('Mouse0', '左键').replace('Mouse2', '右键');
const TEAM_COLORS = ['#3de0d0', '#ff8a3d', '#b49bff', '#f2d14b', '#7fd06b', '#ff6fa8'];

export class Battle {
  constructor(renderer, opts, hud) {
    this.renderer = renderer; this.hud = hud; this.opts = opts;
    this.mode = opts.mode || 'duel';
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 700);
    this.arena = buildArena(this.scene, renderer, opts.map);
    this.env = this.arena.group;
    this.fx = new FX(this.scene);
    this.combat = new Combat(this.scene, this.fx);
    this.combat.blocks = this.arena.blocks || null;       // map obstacles stop shots
    this.keys = new Set();
    this.intent = { move: new THREE.Vector3(), face: 0, jump: false, hover: false, dash: null };
    this.score = new Map();
    this.round = 1;
    this.camPos = new THREE.Vector3(0, 5, -22); this.camLook = new THREE.Vector3();
    this.matchT = 0;                                          // whole match, every round (the ladder board wants it)
    this.online = opts.online || null;
    this.guest = !!(this.online && this.online.role === 'guest');
    if (this.guest) this.combat.viewOnly = true;
    this.spawn();
  }

  get foe() { return this.mechs[1]; }      // the first opponent (tests and 1v1 code)

  // ----- setup -----
  teamOf(i) { return this.mode === 'ffa' ? i : (this.opts.fighters[i].team ?? (i === 0 ? 0 : 1)); }

  spawn() {
    const F = this.opts.fighters;
    this.mechs = []; this.ais = [];
    const teams = [...new Set(F.map((f, i) => this.teamOf(i)))];
    F.forEach((f, i) => {
      const team = this.teamOf(i);
      const m = new Mech(f.bp, this.scene, { team });
      m.colorTeam = team === this.teamOf(this.opts.meIndex || 0) ? 0 : 1;
      m.index = i;
      // spawn points: teams face each other across the arena; within a team, side by side
      const ti = teams.indexOf(team), nT = teams.length;
      const mates = F.map((_, j) => j).filter(j => this.teamOf(j) === team);
      const k = mates.indexOf(i), n = mates.length;
      const ang = (ti / nT) * Math.PI * 2 + Math.PI;            // team 0 at -Z
      const R = nT === 2 ? 12 : 16;
      const base = new THREE.Vector3(Math.sin(ang) * R, 0, Math.cos(ang) * R);
      const across = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang));
      m.pos.copy(base).addScaledVector(across, (k - (n - 1) / 2) * 5);
      m.yaw = Math.atan2(-base.x, -base.z);
      this.arena.place && this.arena.place(m.pos);
      const isAI = i !== (this.opts.meIndex || 0) && !f.remote && (f.level ?? 8) > 0;
      if (isAI && !this.guest) {                              // AI strength by level: soft at the bottom, tougher past the cap
        const S = aiSkill(this.opts.ladder ? this.opts.ladder.level : (f.level ?? 8));
        m.dmgMul = S.dmgMul;
        if (S.hpMul !== 1) for (const r of m.parts.values()) { r.hp *= S.hpMul; r.maxHp *= S.hpMul; }
      }
      this.combat.add(m);
      this.hook(m);
      this.mechs.push(m);
    });
    const meI = this.opts.meIndex || 0;
    this.me = this.mechs[meI];
    for (let i = 0; i < this.mechs.length; i++) {
      if (i === meI || this.guest) continue;                 // a guest runs no AI: the host does
      if (F[i].remote) { this.mechs[i].remote = { peer: F[i].remote, intent: { move: new THREE.Vector3(), face: 0, jump: false, hover: false, dash: null } }; continue; }
      const lv = F[i].level ?? 8;
      const ai = new AI(this.mechs[i], this.nearestEnemy(this.mechs[i]), this.combat, lv);
      ai.dummy = lv <= 0;
      this.ais.push(ai);
    }
    this.target = this.nearestEnemy(this.me);
    this.timeScale = 1; this.over = false; this.roundOver = false; this.t = 0; this.roundT = 0;
    this.hud.result.hidden = true;
    this.buildHud();
    if (this.online) this.online.onSpawn(this);
  }

  hook(m) {
    const dust = m.ink ? '#20302f' : '#6f8a96';
    const col = TEAM_COLORS[m.colorTeam] || '#ff8a3d';
    m.onStep = (p) => this.fx.puff(p.clone().setY(0.12), dust, 0.6, m.ink ? 0.2 : 0.12);
    m.onLand = (v) => { if (v > 6) { this.fx.puff(m.pos.clone().setY(0.2), dust, 2.2, 0.25); this.combat.shake = Math.max(this.combat.shake, 0.15); } };
    m.onDash = () => m.ink ? this.fx.puff(m.center(), '#1d4b49', 1.6, 0.45) : this.fx.flare(m.center(), col, 2.2);
    m.onBreak = (rec, world) => {
      const p = new THREE.Vector3().setFromMatrixPosition(world);
      if (m.ink) this.fx.splash(p, null, 8, '#121a1c', 0.4, 7); else { this.fx.sparks(p, null, 18, '#ffb36b', 0.3, 9); this.fx.flare(p, '#ffd9a8', 2.5); }
      if (m === this.me) this.flash('断！'); else if (m === this.target) this.flash('破！');
    };
    m.onDeath = () => this.onKO(m);
    m.onPhantom = (on) => {
      if (!on) return;
      const p = m.center();
      if (m.ink) this.fx.splash(p, null, 10, '#1d4b49', 0.45, 4); else { this.fx.flare(p, col, 3); this.fx.sparks(p, null, 12, col, 0.2, 6); }
      if (m === this.me) this.flash(m.ink ? '墨影' : '幻影');
    };
    m.onHandOver = () => { if (m === this.me) this.flash('换手'); };
  }

  // online: a guest left mid-match, an AI takes over that mech
  takeOverByAI(m, level) {
    m.remote = null;
    for (const k of [...m.player.held || []]) m.player.release(k);
    const ai = new AI(m, this.nearestEnemy(m), this.combat, level);
    this.ais.push(ai);
  }

  enemiesOf(m) { return this.mechs.filter(o => o !== m && !o.dead && o.team !== m.team); }
  nearestEnemy(m) {
    let best = null, bd = Infinity;
    for (const o of this.enemiesOf(m)) { const d = o.pos.distanceTo(m.pos); if (d < bd) { bd = d; best = o; } }
    return best;
  }

  // ----- input -----
  keydown(code) {
    code = KEYMAP[code] || code;
    if (this.keys.has(code)) return;
    this.keys.add(code);
    if (code === 'Space') this.intent.jump = true;
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.wantDash = true;
    if (code === 'Tab') { this.cycleTarget(); return; }
    if (this.over) { if (code === 'KeyR') this.restartOrNext(); return; }
    if (this.guest) { this.online.key(code, true); return; }
    this.me.player.press(code);
  }
  keyup(code) {
    code = KEYMAP[code] || code; this.keys.delete(code);
    if (this.guest) { this.online.key(code, false); return; }
    this.me.player.release(code);
  }

  cycleTarget() {
    const list = this.enemiesOf(this.me).sort((a, b) => a.pos.distanceTo(this.me.pos) - b.pos.distanceTo(this.me.pos));
    if (!list.length) return;
    const i = list.indexOf(this.target);
    this.target = list[(i + 1) % list.length];
    this.buildHud();
  }

  restartOrNext() {
    if (this.guest) return;                                   // only the host restarts an online match
    if (this.ladderWon && this.opts.onNext) this.opts.onNext(); else this.opts.onRestart && this.opts.onRestart();
  }

  playerIntent() {
    const it = this.intent;
    if (!this.target || this.target.dead) { const t = this.nearestEnemy(this.me); if (t !== this.target) { this.target = t; if (t) this.buildHud(); } }
    const tgt = this.target ? this.target.pos : this.me.pos.clone().add(this.me.forward());
    const to = new THREE.Vector3().subVectors(tgt, this.me.pos).setY(0);
    if (to.lengthSq() < 1e-6) to.copy(this.me.forward());
    to.normalize();
    const right = new THREE.Vector3(-to.z, 0, to.x);
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    it.move.set(0, 0, 0).addScaledVector(to, f).addScaledVector(right, s);
    if (it.move.lengthSq() > 1) it.move.normalize();
    it.face = Math.atan2(to.x, to.z);
    it.hover = k.has('Space');
    it.crouch = k.has('KeyC');
    it.dash = this.wantDash ? (it.move.lengthSq() > 0.01 ? it.move.clone() : to.clone()) : null;
    this.wantDash = false;
    return it;
  }

  // ----- loop -----
  update(rawDt) {
    if (this.guest) { this.online.guestUpdate(this, rawDt); return; }
    let dt = Math.min(rawDt, 1 / 30) * this.timeScale;
    if (this.combat.hitStop > 0) { this.combat.hitStop -= rawDt; dt *= 0.08; }
    this.t += dt; this.roundT += dt; this.matchT += dt;
    const it = this.playerIntent();
    for (const ai of this.ais) {
      const m = ai.me;
      if (m.dead) continue;
      if (!ai.foe || ai.foe.dead || (ai.retarget = (ai.retarget || 0) - dt) <= 0) {
        ai.retarget = 1;
        const f = this.nearestEnemy(m);
        if (f && f !== ai.foe) ai.setFoe(f);
      }
      if (ai.dummy || !ai.foe) { ai.intent.move.set(0, 0, 0); if (ai.foe) ai.intent.face = Math.atan2(ai.foe.pos.x - m.pos.x, ai.foe.pos.z - m.pos.z); }
      else { ai.update(dt); this.arena.steer && this.arena.steer(m, ai.intent.move); }
    }
    this.me.update(dt, it);
    for (const ai of this.ais) ai.me.update(dt, ai.intent);
    for (const m of this.mechs) if (m.remote && m !== this.me) { m.update(dt, m.remote.intent); m.remote.intent.jump = false; m.remote.intent.dash = null; }
    it.jump = false;
    this.separate();
    this.arena.collide && this.arena.collide(this.mechs);
    this.combat.update(dt);
    for (const m of this.mechs) {
      m.updateDebris(dt);
      if (m.thrusting && !m.dead && Math.random() < 0.6) {
        const p = m.center().add(new THREE.Vector3(0, -0.4, 0).addScaledVector(m.forward(), -0.6));
        if (m.ink) this.fx.puff(p, '#1d4b49', 0.6, 0.3); else this.fx.flare(p, TEAM_COLORS[m.colorTeam], 0.9);
      }
    }
    const sun = this.env.userData.sun;
    if (sun) { sun.target.position.copy(this.me.pos); sun.position.copy(this.me.pos).addScaledVector(LIGHT_DIR, 60); }
    this.arena.update && this.arena.update(dt, this);
    this.fx.update(dt);
    if (!this.roundOver && this.roundT > CFG.match.roundTime) this.timeUp();
    if (this.over) { this.overT += rawDt; this.timeScale = Math.min(1, 0.15 + this.overT * 0.4); }
    this.updateCamera(rawDt);
    this.updateHud();
    if (this.online) this.online.hostTick(this, rawDt);
  }

  separate() {
    const M = this.mechs.filter(m => !m.dead);
    const d = new THREE.Vector3();
    for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length; j++) {
      const a = M[i], b = M[j];
      d.subVectors(b.pos, a.pos).setY(0);
      const L = d.length(), min = a.radius + b.radius;
      if (L < min && L > 1e-4) {
        d.multiplyScalar((min - L) / L * 0.5);
        const wa = b.massRatio / (a.massRatio + b.massRatio), wb = 1 - wa;
        a.pos.addScaledVector(d, -2 * wa); b.pos.addScaledVector(d, 2 * wb);
      }
    }
  }

  updateCamera(dt) {
    const me = this.me;
    // after the player falls in a team fight, watch the nearest living teammate
    const anchor = me.dead ? (this.mechs.find(m => !m.dead && m.team === me.team) || me) : me;
    const tgt = (anchor === me ? this.target : this.nearestEnemy(anchor)) || this.mechs.find(m => m !== anchor) || anchor;
    const to = new THREE.Vector3().subVectors(tgt.pos, anchor.pos).setY(0);
    const dist = Math.max(0.01, to.length()); to.normalize();
    if (to.lengthSq() < 0.5) to.set(0, 0, 1);
    const right = new THREE.Vector3(-to.z, 0, to.x);
    const back = CFG.cam.dist + Math.min(6, dist * 0.08);
    const want = anchor.pos.clone().addScaledVector(to, -back).addScaledVector(right, CFG.cam.side);
    want.y = Math.max(anchor.pos.y, 0) + CFG.cam.height + Math.min(3, dist * 0.04);
    if (this.arena.clampCamera) this.arena.clampCamera(anchor.pos, want);
    const look = anchor.pos.clone().setY(anchor.pos.y + 2.4).lerp(tgt.pos.clone().setY(tgt.pos.y + 2), CFG.cam.look);
    const k = 1 - Math.exp(-CFG.cam.lerp * dt);
    this.camPos.lerp(want, k); this.camLook.lerp(look, k);
    if (this.arena.clampCamera) this.arena.clampCamera(anchor.pos, this.camPos);   // also mid-swing, not only the target
    this.camera.position.copy(this.camPos);
    if (this.combat.shake > 0) {
      const s = this.combat.shake * 0.35;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.combat.shake = Math.max(0, this.combat.shake - dt * 1.8);
    }
    this.camera.lookAt(this.camLook);
  }

  render() {
    const o = window.__camOverride;   // test hook: fixed camera for screenshots
    if (o) { this.camera.position.set(...o.p); this.camera.lookAt(...o.l); }
    this.renderer.render(this.scene, this.camera);
  }
  resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }

  // ----- rounds -----
  aliveTeams() { return [...new Set(this.mechs.filter(m => !m.dead).map(m => m.team))]; }

  onKO(m) {
    const loser = m, p = loser.center();
    if (loser.ink) this.fx.splash(p, null, 22, '#121a1c', 0.8, 9); else { this.fx.flare(p, '#ffb36b', 7); this.fx.sparks(p, null, 40, '#ffb36b', 0.35, 12); }
    if (m === this.target) this.target = this.nearestEnemy(this.me);
    if (this.guest) return;                                   // the host decides rounds
    const alive = this.aliveTeams();
    if (alive.length <= 1 && !this.roundOver) this.endRound(alive[0]);
  }

  timeUp() {
    // nobody won in time: the team with more machine left takes the round
    const integ = new Map();
    for (const m of this.mechs) if (!m.dead) integ.set(m.team, (integ.get(m.team) || 0) + this.integrity(m));
    let best = null, bv = -1;
    for (const [t, v] of integ) if (v > bv) { bv = v; best = t; }
    this.flash('时间到');
    this.endRound(best);
  }

  endRound(winner) {
    this.roundOver = true;
    if (this.online && !this.guest) this.online.send({ t: 'round', w: winner ?? null }, true);
    if (winner !== undefined) this.score.set(winner, (this.score.get(winner) || 0) + 1);
    const need = this.opts.rounds || 1;
    const myTeam = this.me.team;
    const decided = winner === undefined || (this.score.get(winner) || 0) >= need;
    if (!decided) {
      this.flash(winner === myTeam ? `第 ${this.round} 回合 胜` : `第 ${this.round} 回合 负`);
      this.timeScale = 0.3;
      if (!this.guest) setTimeout(() => this.nextRound(), CFG.match.roundDelay * 1000);
      return;
    }
    this.over = true; this.overT = 0; this.timeScale = 0.15;
    const won = winner === myTeam;
    this.ladderWon = won && !!this.opts.ladder;
    if (won && this.opts.onWin) this.opts.onWin();
    setTimeout(() => {
      const h = this.hud;
      h.result.hidden = false;
      h.resultText.textContent = won ? '胜' : '败';
      h.resultText.className = won ? 'win' : 'lose';
      const L = this.opts.ladder;
      const sc = this.scoreText();
      h.resultSub.textContent = L ? `天梯第 ${L.level} 关 · ${aiSkill(L.level).rank} · ${sc}${won ? ' · 下一关已解锁' : ''}`
        : this.mode === 'duel' ? (won ? `${this.me.name} 击破 ${this.mechs[1].name}` : `${this.mechs[1].name} 击破 ${this.me.name}`) + (sc ? ` · ${sc}` : '')
        : (won ? '我方获胜' : '我方落败');
      h.again.textContent = this.ladderWon ? '下一关 (R)' : this.guest ? '等房主开下一局' : '再来一局 (R)';
    }, 900);
  }

  scoreText() {
    if ((this.opts.rounds || 1) <= 1) return '';
    const mine = this.score.get(this.me.team) || 0;
    let theirs = 0; for (const [t, v] of this.score) if (t !== this.me.team) theirs = Math.max(theirs, v);
    return `${mine} : ${theirs}`;
  }

  nextRound() {
    if (this.disposed) return;
    if (this.online && !this.guest) this.online.send({ t: 'next' }, true);
    for (const m of this.mechs) m.dispose();
    this.combat.clear(); this.fx.clear();
    this.round++;
    this.spawn();
    this.flash(`第 ${this.round} 回合`);
  }

  integrity(m) { let a = 0, b = 0; for (const r of m.parts.values()) { b += r.maxHp; if (r.alive) a += Math.max(0, r.hp); } return a / b; }

  // ----- HUD -----
  buildHud() {
    const h = this.hud;
    h.root.hidden = false;
    const B = this.target || this.mechs[1];
    h.nameA.textContent = this.me.name; h.nameB.textContent = B ? B.name : '';
    h.nameA.className = 'nm' + (this.me.ink ? ' ink' : ''); h.nameB.className = 'nm' + (B && B.ink ? ' ink' : '');
    const L = this.opts.ladder;
    h.round.hidden = !(L || (this.opts.rounds || 1) > 1);
    h.round.textContent = L ? `天梯 ${L.level} · ${aiSkill(L.level).rank} · 第 ${this.round} 回合 · ${this.scoreText()}` : `第 ${this.round} 回合 · ${this.scoreText()}`;
    // everyone else, for team / free-for-all
    h.fighters.innerHTML = '';
    h.fighters.hidden = this.mechs.length <= 2;
    for (const m of this.mechs) {
      if (m === this.me) continue;
      const row = document.createElement('div');
      row.className = 'fighter' + (m.team === this.me.team ? ' ally' : '') + (m === this.target ? ' tgt' : '');
      row.innerHTML = `<span></span><div class="bar"><i></i></div>`;
      row.firstChild.textContent = m.name;
      row.lastChild.firstChild.style.background = TEAM_COLORS[m.team === this.me.team ? 0 : (this.mode === 'ffa' ? (m.index % 5) + 1 : 1)];
      m.hudRow = row.lastChild.firstChild;
      h.fighters.appendChild(row);
    }
    h.moves.innerHTML = '';
    for (const a of this.me.bp.actions) {
      if (a.mode === 'idle' || !a.key) continue;
      const chain = [];
      let n = a.next ? this.me.bp.actions.find(x => x.id === a.next) : null;
      const seen = new Set([a.id]);
      while (n && !seen.has(n.id)) { chain.push(n.name); seen.add(n.id); n = n.next ? this.me.bp.actions.find(x => x.id === n.next) : null; }
      const li = document.createElement('div');
      li.className = 'move';
      li.innerHTML = `<kbd>${a.low ? 'C+' : ''}${keyName(a.key)}</kbd><span>${a.name}${chain.length ? ' → ' + chain.join(' → ') : ''}${a.mode === 'hold' ? '（按住）' : ''}</span>`;
      h.moves.appendChild(li);
    }
    if (this.mechs.length > 2) { const li = document.createElement('div'); li.className = 'move'; li.innerHTML = '<kbd>Tab</kbd><span>切换锁定</span>'; h.moves.appendChild(li); }
  }

  updateHud() {
    const h = this.hud;
    const pct = (m) => m.net ? m.net.core : Math.max(0, m.coreRec.hp / m.coreRec.maxHp);
    const B = this.target || this.mechs[1];
    h.hpA.style.transform = `scaleX(${pct(this.me)})`;
    h.hpB.style.transform = `scaleX(${B ? pct(B) : 0})`;
    const ig = (m) => m.net ? m.net.integ : this.integrity(m);
    h.intA.textContent = `机体完整度 ${(ig(this.me) * 100).toFixed(0)}%`;
    h.intB.textContent = B ? `机体完整度 ${(ig(B) * 100).toFixed(0)}%` : '';
    for (const m of this.mechs) if (m.hudRow) m.hudRow.style.transform = `scaleX(${m.dead ? 0 : pct(m)})`;
    h.boost.style.transform = `scaleX(${this.me.boost / CFG.thrust.cap})`;
    let heat = 0; for (const r of this.me.parts.values()) if (r.weapon && r.weapon.kind === 'gun') heat = Math.max(heat, r.heat / CFG.gun.overheat);
    if (this.me.net) heat = this.me.net.heat;
    h.heatWrap.hidden = heat <= 0.01;
    h.heat.style.transform = `scaleX(${heat})`;
    const ph = this.me.phantomRoots.length > 0;
    h.kiWrap.hidden = !ph;
    if (ph) { h.ki.style.transform = `scaleX(${this.me.ki / CFG.phantom.cap})`; h.kiLabel.textContent = (this.me.ink ? '墨影 ' : '幻影 ') + (this.me.phantomOn ? 'ON' : '凝聚中'); }
  }

  flash(text) {
    const el = this.hud.flash;
    el.textContent = text;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }

  dispose() {
    this.disposed = true;
    this.combat.clear(); this.fx.clear();
    for (const m of this.mechs) m.dispose();
    this.hud.root.hidden = true; this.hud.result.hidden = true;
  }
}
