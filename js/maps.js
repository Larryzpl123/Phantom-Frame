// js/maps.js — arenas. Each map builds its scenery and may add solid obstacles.
// The arena radius is set per map (CFG.arena.radius is read by the mechs' boundary clamp).
//
// Obstacles ("blockers") are plain data, so the same rules apply to everyone:
//   { kind: 'cyl', x, z, r, h }                 a round pillar
//   { kind: 'box', x, z, hx, hz, h, steer }     an axis-aligned block / wall (steer:false = AI doesn't route around it, e.g. a long wall)
// They stop mechs (collide), stop bullets / shells / gravity balls below their height (blocks), and the AI
// slides its move direction around round-ish ones (steer). Melee weapons pass through: a swing isn't stopped by a wall.
//
// Arena hooks used by battle.js: place(pos) for spawns, collide(mechs), steer(m, move), blocks(point),
// update(dt, battle) every frame.

import * as THREE from 'three';
import { CFG } from './config.js';
import { buildTechEnvironment, TECH } from './tech.js';

export const MAPS = {
  grid:     { name: '网格竞技场', desc: '开阔圆形场地，没有掩体', radius: 46 },
  pillars:  { name: '碑林', desc: '九根高柱挡子弹：近战能绕柱贴身，远程要找角度', radius: 40 },
  corridor: { name: '长廊', desc: '16 米宽的长通道，没法绕侧；矮掩体只挡低处的弹道', radius: 44 },
  shrink:   { name: '收缩环', desc: '边界从 20 秒开始收，90 秒时只剩 16 米：躲不了一整局', radius: 48 },
};
export const MAP_KEYS = Object.keys(MAPS);

const SHRINK = { from: 48, to: 16, t0: 20, t1: 90 };

export function buildArena(scene, renderer, key = 'grid') {
  const M = MAPS[key] ? MAPS[key] : MAPS.grid;
  key = MAPS[key] ? key : 'grid';
  CFG.arena.radius = M.radius;
  const group = buildTechEnvironment(scene, renderer);
  const arena = { group, key, radius: M.radius, blockers: [] };
  const B = arena.blockers;

  if (key === 'pillars') {
    B.push({ kind: 'cyl', x: 0, z: 0, r: 2.4, h: 10 });
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * Math.PI * 2, R = i % 2 ? 22 : 13;
      B.push({ kind: 'cyl', x: Math.sin(a) * R, z: Math.cos(a) * R, r: i % 2 ? 2.0 : 1.6, h: 9 });
    }
  } else if (key === 'corridor') {
    const W = 8;                                                   // half width
    B.push({ kind: 'box', x: -W - 1, z: 0, hx: 1, hz: 60, h: 8, steer: false, wall: true });
    B.push({ kind: 'box', x: W + 1, z: 0, hx: 1, hz: 60, h: 8, steer: false, wall: true });
    for (const [x, z] of [[-3.5, -5], [3.5, 5], [-3, 20], [3, -20]]) B.push({ kind: 'box', x, z, hx: 1.8, hz: 0.7, h: 2.6 });
    arena.place = (p) => { p.x = Math.max(-W + 2, Math.min(W - 2, p.x)); };
  }

  for (const b of B) group.add(blockerMesh(b));
  if (B.length) {
    arena.collide = (mechs) => collide(B, mechs);
    arena.steer = (m, move) => steer(B, m, move);
    arena.blocks = (p) => blocks(B, p);
  }

  if (key === 'shrink') {
    const floor = group.userData.floor, wall = group.userData.wall;
    arena.update = (dt, battle) => {
      const t = battle ? battle.roundT : 0;
      const u = Math.min(1, Math.max(0, (t - SHRINK.t0) / (SHRINK.t1 - SHRINK.t0)));
      const R = SHRINK.from + (SHRINK.to - SHRINK.from) * u * (2 - u);   // eases out: fast at first, then slow
      CFG.arena.radius = R;
      if (floor) floor.material.uniforms.uR.value = R;
      if (wall) wall.scale.set(R / SHRINK.from, 1, R / SHRINK.from);
      if (battle && u > 0 && u < 1 && !arena.warned) { arena.warned = true; battle.flash && battle.flash('边界收缩'); }
      if (t < SHRINK.t0) arena.warned = false;
    };
  }

  // pillars between the camera and the player fade out so they never hide the fight
  if (B.length) {
    const prev = arena.update;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    arena.update = (dt, battle) => {
      prev && prev(dt, battle);
      if (!battle || !battle.camera || !battle.me) return;
      a.copy(battle.camera.position); b.copy(battle.me.pos);
      for (const k of B) {
        if (!k.mesh || k.wall) continue;
        const d = segPointDist2D(a.x, a.z, b.x, b.z, k.x, k.z);
        const rr = (k.kind === 'cyl' ? k.r : Math.max(k.hx, k.hz)) + 0.8;
        const want = d < rr ? 0.22 : 1;
        k.fade = (k.fade ?? 1) + (want - (k.fade ?? 1)) * Math.min(1, dt * 8);
        for (const mt of k.mats) { mt.opacity = mt.userData.base * k.fade; mt.transparent = k.fade < 0.99; mt.depthWrite = k.fade >= 0.99; }
      }
    };
  }
  return arena;
}

