// js/board.js — the online AI Ladder board (client side). The server is Skybreak-Protocol's Cloudflare Worker
// (leaderboard/worker.js, the "幻甲 Phantom Frame" section): same pilots, callsigns and backup codes as Skybreak.
//
// Players never type a name: the server deals a callsign ("Crimson Falcon") that can be rerolled until it is locked
// in, and only locked-in pilots are listed. The mech that cleared each level goes up with it, anonymous (no mech
// name, no move names: see share.js anonymize), and the top 100 can be copied straight into the hangar.
// Any network problem just shows "offline": the game never depends on the board.

import { CFG } from './config.js';

const KEY = 'pf.pilot.v1';

export const Board = {
  url: () => (CFG.board.url || '').replace(/\/+$/, ''),
  get enabled() { return !!this.url(); },
  _fetch: (...a) => globalThis.fetch(...a),

  me() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  setMe(m) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private window */ } },

  async call(path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await this._fetch(this.url() + path, body === undefined
        ? { cache: 'no-store', signal: ctl.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ...data, error: data.error || `HTTP ${r.status}`, status: r.status };
      return data;
    } catch { return { error: 'offline' }; }
    finally { clearTimeout(timer); }
  },

  // register this browser once (id, token, callsign kept in localStorage)
  async ensureId() {
    if (this.me()) return this.me();
    if (!this._reg) this._reg = (async () => {
      const r = await this.call('/register', {});
      if (r.error) return null;
      this.setMe({ id: r.id, token: r.token, callsign: r.callsign, locked: false });
      return this.me();
    })();
    const out = await this._reg; this._reg = null;
    return out;
  },
  auth() { const m = this.me(); return m ? { id: m.id, token: m.token } : null; },

  // a ladder fight is starting: the server notes the time, so a level can't be reported faster than it was played
  async runStart() {
    if (!this.enabled || !(await this.ensureId())) return null;
    const r = await this.call('/run/start', this.auth());
    return r.ticket || null;
  },
  async clear({ level, time, ticket, mech }) {
    if (!this.enabled || !(await this.ensureId())) return { error: 'offline' };
    return this.call('/mech/ladder/clear', { ...this.auth(), ticket, level, time, mech });
  },
  async top() {
    const m = this.me();
    return this.call('/mech/top' + (m ? `?id=${m.id}` : ''));
  },
  async getMech(id) { return this.call(`/mech/get?id=${id}`); },
  async reroll() {
    const m = this.me(); if (!m || m.locked) return { error: 'locked' };
    const r = await this.call('/callsign', this.auth());
    if (!r.error) this.setMe({ ...m, callsign: r.callsign });
    if (r.error === 'callsign locked') this.setMe({ ...m, locked: true });
    return r;
  },
  async lock() {
    const m = this.me(); if (!m) return { error: 'no pilot' };
    const r = await this.call('/lock', this.auth());
    if (!r.error) this.setMe({ ...m, callsign: r.callsign, locked: true });
    return r;
  },
  // the same backup code as Skybreak: a Skybreak pilot can be brought over, and the other way round
  backupCode() { const m = this.me(); return m ? `SKYP-${m.id}-${m.token}` : ''; },
  async restore(text) {
    const mt = String(text || '').match(/SKYP-(\d{1,9})-([0-9a-f]{48})/i);
    if (!mt) return { error: '这不是备份码（应该以 SKYP- 开头）' };
    const id = +mt[1], token = mt[2].toLowerCase();
    const r = await this.call('/whoami', { id, token });
    if (r.error) return { error: r.error === 'offline' ? '连不上排行榜' : '这个备份码不对' };
    this.setMe({ id, token, callsign: r.callsign, locked: !!r.locked });
    return this.me();
  },
};
