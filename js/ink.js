// js/ink.js — the ink-wash (水墨) look: part material, brush outline, paper ground, layered mountains, ink FX.
// Shaders output sRGB values directly (no colour management in ShaderMaterial), so the hex values in config are what you see.

import * as THREE from 'three';
import { CFG } from './config.js';

const NOISE = /* glsl */`
float h31(vec3 p){ p = fract(p*0.3183099+vec3(.1,.2,.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }
`;

const col = (hex) => new THREE.Color().setStyle(hex, THREE.NoColorSpace);
export const LIGHT_DIR = new THREE.Vector3(0.45, 0.85, 0.35).normalize();

// Shared fog uniforms so every material fades into the same mist
export const FOG = { uFogNear: { value: 38 }, uFogFar: { value: 150 }, uMist: { value: col(CFG.ink.mist) } };

export function inkMaterial(hex, shared, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: col(hex) }, uInk: { value: col(CFG.ink.ink) }, uPaper: { value: col(CFG.ink.paper) },
      uLight: { value: LIGHT_DIR }, uGlow: { value: opts.glow ? 1 : 0 }, uWash: { value: opts.wash ?? 0.6 },
      uFlash: shared.uFlash, uFlashColor: shared.uFlashColor, uFade: shared.uFade,
      uBodyInv: shared.uBodyInv, uGround: shared.uGround, uHeight: shared.uHeight,
      ...FOG,
    },
    transparent: !!opts.transparent,
    vertexShader: /* glsl */`
      uniform mat4 uBodyInv;
      varying vec3 vN; varying vec3 vW; varying vec3 vB;
      void main(){
        vec4 w = modelMatrix*vec4(position,1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal);
        vB = (uBodyInv*w).xyz;
        gl_Position = projectionMatrix*viewMatrix*w;
      }`,
    fragmentShader: NOISE + /* glsl */`
      uniform vec3 uBase, uInk, uPaper, uLight, uFlashColor, uMist; uniform float uGlow, uFlash, uFade, uFogNear, uFogFar;
      uniform float uWash, uGround, uHeight;
      varying vec3 vN; varying vec3 vW; varying vec3 vB;
      void main(){
        vec3 N = normalize(vN); if(!gl_FrontFacing) N=-N;
        vec3 V = normalize(cameraPosition - vW);
        float lam = dot(N, uLight)*0.5+0.5;
        float wash = fbm(vW*2.2);
        float streak = fbm(vec3(vW.x*0.6, vW.y*7.0, vW.z*0.6));
        float t = lam + (wash-0.5)*0.42 + (streak-0.5)*0.12;
        vec3 dark = mix(uBase, uInk, 0.74);
        vec3 light = mix(uBase, uPaper, 0.58);
        vec3 c = mix(dark, uBase, smoothstep(0.30, 0.50, t));
        c = mix(c, light, smoothstep(0.70, 0.92, t));
        // 水墨渐变: the body is painted as one wash — ink-black pooled at the feet, bleeding up into 青,
        // thinning to bare paper at the shoulders and head. The boundary wanders (bleed), pigment collects
        // in a darker line at the drying edge, and lighting only nudges where the wash sits.
        float h = (vB.y - uGround)/uHeight;
        float bleed = (fbm(vB*vec3(2.6, 1.1, 2.6) + 7.0) - 0.5)*0.34 + (fbm(vB*9.0 + 2.0) - 0.5)*0.09;
        float g = h + bleed + (lam - 0.5)*0.22;
        vec3 inkC = mix(uInk, uBase, 0.10);
        vec3 pale = mix(uBase, uPaper, 0.8);
        vec3 w = mix(inkC, uBase, smoothstep(0.2, 0.52, g));
        w = mix(w, pale, smoothstep(0.74, 1.0, g));
        w = mix(w, uInk, (1.0 - smoothstep(0.0, 0.03, abs(g - 0.33))) * 0.45);   // wet edge
        float bloom = smoothstep(0.62, 0.8, fbm(vB*2.2 + 3.0));
        w = mix(w, mix(uBase, uInk, 0.5), bloom * 0.3 * smoothstep(0.3, 0.7, g));
        w *= 0.8 + 0.3*lam;
        w *= 1.0 - h31(floor(vW*70.0)) * 0.06;                                      // granulation
        c = mix(c, w, uWash);
        float rim = 1.0 - abs(dot(N, V));
        c = mix(c, uInk, smoothstep(0.62, 1.0, rim + (wash-0.5)*0.3) * 0.7);
        // thin pale edge on the shadow side so the dark lower body still reads against a dark arena
        c = mix(c, mix(uBase, uPaper, 0.6), smoothstep(0.8, 1.0, rim) * (1.0 - lam) * 0.55 * uWash);
        c = mix(c, mix(uBase, vec3(1.0), 0.35), uGlow);
        c = mix(c, uFlashColor, uFlash);
        float d = length(vW - cameraPosition);
        c = mix(c, uMist, smoothstep(uFogNear, uFogFar, d));
        gl_FragColor = vec4(c, 1.0 - uFade);
      }`,
  });
}

