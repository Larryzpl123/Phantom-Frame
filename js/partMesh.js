// js/partMesh.js — procedural geometry for every part, built at its real size (so rounded corners stay round
// when a part is stretched). Origin = geometric centre, local +Y = the part's outward axis.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARTS } from './parts.js';

const cache = new Map();

// cylinder along Y with filleted rims (no sharp edges anywhere)
function roundCyl(r, h, f, seg = 28) {
  f = Math.min(f, r * 0.95, h / 2 * 0.95);
  const pts = [new THREE.Vector2(0, -h / 2)];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * Math.PI / 2; pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, -h / 2 + f + Math.sin(a) * f)); }
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; pts.push(new THREE.Vector2(r - f + Math.cos(a) * f, h / 2 - f + Math.sin(a) * f)); }
  pts.push(new THREE.Vector2(0, h / 2));
  return new THREE.LatheGeometry(pts, seg);
}

// rounded box with even subdivisions everywhere (RoundedBoxGeometry packs its vertices into the corners,
// which makes taper/leaf/bend come out as straight facets). Each vertex is pushed onto the rounded surface:
// clamp to the inner box, then step out by r along the offset.
function roundBoxHi(W, H, D, r) {
  const seg = (L) => Math.max(4, Math.min(28, Math.round(L / 0.035)));
  const g = new THREE.BoxGeometry(W, H, D, seg(W), seg(H), seg(D));
  const P = g.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
  const hx = Math.max(0, W / 2 - r), hy = Math.max(0, H / 2 - r), hz = Math.max(0, D / 2 - r);
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    v.sub(c); const L = v.length();
    if (L > 1e-6) v.multiplyScalar(r / L);
    P.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z);
  }
  return g;
}

// lathe a profile given as [radius, y] pairs
function lathe(profile, seg = 28) { return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg); }

// extrude a 2D outline drawn in the (z, y) plane, thickness along X, with rounded edges
function extrudeZY(shape, thick) {
  const bev = Math.min(thick * 0.45, 0.03);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, thick - 2 * bev), bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.9, bevelSegments: 3, curveSegments: 14 });
  g.rotateY(-Math.PI / 2);                // shape.x -> +z, extrusion -> -x
  g.translate((thick - 2 * bev) / 2, 0, 0);
  return g;
}

const norm = (g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k); if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2)); return n; };
const merge = (list) => { const g = mergeGeometries(list.map(norm)); g.computeBoundingBox(); g.computeBoundingSphere(); return g; };

// Shape modifiers for plain shapes (box / round / pole / wedge). All work in the part's own frame, along Y:
//   tp  taper: >0 narrows toward +Y (0.5 -> the +Y end is half as wide), <0 toward -Y
//   tz  narrows only the depth (Z) the same way, for blade-like plates
//   lf  leaf: narrows BOTH ends (parabolic), 1 = pointed leaf; with rounded corners the points stay soft
//   bd  bend: curves the part along Y around the X axis; 1 = a quarter circle, sign picks the side (+Z concave)
// Vertices are welded first so normals stay smooth across the deformed surface.
function deform(g, H, pt) {
  let w = g.clone();
  w.deleteAttribute('normal'); w.deleteAttribute('uv');
  w = mergeVertices(w, 1e-4);
  const P = w.attributes.position;
  const tp = pt.tp || 0, tz = pt.tz || 0, lf = pt.lf || 0, bd = pt.bd || 0;
  const ang = bd * Math.PI / 2, R = ang ? H / ang : 0;
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const u = y / H + 0.5;                                // 0 at -Y end, 1 at +Y end
    const f = (t) => t >= 0 ? 1 - t * u : 1 + t * (1 - u);
    const leaf = 1 - lf * 0.92 * Math.pow(2 * u - 1, 2);
    const k = f(tp) * leaf;
    x *= k; z *= k * f(tz);
    if (ang) { const th = y / R, r = R - z; y = r * Math.sin(th); z = R - r * Math.cos(th); }
    P.setXYZ(i, x, y, z);
  }
  w.computeVertexNormals();
  w.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(P.count * 2), 2));
  return w;
}

