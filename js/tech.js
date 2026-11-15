// js/tech.js — the game's own look: dark sci-fi arena, metal materials, glow FX.
// (极点 is the exception: it renders with ink.js. A mech's bp.style picks which.)

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CFG } from './config.js';
import { FOG, LIGHT_DIR } from './ink.js';

export const TECH = {
  sky: '#0c141b', horizon: '#22323d', fog: '#1b2730', floor: '#17222a',
  cyan: '#3de0d0', orange: '#ff8a3d', violet: '#9b7bff',
};

export function techMaterial(hex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    metalness: opts.glow ? 0 : (opts.metal ?? 0.55),
    roughness: opts.glow ? 0.4 : (opts.rough ?? 0.36),
    emissive: opts.glow ? new THREE.Color(hex) : new THREE.Color(0, 0, 0),
    emissiveIntensity: opts.glow ? 2.2 : 1,
    envMapIntensity: 0.9,
  });
  // faint panel seams in object space so big plates don't read as plastic
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        vec3 q = abs(fract(vObj * 3.0 + 0.5) - 0.5);
        float seam = 1.0 - smoothstep(0.0, 0.035, min(q.x, min(q.y, q.z)));
        diffuseColor.rgb *= 1.0 - seam * ${opts.glow ? '0.0' : '0.28'};
        roughnessFactor = mix(roughnessFactor, 0.8, seam);`);
  };
  return m;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const GLOW_TEX = typeof document !== 'undefined' ? glowTexture() : null;

export function buildTechEnvironment(scene, renderer) {
  const sky = new THREE.Color(TECH.fog);
  scene.background = sky.clone();
  scene.fog = new THREE.Fog(TECH.fog, 45, 190);
  FOG.uMist.value.set(TECH.fog);
  FOG.uFogNear.value = 45; FOG.uFogFar.value = 190;
  if (renderer) {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  scene.environmentIntensity = 0.55;
  const g = new THREE.Group();
  g.add(new THREE.HemisphereLight('#a9cfe0', '#141b20', 1.0));
  const sun = new THREE.DirectionalLight('#eaf4ff', 2.4);
  sun.position.copy(LIGHT_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  g.add(sun); g.add(sun.target);
  const rim = new THREE.DirectionalLight(TECH.orange, 0.9);
  rim.position.set(-40, 20, -50);
  g.add(rim);

  // sky dome: dark zenith, teal haze at the horizon
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: new THREE.Color(TECH.sky) }, uHor: { value: new THREE.Color(TECH.horizon) }, uGlow: { value: new THREE.Color(TECH.cyan) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop,uHor,uGlow; varying vec3 vP;
      void main(){ float h = clamp(vP.y, 0.0, 1.0);
        vec3 c = mix(uHor, uTop, smoothstep(0.0, 0.45, h));
        c += uGlow * 0.06 * exp(-abs(vP.y) * 18.0);
        gl_FragColor = vec4(c, 1.0); }`,
  }));
  dome.renderOrder = -20;
  g.add(dome);

  // floor: panels, a fine grid, brighter major lines, and a glowing arena ring
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color(TECH.floor) }, uLine: { value: new THREE.Color(TECH.cyan) }, uWarn: { value: new THREE.Color(TECH.orange) },
      uR: { value: CFG.arena.radius }, uFog: { value: new THREE.Color(TECH.fog) }, uTime: { value: 0 },
      ...THREE.UniformsLib.lights },
    lights: true,
    vertexShader: `#include <common>
      #include <shadowmap_pars_vertex>
      varying vec3 vW;
      void main(){ vec4 worldPosition = modelMatrix*vec4(position,1.0); vW = worldPosition.xyz;
        vec3 transformedNormal = normalMatrix * vec3(0.0,1.0,0.0); vec3 objectNormal = vec3(0.0,1.0,0.0);
        #include <shadowmap_vertex>
        gl_Position = projectionMatrix*viewMatrix*worldPosition; }`,
    fragmentShader: `#include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform vec3 uBase,uLine,uWarn,uFog; uniform float uR, uTime; varying vec3 vW;
      float grid(vec2 p, float s, float w){ vec2 g = abs(fract(p/s - 0.5) - 0.5)*s; return 1.0 - smoothstep(0.0, w, min(g.x, g.y)); }
      void main(){
        vec2 p = vW.xz; float r = length(p);
        vec2 cell = floor(p/4.0); float n = fract(sin(dot(cell, vec2(12.9898,78.233)))*43758.5453);
        vec3 c = uBase * (0.85 + 0.3*n);
        c = mix(c, uBase*0.55, grid(p, 4.0, 0.06));
        float inside = 1.0 - smoothstep(uR - 0.5, uR + 0.5, r);
        c += uLine * grid(p, 1.0, 0.012) * 0.05 * inside;
        c += uLine * grid(p, 8.0, 0.035) * 0.22 * inside;
        float ring = exp(-abs(r - uR) * 3.0);
        c += uLine * ring * 0.9;
        c += uWarn * exp(-abs(r - uR - 1.2) * 6.0) * 0.35;
        c += uLine * exp(-abs(r - 6.0) * 6.0) * 0.12 * (0.5 + 0.5*sin(atan(p.y,p.x)*24.0));
        c *= 0.45 + 0.55*getShadowMask();
        float d = length(vW - cameraPosition);
        c = mix(c, uFog, smoothstep(45.0, 190.0, d));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  floor.receiveShadow = true;
  g.add(floor);

  // energy wall at the arena edge
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(CFG.arena.radius, CFG.arena.radius, 7, 128, 1, true), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uC: { value: new THREE.Color(TECH.cyan) } },
    vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uC; varying vec2 vU;
      void main(){ float a = pow(1.0 - vU.y, 3.0) * 0.35; a *= 0.6 + 0.4*step(0.5, fract(vU.x*180.0));
        gl_FragColor = vec4(uC * a, a); }`,
  }));
  wall.position.y = 3.5;
  g.add(wall);

  // skyline: towers with lit strips, far outside the arena
  const N = 70;
  const tower = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#141c22', metalness: 0.6, roughness: 0.5 }), N);
  const strip = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: TECH.cyan, fog: true }), N);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rnd() * 0.05, R = 110 + rnd() * 90, h = 14 + rnd() * rnd() * 70, w = 6 + rnd() * 12;
    p.set(Math.cos(a) * R, h / 2, Math.sin(a) * R); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a); s.set(w, h, w * 0.7);
    tower.setMatrixAt(i, M.compose(p, q, s));
    p.y = h * (0.55 + rnd() * 0.4); s.set(w * 1.02, 0.25 + rnd() * 0.4, w * 0.72);
    strip.setMatrixAt(i, M.compose(p, q, s));
    strip.setColorAt(i, new THREE.Color(rnd() < 0.25 ? TECH.orange : TECH.cyan));
  }
  g.add(tower, strip);
  scene.add(g);
  g.userData.sun = sun; g.userData.floor = floor; g.userData.wall = wall;
  return g;
}

// 幻影: the ghost of a lost weapon for tech mechs — an additive hologram with scanlines, a hot rim and flicker.
export function techPhantomMaterial(hex, shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uTime: shared.uTime },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
        float scan = 0.55 + 0.45*step(0.5, fract(vW.y*14.0 - uTime*3.0));
        float flick = 0.85 + 0.15*sin(uTime*37.0) * sin(uTime*11.0);
        float a = (0.14 + 0.85*rim) * scan * flick;
        gl_FragColor = vec4(uColor * a * 1.2, a);
      }`,
  });
}