export function outlineMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uInk: { value: col(CFG.ink.ink) }, uWidth: { value: 0.022 }, uFade: shared.uFade, ...FOG },
    side: THREE.BackSide,
    transparent: true,
    vertexShader: NOISE + /* glsl */`
      uniform float uWidth; varying float vD; varying vec3 vW;
      void main(){
        vec4 w0 = modelMatrix*vec4(position,1.0);
        vec3 n = normalize(mat3(modelMatrix)*normal);
        float d = length(w0.xyz - cameraPosition);
        float brush = 0.55 + 0.9*fbm(w0.xyz*3.1);
        vec3 p = w0.xyz + n*uWidth*brush*clamp(d/10.0, 1.0, 3.5);
        vD = d; vW = p;
        gl_Position = projectionMatrix*viewMatrix*vec4(p,1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uInk, uMist; uniform float uFade, uFogNear, uFogFar; varying float vD; varying vec3 vW;
      void main(){ vec3 c = mix(uInk, uMist, smoothstep(uFogNear, uFogFar, vD)*0.9); gl_FragColor = vec4(c, 1.0-uFade); }`,
  });
}

export function makeShared() {
  return { uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uFade: { value: 0 },
    uBodyInv: { value: new THREE.Matrix4() }, uGround: { value: 0 }, uHeight: { value: 4 }, uTime: { value: 0 } };
}

