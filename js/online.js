// js/online.js — online play: a room (lobby) and the networked match.
//
// Host-authoritative. The host's browser runs the whole fight exactly as offline (physics, combat, AI fill-ins);
// every guest sends only its inputs and draws what the host sends back. One simulation means nobody disagrees
// about a hit, a cut bullet or a broken arm. The cost: a guest's own moves show up one round trip late
// (plus CFG.net.delay of smoothing), so on a slow connection the guest feels heavier than the host.
//
// Messages (JSON over js/net.js; R = reliable channel, F = fast channel that may drop):
//   guest -> host  hello {bp}                 R  my mech, on joining
//                  in    {mv:[x,z], f, h, c}  F  30/s: move direction (world), facing, hover held, squat held
//                  k     {c, d}               R  a key went down (d=1) / up (d=0): attacks, jump, dash
//   host -> guest  lobby {players, set}       R  who's in the room, the settings
//                  start {fighters, me, ...}  R  the match: everyone's mech and team, which one is yours
//                  s     {ht, T, m:[[...]]}   F  20/s: every mech's pose and gauges (Mech.netState)
//                  brk {m, id}  hit {...}  cut {p}  shot {...}  sx {id, p}  round {w}  next {}   R  events
//                  bye {}                     R  the host left
//
// The signaling mailbox is Skybreak's Worker (rooms of up to 4 people), so 3v3 online is up to 4 players with
// AI filling the empty seats.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Net } from './net.js';
import { sanitize } from './blueprint.js';
import { computeStats } from './parts.js';

const ACTION_KEYS = (bp) => new Set(bp.actions.filter(a => a.key).map(a => a.key));

export class OnlineSession {
  constructor(ui) {
    this.ui = ui;                 // { onLobby(session), onStart(opts), onClosed(reason), status(text) }
    this.net = new Net();
    this.role = null;
    this.players = [];            // host: [{ peer, bp }]; index 0 is the host
    this.settings = { mode: 'duel', map: 'grid', rounds: 2, fill: 8 };
    this.net.onMessage = (peer, msg) => this.onMessage(peer, msg);
    this.net.onPeer = (peer, state) => this.onPeer(peer, state);
    this.reset();
  }
  get available() { return this.net.available; }
  reset() { this.snaps = []; this.offset = null; this.inT = 0; this.snapT = 0; this.battle = null; }

  // ---------- lobby ----------
  async create(myBp) {
    this.role = 'host';
    this.players = [{ peer: 'h', bp: myBp }];
    const code = await this.net.host();
    this.code = code;
    this.ui.onLobby(this);
    return code;
  }
  async join(code, myBp) {
    this.role = 'guest';
    this.myBp = myBp;
    await this.net.join(code.trim().toUpperCase());
    this.code = code.trim().toUpperCase();
    this.net.send('h', { t: 'hello', bp: myBp }, true);
  }
  setMine(bp) {                   // changed my mech in the lobby
    if (this.role === 'host') { this.players[0].bp = bp; this.lobbyChanged(); }
    else if (this.role === 'guest') { this.myBp = bp; this.net.send('h', { t: 'hello', bp }, true); }
  }
  setSettings(s) { Object.assign(this.settings, s); this.lobbyChanged(); }
  lobbyChanged() {
    if (this.role !== 'host') return;
    const players = this.players.map(p => ({ peer: p.peer, name: p.bp.name }));
    this.net.broadcast({ t: 'lobby', players, set: this.settings, code: this.code }, true);
    this.ui.onLobby(this);
  }
  lobbyView() { return this.role === 'host' ? { players: this.players.map(p => ({ peer: p.peer, name: p.bp.name })), set: this.settings, code: this.code } : this.lobby; }