// ---------- geometry ----------
function blockerMesh(b) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: '#1f2b33', metalness: 0.55, roughness: 0.45 });
  const glow = new THREE.MeshBasicMaterial({ color: b.wall ? TECH.orange : TECH.cyan });
  body.userData.base = 1; glow.userData.base = 1;
  b.mats = [body, glow];
  if (b.kind === 'cyl') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r * 1.06, b.h, 32), body);
    m.position.y = b.h / 2; m.castShadow = m.receiveShadow = true; g.add(m);
    for (const y of [0.35, b.h * 0.62, b.h - 0.3]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(b.r * 1.015, b.r * 1.015, 0.12, 32, 1, true), glow);
      ring.position.y = y; g.add(ring);
    }
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2, b.h, b.hz * 2), body);
    m.position.y = b.h / 2; m.castShadow = m.receiveShadow = true; g.add(m);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2 + 0.04, 0.1, b.hz * 2 + 0.04), glow);
    strip.position.y = b.h - 0.12; g.add(strip);
  }
  g.position.set(b.x, 0, b.z);
  b.mesh = g;
  return g;
}

// ---------- rules ----------
// closest point of a blocker to (x, z) in the ground plane, and how far away it is
function nearest(b, x, z, out) {
  if (b.kind === 'cyl') {
    let dx = x - b.x, dz = z - b.z, L = Math.hypot(dx, dz);
    if (L < 1e-6) { dx = 1; dz = 0; L = 1e-6; out.nx = 1; out.nz = 0; } else { out.nx = dx / L; out.nz = dz / L; }
    out.x = b.x + out.nx * b.r; out.z = b.z + out.nz * b.r;
    out.d = L - b.r;
    return out;
  }
  const cx = Math.max(b.x - b.hx, Math.min(b.x + b.hx, x)), cz = Math.max(b.z - b.hz, Math.min(b.z + b.hz, z));
  let dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz);
  if (L < 1e-6) {                                                  // centre inside the box: push out the short way
    const px = b.hx - Math.abs(x - b.x), pz = b.hz - Math.abs(z - b.z);
    if (px < pz) { dx = Math.sign(x - b.x) || 1; dz = 0; L = -px; } else { dx = 0; dz = Math.sign(z - b.z) || 1; L = -pz; }
    out.x = x; out.z = z; out.d = L; out.nx = dx; out.nz = dz;
    return out;
  }
  out.x = cx; out.z = cz; out.d = L; out.nx = dx / L; out.nz = dz / L;
  return out;
}

const _n = {};
function collide(B, mechs) {
  for (const m of mechs) {
    if (m.dead) continue;
    const r = Math.min(m.radius, 1.4);                             // body, not leg spread: legs may straddle a pillar edge
    for (const b of B) {
      if (m.pos.y > b.h) continue;
      nearest(b, m.pos.x, m.pos.z, _n);
      if (_n.d >= r) continue;
      const push = r - _n.d;
      m.pos.x += _n.nx * push; m.pos.z += _n.nz * push;
      const vn = m.vel.x * _n.nx + m.vel.z * _n.nz;                // kill velocity into the obstacle, keep the slide along it
      if (vn < 0) { m.vel.x -= vn * _n.nx; m.vel.z -= vn * _n.nz; }
    }
  }
}

function blocks(B, p) {
  for (const b of B) {
    if (p.y > b.h || p.y < 0) continue;
    if (b.kind === 'cyl' ? Math.hypot(p.x - b.x, p.z - b.z) < b.r : Math.abs(p.x - b.x) < b.hx && Math.abs(p.z - b.z) < b.hz) return true;
  }
  return false;
}

// AI only: if the move heads into an obstacle within a few metres, turn it to slide past on the nearer side
function steer(B, m, move) {
  const L = Math.hypot(move.x, move.z);
  if (L < 0.05) return;
  const dx = move.x / L, dz = move.z / L, look = 4.5, r = Math.min(m.radius, 1.4) + 0.4;
  for (const b of B) {
    if (b.steer === false) continue;
    const R = (b.kind === 'cyl' ? b.r : Math.hypot(b.hx, b.hz)) + r;
    const ox = b.x - m.pos.x, oz = b.z - m.pos.z;
    const along = ox * dx + oz * dz;
    if (along < 0 || along > look + R) continue;
    const side = ox * dz - oz * dx;                                // >0: obstacle on our right
    if (Math.abs(side) > R) continue;
    const s = side > 0 ? -1 : 1;                                   // go around the side with more room
    const k = 1 - Math.abs(side) / R;
    move.x += -dz * s * k * 1.4 * L; move.z += dx * s * k * 1.4 * L;
    const n = Math.hypot(move.x, move.z); if (n > L) { move.x *= L / n; move.z *= L / n; }
  }
}

function segPointDist2D(ax, az, bx, bz, px, pz) {
  const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1e-6;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L2));
  return Math.hypot(ax + vx * t - px, az + vz * t - pz);
}