// ---------- environment ----------
export function buildEnvironment(scene) {
  scene.background = col(CFG.ink.paper);
  const g = new THREE.Group();

  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: { uPaper: { value: col(CFG.ink.paper) }, uDark: { value: col(CFG.ink.paperDark) }, uInk: { value: col(CFG.ink.ink) },
      uR: { value: CFG.arena.radius }, ...FOG },
    vertexShader: `varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + /* glsl */`
      uniform vec3 uPaper,uDark,uInk,uMist; uniform float uR,uFogNear,uFogFar; varying vec3 vW;
      void main(){
        float n = fbm(vec3(vW.xz*0.045, 1.0));
        float m = fbm(vec3(vW.xz*0.35, 4.0));
        vec3 c = mix(uPaper, uDark, smoothstep(0.45, 0.8, n)*0.8);
        c = mix(c, uInk, smoothstep(0.62, 0.95, n*0.7+m*0.5)*0.10);
        float r = length(vW.xz);
        float ring = 1.0 - smoothstep(0.0, 0.55 + 0.6*m, abs(r - uR));
        c = mix(c, uInk, ring*0.55*(0.5+0.8*fbm(vec3(vW.xz*0.6,9.0))));
        float d = length(vW - cameraPosition);
        c = mix(c, uMist, smoothstep(uFogNear*0.9, uFogFar*0.9, d));
        gl_FragColor = vec4(c,1.0);
      }`,
  }));
  g.add(ground);

  // three rings of mountains: far ones pale, near ones darker; bases dissolve into mist
  const layers = [
    { r: 230, h: 70, base: 0.28, amp: 0.5, freq: 2.2, dark: 0.22, seed: 3.0 },
    { r: 185, h: 52, base: 0.22, amp: 0.55, freq: 3.4, dark: 0.36, seed: 7.0 },
    { r: 140, h: 30, base: 0.18, amp: 0.6, freq: 5.0, dark: 0.55, seed: 11.0 },
  ];
  for (const L of layers) {
    const geo = new THREE.CylinderGeometry(L.r, L.r, L.h, 160, 1, true);
    geo.translate(0, L.h / 2 - 2, 0);
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uInk: { value: col(CFG.ink.ink) }, uMist: FOG.uMist, uH: { value: L.h }, uBase: { value: L.base },
        uAmp: { value: L.amp }, uFreq: { value: L.freq }, uDark: { value: L.dark }, uSeed: { value: L.seed } },
      side: THREE.BackSide, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: NOISE + /* glsl */`
        uniform vec3 uInk,uMist; uniform float uH,uBase,uAmp,uFreq,uDark,uSeed; varying vec3 vW;
        void main(){
          float a = atan(vW.z, vW.x);
          vec3 q = vec3(cos(a)*uFreq, sin(a)*uFreq, uSeed);
          float ridge = uBase + uAmp*pow(fbm(q), 1.6)*1.4;
          float y = (vW.y+2.0)/uH;
          if (y > ridge) discard;
          float depth = clamp((ridge - y)/0.25, 0.0, 1.0);
          float tex = fbm(vec3(q.xy*6.0, y*8.0 + uSeed));
          float mist = smoothstep(0.0, ridge*0.85, y);
          float k = uDark * (0.55 + 0.45*(1.0-depth)) * (0.6+0.6*tex) * mist;
          gl_FragColor = vec4(mix(uMist, uInk, k), 1.0);
        }`,
    }));
    m.renderOrder = -10;
    g.add(m);
  }

  // pale vermilion sun
  const sun = new THREE.Mesh(new THREE.CircleGeometry(9, 48), new THREE.MeshBasicMaterial({ color: CFG.ink.seal, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
  sun.position.set(-120, 70, -170); sun.lookAt(0, 20, 0); sun.renderOrder = -11;
  g.add(sun);

  scene.add(g);
  return g;
}

// ---------- FX: ink blots, splashes, stains, slashes ----------
function blotTexture(seed) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * 34 * (i < 6 ? 0.3 : 1);
    const r = 8 + rnd() * 26 * (i < 6 ? 1.6 : 0.6);
    const gx = 64 + Math.cos(a) * d, gy = 64 + Math.sin(a) * d;
    const gr = x.createRadialGradient(gx, gy, 0, gx, gy, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(gx, gy, r, 0, Math.PI * 2); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.tex = [1, 2, 3, 4].map(blotTexture);
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    this.glow = new THREE.CanvasTexture(c); this.glow.colorSpace = THREE.SRGBColorSpace;
    this.sprites = [];
    this.stains = [];
    this.trails = [];
  }

  // ink spray: n blots flying out from p along dir
  // tech sparks: additive, fast, falling
  sparks(p, dir, n = 10, hex = '#ffb36b', size = 0.22, speed = 9) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(hex), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 });
      const s = new THREE.Sprite(m);
      s.position.copy(p);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).multiplyScalar(speed);
      if (dir) v.addScaledVector(dir, speed * (0.3 + Math.random() * 0.7));
      const sz = size * (0.5 + Math.random());
      s.scale.setScalar(sz);
      this.scene.add(s);
      this.sprites.push({ s, v, life: 0.25 + Math.random() * 0.35, age: 0, grow: -0.6, sz, grav: 20, op: 1 });
    }
  }

  flare(p, hex = '#ffffff', size = 1.6) {
    const m = new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(hex), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 });
    const s = new THREE.Sprite(m); s.position.copy(p); s.scale.setScalar(size);
    this.scene.add(s);
    this.sprites.push({ s, v: new THREE.Vector3(), life: 0.18, age: 0, grow: 1.2, sz: size, grav: 0, op: 1 });
  }

  splash(p, dir, n = 12, hex = CFG.ink.ink, size = 0.5, speed = 6) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.SpriteMaterial({ map: this.tex[i % 4], color: new THREE.Color(hex), transparent: true, depthWrite: false, opacity: 0.62 });
      const s = new THREE.Sprite(m);
      s.position.copy(p);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(speed);
      if (dir) v.addScaledVector(dir, speed * (0.4 + Math.random() * 0.8));
      const sz = size * (0.4 + Math.random());
      s.scale.setScalar(sz);
      this.scene.add(s);
      this.sprites.push({ s, v, life: 0.5 + Math.random() * 0.5, age: 0, grow: 1.8 + Math.random() * 2, sz, grav: 9 });
    }
  }

  puff(p, hex = CFG.ink.ink, size = 0.8, opacity = 0.35) {
    const m = new THREE.SpriteMaterial({ map: this.tex[(Math.random() * 4) | 0], color: new THREE.Color(hex), transparent: true, depthWrite: false, opacity });
    const s = new THREE.Sprite(m);
    s.position.copy(p); s.scale.setScalar(size);
    this.scene.add(s);
    this.sprites.push({ s, v: new THREE.Vector3(0, 0.6, 0), life: 0.7, age: 0, grow: 1.6, sz: size, grav: -0.5, op: opacity });
  }

  stain(x, z, size = 1.6, hex = CFG.ink.ink) {
    const m = new THREE.MeshBasicMaterial({ map: this.tex[(Math.random() * 4) | 0], color: new THREE.Color(hex), transparent: true, depthWrite: false, opacity: 0.5 });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), m);
    q.rotation.y = Math.random() * 6.28;
    q.position.set(x, 0.02 + Math.random() * 0.01, z);
    this.scene.add(q);
    this.stains.push({ q, age: 0, life: 14 });
    if (this.stains.length > 60) { const o = this.stains.shift(); this.scene.remove(o.q); o.q.material.dispose(); }
  }

  // ribbon that follows two points (edge base + tip) while an edge is moving fast
  makeTrail(hex, additive = false) {
    const N = 16;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 2 * 4), 4));
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const t = { mesh, N, pts: [], color: new THREE.Color(hex), on: 0 };
    this.trails.push(t);
    return t;
  }

  pushTrail(t, a, b, active) {
    t.on += ((active ? 1 : 0) - t.on) * 0.35;
    t.pts.unshift([a.clone(), b.clone()]);
    if (t.pts.length > t.N) t.pts.length = t.N;
  }

  update(dt) {
    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const o = this.sprites[i];
      o.age += dt;
      const u = o.age / o.life;
      if (u >= 1) { this.scene.remove(o.s); o.s.material.dispose(); this.sprites.splice(i, 1); continue; }
      o.v.y -= o.grav * dt;
      o.v.multiplyScalar(1 - 2.5 * dt);
      o.s.position.addScaledVector(o.v, dt);
      o.s.scale.setScalar(o.sz * (1 + o.grow * u));
      o.s.material.opacity = (o.op ?? 0.62) * (1 - u * u);
    }
    for (const s of this.stains) { s.age += dt; s.q.material.opacity = 0.5 * Math.max(0, 1 - s.age / s.life); }
    for (const t of this.trails) {
      const P = t.mesh.geometry.attributes.position, C = t.mesh.geometry.attributes.color;
      const n = t.pts.length;
      for (let i = 0; i < t.N; i++) {
        const q = t.pts[Math.min(i, n - 1)];
        if (!q) continue;
        P.setXYZ(i * 2, q[0].x, q[0].y, q[0].z); P.setXYZ(i * 2 + 1, q[1].x, q[1].y, q[1].z);
        const a = t.on * Math.pow(1 - i / t.N, 1.6) * (i < n ? 1 : 0);
        C.setXYZW(i * 2, t.color.r, t.color.g, t.color.b, a * 0.15);
        C.setXYZW(i * 2 + 1, t.color.r, t.color.g, t.color.b, a * 0.75);
      }
      P.needsUpdate = true; C.needsUpdate = true;
    }
  }

  clear() {
    for (const o of this.sprites) { this.scene.remove(o.s); o.s.material.dispose(); }
    for (const s of this.stains) { this.scene.remove(s.q); s.q.material.dispose(); }
    for (const t of this.trails) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); }
    this.sprites = []; this.stains = []; this.trails = [];
  }
}

// 墨影: the ghost of a lost weapon for ink mechs — translucent ink smoke that drifts off the surface,
// darker at the core, pale paper-light on the silhouette.
export function inkPhantomMaterial(hex, shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uBase: { value: col(hex) }, uInk: { value: col(CFG.ink.ink) }, uPaper: { value: col(CFG.ink.paper) }, uTime: shared.uTime, ...FOG },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + /* glsl */`
      uniform vec3 uBase, uInk, uPaper, uMist; uniform float uTime, uFogNear, uFogFar; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
        float rim = 1.0 - abs(dot(N, V));
        float smoke = fbm(vW*2.6 + vec3(0.0, uTime*0.9, uTime*0.3));
        float wisp = smoothstep(0.35, 0.75, smoke + rim*0.35);
        vec3 c = mix(mix(uInk, uBase, 0.45), mix(uBase, uPaper, 0.85), smoothstep(0.35, 0.95, rim + (smoke - 0.5)*0.4));
        float a = (0.3 + 0.6*wisp) * (0.8 + 0.2*sin(uTime*7.0 + vW.y*3.0));
        c = mix(c, uMist, smoothstep(uFogNear, uFogFar, length(vW - cameraPosition)));
        gl_FragColor = vec4(c, a);
      }`,
  });
}