  // host: seats and teams for the chosen mode; empty seats get AI (the host's own roster picks them)
  buildMatch(fillBps) {
    const S = this.settings, P = this.players;
    const seat = (p) => ({ bp: p.bp, remote: p.peer === 'h' ? null : p.peer });
    let fighters;
    if (S.mode === 'duel') fighters = P.slice(0, 2).map((p, i) => ({ ...seat(p), team: i }));
    else if (S.mode === 'ffa') fighters = P.map(seat);
    else {
      const n = S.mode === 'team3' ? 3 : 2;
      fighters = [];
      P.forEach((p, i) => fighters.push({ ...seat(p), team: i % 2 }));          // humans alternate sides
      let k = 0;
      for (const team of [0, 1]) while (fighters.filter(f => f.team === team).length < n) fighters.push({ bp: fillBps[k++ % fillBps.length], team, level: S.fill });
    }
    if (S.mode === 'ffa') { let k = 0; while (fighters.length < 4) fighters.push({ bp: fillBps[k++ % fillBps.length], level: S.fill }); }
    if (S.mode === 'duel' && fighters.length < 2) fighters.push({ bp: fillBps[0], team: 1, level: S.fill });
    // the host plays seat 0; reorder so it is first
    return fighters;
  }

  start(fillBps) {
    if (this.role !== 'host') return;
    this.net.stopPolling();                     // no more joiners once the match is on
    const fighters = this.buildMatch(fillBps);
    const opts = { mode: this.settings.mode === 'ffa' ? 'ffa' : this.settings.mode === 'duel' ? 'duel' : 'team', map: this.settings.map, rounds: this.settings.rounds, fighters };
    for (const p of this.players) {
      if (p.peer === 'h') continue;
      const me = fighters.findIndex(f => f.remote === p.peer);
      if (me < 0) continue;                     // more humans than seats (e.g. 3 in a duel): they watch? not yet
      this.net.send(p.peer, { t: 'start', opts: { ...opts, fighters: fighters.map(f => ({ bp: f.bp, team: f.team, level: f.level })) }, me }, true);
    }
    this.ui.onStart({ ...opts, meIndex: 0, online: this });
  }

  // host went back to the room: guests return to the lobby too; new players may join again
  endMatch() {
    if (this.role !== 'host') return;
    this.battle = null;
    this.net.broadcast({ t: 'end' }, true);
    this.net.startPolling();
    this.lobbyChanged();
  }

  leave() {
    if (this.role === 'host') this.net.broadcast({ t: 'bye' }, true);
    this.role = null;                           // first, so the closing links don't call back into a session that's gone
    this.net.close();
    this.players = []; this.lobby = null;
    this.reset();
  }

  onPeer(peer, state) {
    if (state === 'closed') {
      if (this.role === 'guest') { this.ui.onClosed('和房主的连接断了'); this.leave(); return; }
      this.players = this.players.filter(p => p.peer !== peer);
      // mid-match: that seat becomes an AI so the fight can go on
      const b = this.battle;
      if (b) for (const m of b.mechs) if (m.remote && m.remote.peer === peer) b.takeOverByAI(m, this.settings.fill || 8);
      this.lobbyChanged();
    }
  }

  // ---------- messages ----------
  onMessage(peer, msg) {
    if (this.role === 'host') return this.hostMessage(peer, msg);
    if (this.role === 'guest') return this.guestMessage(msg);
  }

  hostMessage(peer, msg) {
    if (msg.t === 'hello') {
      let bp;
      try { bp = sanitize(msg.bp); } catch { return; }
      const st = computeStats(bp);
      if (st.issues.length) { this.net.send(peer, { t: 'deny', why: '这台机体不能上场：' + st.issues.join('；') }, true); return; }
      const p = this.players.find(x => x.peer === peer);
      if (p) p.bp = bp; else if (this.players.length < CFG.net.maxPlayers) this.players.push({ peer, bp });
      this.lobbyChanged();
      return;
    }
    const b = this.battle;
    if (!b) return;
    const m = b.mechs.find(x => x.remote && x.remote.peer === peer);
    if (!m || m.dead) return;
    const it = m.remote.intent;
    if (msg.t === 'in') {
      if (Array.isArray(msg.mv)) it.move.set(+msg.mv[0] || 0, 0, +msg.mv[1] || 0).clampLength(0, 1);
      if (Number.isFinite(msg.f)) it.face = msg.f;
      it.hover = !!msg.h;
      it.crouch = !!msg.c;
    } else if (msg.t === 'k') {
      const c = String(msg.c);
      if (c === 'Space') { if (msg.d) it.jump = true; return; }
      if (c === 'ShiftLeft' || c === 'ShiftRight') {
        if (msg.d) it.dash = it.move.lengthSq() > 0.01 ? it.move.clone() : new THREE.Vector3(Math.sin(it.face), 0, Math.cos(it.face));
        return;
      }
      if (!m.remote.keys) m.remote.keys = ACTION_KEYS(m.bp);
      if (!m.remote.keys.has(c)) return;
      if (msg.d) m.player.press(c); else m.player.release(c);
    }
  }