export function partGeometry(pt) {
  const P = PARTS[pt.type] || PARTS.block;
  const s = pt.s.map(Math.abs);
  const W = P.size[0] * s[0], H = P.size[1] * s[1], D = P.size[2] * s[2];
  const key = [pt.type, W.toFixed(3), H.toFixed(3), D.toFixed(3), pt.rd ?? '', pt.v ?? '', pt.tp ?? 0, pt.tz ?? 0, pt.lf ?? 0, pt.bd ?? 0].join('|');
  if (cache.has(key)) return cache.get(key);
  let g;
  const shape = pt.type === 'mod' ? 'box' : P.shape;
  switch (shape) {
    case 'box': {
      const r = Math.max(0.004, (pt.rd ?? 0.2) * 0.5 * Math.min(W, H, D) * 0.98);
      g = (pt.tp || pt.tz || pt.lf || pt.bd) ? roundBoxHi(W, H, D, r) : new RoundedBoxGeometry(W, H, D, 4, r);
      break;
    }
    case 'wedge': {
      const sh = new THREE.Shape();
      const b = Math.min(W, H, D) * 0.12;
      sh.moveTo(-D / 2 + b, -H / 2 + b); sh.lineTo(D / 2 - b, -H / 2 + b); sh.lineTo(-D / 2 + b, H / 2 - b); sh.closePath();
      g = extrudeZY(sh, W);
      break;
    }
    case 'round': {
      if (pt.v === 'cylinder') { g = roundCyl(0.5, H, Math.min(W, D) * 0.18); g.scale(W, 1, D); }
      else if (pt.v === 'capsule') {
        const r = Math.min(W, D) / 2, L = Math.max(0.001, H - 2 * r);
        if (pt.lf || pt.bd) {                       // evenly segmented body so leaf/bend can curve it
          const prof = [];
          for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * Math.PI / 2; prof.push([Math.cos(a) * r, -L / 2 + Math.sin(a) * r]); }
          for (let i = 1; i < 16; i++) prof.push([r, -L / 2 + (i / 16) * L]);
          for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; prof.push([Math.cos(a) * r, L / 2 + Math.sin(a) * r]); }
          g = lathe(prof, 24);
        } else g = new THREE.CapsuleGeometry(r, L, 8, 24);
        g.scale(W / (2 * r), 1, D / (2 * r));
      }
      else { g = new THREE.SphereGeometry(0.5, 32, 20); g.scale(W, H, D); }
      break;
    }
    case 'pole': {
      const r = (W + D) / 4;
      g = roundCyl(r, H, r * 0.9, 16);
      break;
    }
    case 'blade': {                       // single edge on +Z, curved, rounded tip
      const sh = new THREE.Shape();
      sh.moveTo(-D * 0.45, -H / 2);
      sh.lineTo(D * 0.4, -H / 2);
      sh.quadraticCurveTo(D * 0.62, H * 0.15, D * 0.12, H * 0.47);
      sh.quadraticCurveTo(-D * 0.1, H * 0.53, -D * 0.3, H * 0.42);
      sh.quadraticCurveTo(-D * 0.2, 0, -D * 0.45, -H / 2);
      g = extrudeZY(sh, W);
      break;
    }
    case 'sword': {                       // symmetric, long taper, small rounded point
      const sh = new THREE.Shape();
      sh.moveTo(-D / 2, -H / 2); sh.lineTo(D / 2, -H / 2);
      sh.lineTo(D * 0.42, H * 0.22);
      sh.quadraticCurveTo(D * 0.3, H * 0.44, D * 0.05, H * 0.495);
      sh.quadraticCurveTo(0, H * 0.505, -D * 0.05, H * 0.495);
      sh.quadraticCurveTo(-D * 0.3, H * 0.44, -D * 0.42, H * 0.22);
      sh.closePath();
      g = extrudeZY(sh, W);
      break;
    }
    case 'gun': {
      const body = new RoundedBoxGeometry(W, H * 0.5, D, 3, Math.min(W, D) * 0.3); body.translate(0, -H * 0.25, 0);
      const br = Math.min(W, D) * 0.24;
      const barrel = roundCyl(br, H * 0.56, br * 0.5, 16); barrel.translate(0, H * 0.22, D * 0.08);
      g = merge([body, barrel]);
      break;
    }
    case 'cannon': {
      const r = Math.min(W, D) / 2;
      const breech = new RoundedBoxGeometry(W, H * 0.3, D, 3, r * 0.45); breech.translate(0, -H * 0.35, 0);
      const barrel = lathe([[0, -H * 0.22], [r * 0.78, -H * 0.22], [r * 0.7, H * 0.35], [r * 0.82, H * 0.42], [r * 0.82, H * 0.48], [r * 0.5, H * 0.5], [r * 0.45, H * 0.4], [0, H * 0.4]], 24);
      g = merge([breech, barrel]);
      break;
    }
    case 'sling': {
      const base = new RoundedBoxGeometry(W * 0.6, H * 0.3, D * 0.6, 3, W * 0.12); base.translate(0, -H * 0.35, 0);
      const parts = [base];
      for (const sx of [-1, 1]) {
        const prong = new THREE.CapsuleGeometry(W * 0.07, H * 0.55, 6, 12);
        prong.rotateZ(sx * 0.32); prong.translate(sx * W * 0.25, H * 0.05, 0);
        parts.push(prong);
      }
      const ring = new THREE.TorusGeometry(W * 0.3, W * 0.05, 10, 32); ring.rotateX(Math.PI / 2); ring.translate(0, H * 0.32, 0);
      parts.push(ring);
      g = merge(parts);
      break;
    }
    case 'thruster': {
      const r = Math.min(W, D) / 2;
      g = lathe([[0, -H / 2], [r * 0.55, -H / 2], [r * 0.62, -H * 0.3], [r * 0.5, -H * 0.1], [r * 0.78, H * 0.3], [r, H * 0.48], [r * 0.9, H / 2], [r * 0.7, H * 0.3], [r * 0.35, -H * 0.05], [0, -H * 0.05]], 24);
      break;
    }
    case 'joint': {
      const r = Math.min(H, D) / 2;
      g = new THREE.CapsuleGeometry(r, Math.max(0.001, W - 2 * r), 6, 18);
      g.rotateZ(Math.PI / 2);
      break;
    }
    case 'wheel': {
      const r = Math.min(W, D) / 2;
      const tire = roundCyl(r, H, H * 0.42, 32);
      const hub = roundCyl(r * 0.45, H * 1.08, H * 0.2, 16);
      g = merge([tire, hub]);
      break;
    }
    default: g = new RoundedBoxGeometry(W, H, D, 3, 0.05);
  }
  if ((pt.tp || pt.tz || pt.lf || pt.bd) && ['box', 'round', 'pole', 'wedge'].includes(shape)) g = deform(g, H, pt);
  g.computeBoundingBox();
  cache.set(key, g);
  return g;
}