  guestMessage(msg) {
    switch (msg.t) {
      case 'lobby': this.lobby = { players: msg.players, set: msg.set, code: msg.code }; this.ui.onLobby(this); break;
      case 'deny': this.ui.status(msg.why); break;
      case 'start': {
        const o = msg.opts;
        o.fighters = o.fighters.map(f => ({ ...f, bp: sanitize(f.bp) }));
        this.reset();
        this.ui.onStart({ ...o, meIndex: msg.me, online: this });
        break;
      }
      case 'bye': this.ui.onClosed('房主离开了房间'); this.leave(); break;
      case 'end': this.battle = null; this.snaps = []; this.ui.onClosed('房主回到了房间，等他开下一局'); break;
      default: if (this.battle) this.guestEvent(this.battle, msg);
    }
  }

  // ---------- in the match: called by Battle ----------
  send(msg, reliable) {
    if (this.role === 'host') this.net.broadcast(msg, reliable);
    else if (this.role === 'guest') this.net.send('h', msg, reliable);
  }

  onSpawn(b) {
    this.battle = b;
    this.snaps = [];
    if (this.role !== 'host') return;
    const C = b.combat;
    const v3 = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    C.onHit = (o, part, dmg, from, at, dir) => this.send({ t: 'hit', o: o.index, id: part.id, p: v3(at), d: v3(dir), dmg: +dmg.toFixed(1), ink: from && from.ink ? 1 : 0 }, true);
    C.onCut = (o, s, at) => this.send({ t: 'cut', o: o.index, p: v3(at || s.pos) }, true);
    C.onShot = (s) => this.send({ t: 'shot', id: s.nid, ty: s.type, o: s.owner.index, p: v3(s.pos), v: v3(s.vel), r: +s.r.toFixed(3), l: +s.life.toFixed(2) }, true);
    C.onShotEnd = (s) => this.send({ t: 'sx', id: s.nid, p: v3(s.pos) }, true);
    for (const m of b.mechs) {
      const prev = m.onBreak;
      m.onBreak = (rec, world) => { prev && prev(rec, world); this.send({ t: 'brk', m: m.index, id: rec.id }, true); };
      const prevD = m.onDeath;                  // the core going doesn't pass through onBreak
      m.onDeath = () => { this.send({ t: 'ko', m: m.index }, true); prevD && prevD(); };
    }
  }

  hostTick(b, dt) {
    this.snapT += dt;
    if (this.snapT < 1 / CFG.net.rate) return;
    this.snapT = 0;
    this.send({ t: 's', ht: performance.now(), T: +b.roundT.toFixed(2), m: b.mechs.map(m => m.netState()) }, false);
  }

  key(code, down) {
    const b = this.battle;
    if (!b) return;
    if (!this.myKeys) this.myKeys = ACTION_KEYS(b.me.bp);
    if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight' || this.myKeys.has(code)) this.send({ t: 'k', c: code, d: down ? 1 : 0 }, true);
  }

  guestEvent(b, msg) {
    const M = b.mechs;
    switch (msg.t) {
      case 's': {
        // host clock -> local clock: the smallest (arrival - sent) seen so far is the closest to pure latency
        const now = performance.now(), off = now - msg.ht;
        if (this.offset === null || off < this.offset) this.offset = off;
        this.snaps.push({ t: msg.ht + this.offset, T: msg.T, m: msg.m });
        if (this.snaps.length > 30) this.snaps.shift();
        break;
      }
      case 'brk': { const m = M[msg.m], r = m && m.parts.get(msg.id); if (r && (r.alive || r === m.coreRec)) m.breakOff(r, null); break; }
      case 'hit': {
        const o = M[msg.o]; if (!o) break;
        const at = new THREE.Vector3(...msg.p), dir = new THREE.Vector3(...msg.d);
        o.flashPart(o.parts.get(msg.id));
        if (msg.ink) { b.fx.splash(at, dir, Math.min(9, 3 + msg.dmg * 0.22), '#121a1c', 0.28, 5); b.fx.stain(at.x + dir.x, at.z + dir.z, 0.6 + msg.dmg * 0.04); }
        else { b.fx.sparks(at, dir, Math.min(16, 5 + msg.dmg * 0.4), '#ffc27a', 0.2, 9); b.fx.flare(at, '#ffb36b', 0.5 + msg.dmg * 0.025); }
        b.combat.shake = Math.max(b.combat.shake, Math.min(0.5, msg.dmg / 50));
        break;
      }
      case 'cut': {
        const o = M[msg.o], at = new THREE.Vector3(...msg.p);
        if (o && o.ink) b.fx.splash(at, null, 8, '#e6fffa', 0.35, 7); else b.fx.sparks(at, null, 10, '#7ff5ea', 0.2, 8);
        b.fx.flare(at, '#ffffff', 1.2);
        break;
      }
      case 'shot': {
        const o = M[msg.o]; if (!o) break;
        const s = b.combat.spawn(msg.ty, o, new THREE.Vector3(...msg.p), new THREE.Vector3(...msg.v), msg.r, 0, msg.l);
        s.nid = msg.id;
        break;
      }
      case 'sx': b.combat.endShot(msg.id, msg.p); break;
      case 'ko': { const m = M[msg.m]; if (m && !m.dead) { m.coreRec.alive = false; m.die(); } break; }
      case 'round': b.endRound(msg.w === null ? undefined : msg.w); break;
      case 'next': b.nextRound(); break;
    }
  }

  // interpolated poses, CFG.net.delay behind the newest snapshot
  sample() {
    const S = this.snaps;
    if (!S.length) return null;
    const rt = performance.now() - CFG.net.delay * 1000;
    if (rt <= S[0].t || S.length === 1) return S[0];
    for (let i = S.length - 1; i > 0; i--) {
      const a = S[i - 1], b = S[i];
      if (rt >= a.t && rt <= b.t) {
        const u = (rt - a.t) / Math.max(1, b.t - a.t);
        return { T: b.T, m: b.m.map((B, k) => { const A = a.m[k]; return A && A.length === B.length ? lerpState(A, B, u) : B; }) };
      }
    }
    return S[S.length - 1];
  }

  guestUpdate(b, rawDt) {
    const dt = Math.min(rawDt, 1 / 20);
    b.t += dt;
    // my inputs
    const it = b.playerIntent();
    this.inT += rawDt;
    if (this.inT >= 1 / CFG.net.inputRate) {
      this.inT = 0;
      this.send({ t: 'in', mv: [+it.move.x.toFixed(3), +it.move.z.toFixed(3)], f: +it.face.toFixed(3), h: it.hover ? 1 : 0, c: it.crouch ? 1 : 0 }, false);
    }
    it.jump = false;
    // everyone's pose
    const P = this.sample();
    if (P) { b.roundT = P.T; P.m.forEach((st, i) => b.mechs[i] && b.mechs[i].applyNet(st, dt)); }
    for (const m of b.mechs) m.updateDebris(dt);
    b.combat.update(dt);
    const sun = b.env.userData.sun;
    if (sun) { const LD = sun.position.clone().sub(sun.target.position).normalize(); sun.target.position.copy(b.me.pos); sun.position.copy(b.me.pos).addScaledVector(LD, 60); }
    b.arena.update && b.arena.update(dt, b);
    b.fx.update(dt);
    if (b.over) b.overT += rawDt;
    b.updateCamera(rawDt);
    b.updateHud();
  }
}

function lerpState(A, B, u) {
  const out = new Array(B.length);
  for (let i = 0; i < B.length; i++) {
    if (i === 8) { out[i] = B[i]; continue; }                        // phantom on/off: no in-between
    if (i === 3) { let d = B[i] - A[i]; d = Math.atan2(Math.sin(d), Math.cos(d)); out[i] = A[i] + d * u; continue; }   // yaw
    out[i] = A[i] + (B[i] - A[i]) * u;
  }
  return out;
}
