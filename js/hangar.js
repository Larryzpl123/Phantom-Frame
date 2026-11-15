// js/hangar.js — the builder: freeform placement on any face, a transform gizmo with snapping,
// numeric inspector, mirror mode, undo/redo, and the keyframe action editor.
// It only edits the blueprint; all numbers come from parts.js so the hangar and the battle always agree.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PARTS, PLACEABLE, halfExtents, partLoad, restMatrix } from './parts.js';
import { addPart, removePart, updatePart, makePart, emptyBlueprint, clone, unlinkMirror } from './blueprint.js';
import { Mech } from './mech.js';
import { buildTechEnvironment } from './tech.js';
import { ActionPlayer, sampleJoint, sampleYaw, actionLength, servo } from './actions.js';
import { saveBuild, exportFile, importFile, roster } from './save.js';
import { CFG, DEFAULT_PALETTE } from './config.js';
import { partGeometry } from './partMesh.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const AX = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEYLABEL = (c) => !c ? '—' : c.replace('Key', '').replace('Digit', '');
const SLOT_NAMES = { armor: '装甲', frame: '骨架', light: '浅色', accent: '点缀', steel: '钢', ink: '墨', glow: '发光' };

export class Hangar {
  constructor(renderer, opts) {
    this.renderer = renderer; this.opts = opts;
    this.scene = new THREE.Scene();
    this.env = buildTechEnvironment(this.scene, renderer);
    this.env.userData.sun.target.position.set(0, 0, 0);
    this.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 600);
    this.camera.position.set(6, 4.5, 8);
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.target.set(0, 2, 0);
    this.orbit.enableDamping = true;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.enabled = false;
    this.gizmo = new TransformControls(this.camera, renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.enabled = false;
    this.scene.add(this.gizmo.getHelper());
    this.proxy = new THREE.Group();
    this.proxyBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#ff8a3d' }));
    this.proxy.add(this.proxyBox);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value; if (!e.value) this.commitGizmo(); });
    this.ray = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#3de0d0', transparent: true, opacity: 0.45, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#3de0d0', depthTest: false, transparent: true }));
    this.selBox.renderOrder = 10;
    this.hovBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthTest: false }));
    this.hovBox.renderOrder = 10;
    this.bp = null; this.mech = null; this.hist = []; this.fut = [];
    this.tool = 'place'; this.type = 'block'; this.mirror = true; this.sel = null; this.spin = 0; this.nextScale = [1, 1, 1];
    this.tab = 'build'; this.actId = null; this.keyIdx = 0; this.preview = null; this.binding = false;
    this.hit = null;
    this.bindDom();
  }

  // ---------------- lifecycle ----------------
  show(bp) {
    $('hangar').hidden = false;
    this.orbit.enabled = true; this.gizmo.enabled = true; this.active = true;
    this.hist = []; this.fut = [];
    this.setBp(clone(bp || emptyBlueprint()), false);
    this.renderPalette(); this.refreshLoadSel(); this.renderSide();
  }
  hide() {
    $('hangar').hidden = true; this.active = false;
    this.orbit.enabled = false; this.gizmo.enabled = false; this.gizmo.detach();
  }
  resize() { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }

  setBp(bp, history = true) {
    if (history && this.bp) { this.hist.push(this.bp); if (this.hist.length > 120) this.hist.shift(); this.fut = []; }
    this.bp = bp;
    if (!this.bp.actions) this.bp.actions = [];
    if (this.sel != null && !bp.parts.some(p => p.id === this.sel)) this.sel = null;
    if (this.actId && !bp.actions.some(a => a.id === this.actId)) this.actId = null;
    this.rebuild();
    this.renderSide();
  }
  // edit without rebuilding geometry (actions, names)
  patchBp(fn, history = true) {
    const nb = clone(this.bp); fn(nb);
    if (history) { this.hist.push(this.bp); this.fut = []; }
    this.bp = nb;
    if (this.mech) { this.mech.bp = nb; }
  }
  undo() { if (!this.hist.length) return; this.fut.push(this.bp); this.bp = null; this.setBp(this.hist.pop(), false); }
  redo() { if (!this.fut.length) return; this.hist.push(this.bp); const b = this.fut.pop(); this.bp = null; this.setBp(b, false); }

  rebuild() {
    if (this.mech) this.mech.dispose();
    this.selBox.removeFromParent(); this.hovBox.removeFromParent(); this.proxy.removeFromParent();
    this.mech = new Mech(this.bp, this.scene);
    this.mech.body.position.y = -this.mech.groundY;
    this.mech.body.updateMatrix();
    this.applyPose();
    this.attachSelection();
  }

  // ---------------- pose ----------------
  // build tab: rest pose (all joints 0) so what you click is where the part goes.
  // action tab: the selected keyframe's pose, or the running preview.
  applyPose() {
    const m = this.mech;
    const act = this.tab === 'act' ? this.curAction() : null;
    const key = act ? act.keys[Math.min(this.keyIdx, act.keys.length - 1)] : null;
    const idle = this.bp.actions.find(a => a.mode === 'idle');
    for (const r of m.parts.values()) {
      if (!r.joint) continue;
      let a = 0;
      if (act && key) {
        let v = sampleJoint(act, r.id, key.t);
        if (v === undefined && idle && act !== idle) v = sampleJoint(idle, r.id, actionLength(idle));
        if (typeof v === 'number') a = v;
        else if (v && typeof v === 'object') a = (r.joint.a || 0);
      }
      r.joint.a = a; r.joint.w = 0;
      r.rotor.matrix.makeRotationAxis(AX, a);
    }
    m.root.rotation.y = act && key ? sampleYaw(act, key.t) : 0;
    m.root.updateMatrixWorld(true);
    m.shared.uBodyInv.value.copy(m.body.matrixWorld).invert();
    if (act) { m.player.cur = act; m.solveGrips(); m.player.cur = null; }   // show the second hand on the shaft
  }

  playPreview() {
    const act = this.curAction(); if (!act) return;
    const p = new ActionPlayer(this.bp);
    p.start(act.id);
    if (act.mode === 'hold') p.held.add(act.key || '__hold');
    if (act.mode === 'hold' && !act.key) p.cur = Object.assign({}, act, { key: '__hold' });
    this.preview = { p, t: 0, holdFor: act.mode === 'hold' ? 1.6 : 0, act };
    for (const r of this.mech.parts.values()) if (r.joint) { r.joint.w = 0; }
  }

  update(dt) {
    if (!this.active) return;
    this.orbit.update();
    if (this.preview) {
      const pv = this.preview, m = this.mech;
      pv.t += dt;
      if (pv.holdFor && pv.t > pv.holdFor) { pv.p.held.clear(); }
      pv.p.update(dt);
      for (const r of m.parts.values()) {
        if (!r.joint) continue;
        const spin = r.pt.v === 'spin';
        let tgt = pv.p.target(r.id);
        if (tgt && typeof tgt === 'object' && !spin) tgt = undefined;
        servo(r.joint, tgt, m.stats.omegas[r.id] || CFG.joint.omegaMax, spin ? null : r.pt.lim, dt, CFG.joint.spinAccel);
        r.rotor.matrix.makeRotationAxis(AX, r.joint.a);
      }
      m.root.rotation.y = pv.p.yawOffset();
      m.root.updateMatrixWorld(true);
      m.player.cur = pv.p.cur; m.solveGrips(); m.player.cur = null;
      m.shared.uBodyInv.value.copy(m.body.matrixWorld).invert();
      const ph = $('playhead');
      const L = actionLength(pv.act) || 1;
      if (ph) ph.style.left = (Math.min(1, (pv.p.cur ? pv.p.t : L) / L) * 100) + '%';
      if (!pv.p.cur && pv.t > 0.4) { this.preview = null; setTimeout(() => this.active && !this.preview && this.applyPose(), 500); }
    }
  }
  render() { this.renderer.render(this.scene, this.camera); }

  // ---------------- picking & placing ----------------
  pick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const meshes = [...this.mech.parts.values()].map(x => x.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const id = hit.object.userData.partId;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    return { id, point: hit.point.clone(), normal: n };
  }

  // Where a new part goes. By default it snaps to the parent's frame: the outward axis is the parent axis
  // closest to the face normal, the part sits flush on that face, and it centres on the parent when close —
  // so a sword placed on the end of a pole is straight and centred. Hold Alt for free placement on the surface.
  ghostPart(hit) {
    const T = PARTS[this.type];
    const inv = new THREE.Matrix4().copy(this.mech.body.matrixWorld).invert();
    const p = hit.point.clone().applyMatrix4(inv);
    const n = hit.normal.clone().transformDirection(inv).normalize();
    const s = this.nextScale.slice();
    const H = T.size[1] * Math.abs(s[1]);
    const spinQ = new THREE.Quaternion().setFromAxisAngle(UP, this.spin * DEG);
    const parentPt = this.bp.parts.find(q => q.id === hit.id);
    let q;
    if (!this.freePlace && parentPt) {
      const pq = new THREE.Quaternion().setFromEuler(new THREE.Euler(...parentPt.r.map(x => x * DEG), 'XYZ'));
      const flip = Math.sign(parentPt.s[0]) || 1;                 // mirror images are reflected in local X
      const pos = new THREE.Vector3(...parentPt.p);
      const toLocal = (v) => { const w = v.clone().applyQuaternion(pq.clone().invert()); w.x *= flip; return w; };
      const toBody = (v) => { const w = v.clone(); w.x *= flip; return w.applyQuaternion(pq); };
      const nl = toLocal(n);
      const ax = [Math.abs(nl.x), Math.abs(nl.y), Math.abs(nl.z)];
      const i = ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2;
      const axis = new THREE.Vector3(); axis.setComponent(i, Math.sign(nl.getComponent(i)) || 1);
      const he = halfExtents(parentPt);
      const lp = toLocal(p.clone().sub(pos));
      for (let k = 0; k < 3; k++) {
        if (k === i) { lp.setComponent(k, axis.getComponent(k) * he[k]); continue; }
        const c = lp.getComponent(k);
        lp.setComponent(k, Math.abs(c) < Math.max(0.06, he[k] * 0.25) ? 0 : Math.round(c / 0.05) * 0.05);
      }
      const nb = toBody(axis).normalize();
      p.copy(toBody(lp).add(pos)).addScaledVector(nb, H / 2);
      // keep the new part's frame aligned with the parent's: rotate Y onto the chosen axis by a right angle
      const ql = new THREE.Quaternion().setFromUnitVectors(UP, axis);
      if (flip < 0) { const m = new THREE.Matrix4().makeRotationFromQuaternion(ql); m.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1)).multiply(new THREE.Matrix4().makeScale(-1, 1, 1)); ql.setFromRotationMatrix(m); }
      q = pq.clone().multiply(ql).multiply(spinQ);
    } else {
      q = new THREE.Quaternion().setFromUnitVectors(UP, n).multiply(spinQ);
      p.addScaledVector(n, H / 2);
    }
    const snap = (x) => Math.round(x * 1000) / 1000;
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return makePart(this.type, hit.id, [snap(p.x), snap(p.y), snap(p.z)], [e.x / DEG, e.y / DEG, e.z / DEG].map(x => Math.round(x * 10) / 10), s);
  }

  updateGhost(ev) {
    const hit = this.tool === 'place' ? this.pick(ev) : null;
    this.hit = hit;
    if (!hit || this.tab !== 'build') { this.ghost.visible = false; return; }
    const g = this.ghostPart(hit);
    this.ghost.geometry = partGeometry(g);
    const M = restMatrix(g);
    this.ghost.matrixAutoUpdate = false;
    this.ghost.matrix.copy(this.mech.body.matrixWorld).multiply(M);
    this.ghost.visible = true;
    this.ghostData = g;
  }

  hover(ev) {
    this.lastEv = ev;
    const hit = this.pick(ev);
    this.hovBox.removeFromParent();
    if (hit) {
      const rec = this.mech.parts.get(hit.id);
      const he = rec.he;
      this.hovBox.scale.set(he[0] * 2 + 0.02, he[1] * 2 + 0.02, he[2] * 2 + 0.02);
      rec.node.add(this.hovBox);
    }
    this.hoverId = hit ? hit.id : null;
    this.updateGhost(ev);
  }

  click(ev, button) {
    if (this.gizmo.dragging || this.gizmo.axis) return;
    const hit = this.pick(ev);
    if (button === 2) {
      if (hit && this.tab === 'build') { const pt = this.bp.parts.find(p => p.id === hit.id); if (pt.type === 'core') this.toast('核心不能删'); else this.setBp(removePart(this.bp, hit.id)); }
      return;
    }
    if (this.tab === 'act') {                     // clicking a joint in the action tab highlights its slider
      if (hit) { this.hotJoint = this.nearestJoint(hit.id); this.renderSide(); }
      return;
    }
    if (this.tool === 'place' && hit && this.ghostData) {
      const cost = partLoad(this.ghostData) * (this.mirror && Math.abs(this.ghostData.p[0]) > 0.02 ? 2 : 1);
      const st = this.mech.stats;
      if (st.load + cost > st.budget + 1e-6) this.toast(`超出负载：还剩 ${(st.budget - st.load).toFixed(1)}，这个要 ${cost.toFixed(1)}`);
      const { bp, ids } = addPart(this.bp, this.ghostData, this.mirror);
      this.setBp(bp);
      this.lastPlaced = ids[0];
      return;
    }
    this.select(hit ? hit.id : null);
  }

  nearestJoint(id) {
    const map = new Map(this.bp.parts.map(p => [p.id, p]));
    let p = map.get(id);
    while (p && p.type !== 'joint') p = p.parent != null ? map.get(p.parent) : null;
    return p ? p.id : null;
  }

  // ---------------- selection & gizmo ----------------
  select(id) {
    this.sel = id;
    this.attachSelection();
    this.renderSide();
  }

  attachSelection() {
    this.selBox.removeFromParent(); this.proxy.removeFromParent(); this.gizmo.detach();
    if (this.sel == null || !this.mech) return;
    const rec = this.mech.parts.get(this.sel);
    if (!rec) return;
    const he = rec.he;
    this.selBox.scale.set(he[0] * 2 + 0.03, he[1] * 2 + 0.03, he[2] * 2 + 0.03);
    rec.node.add(this.selBox);
    if (this.tool !== 'select' || this.tab !== 'build' || rec.pt.type === 'core') return;
    // proxy lives in body space with the part's rest transform; the gizmo moves the proxy, we commit on release
    const pt = rec.pt;
    this.mech.body.add(this.proxy);
    this.proxy.position.set(...pt.p);
    this.proxy.rotation.set(pt.r[0] * DEG, pt.r[1] * DEG, pt.r[2] * DEG, 'XYZ');
    this.proxy.scale.set(Math.abs(pt.s[0]), pt.s[1], pt.s[2]);
    const sz = PARTS[pt.type].size;
    this.proxyBox.scale.set(sz[0], sz[1], sz[2]);
    this.gizmo.attach(this.proxy);
    this.applySnap();
  }

  applySnap(fine = false) {
    this.gizmo.setTranslationSnap(fine ? null : CFG.build.snap);
    this.gizmo.setRotationSnap(fine ? null : CFG.build.rotSnap * DEG);
    this.gizmo.setScaleSnap(fine ? null : 0.05);
  }

  commitGizmo() {
    if (this.sel == null) return;
    const pt = this.bp.parts.find(p => p.id === this.sel);
    const P = this.proxy;
    const sx = Math.sign(pt.s[0]) || 1;
    const s = [Math.max(0.05, Math.abs(P.scale.x)) * sx, Math.max(0.05, Math.abs(P.scale.y)), Math.max(0.05, Math.abs(P.scale.z))];
    const e = new THREE.Euler().setFromQuaternion(P.quaternion, 'XYZ');
    this.setBp(updatePart(this.bp, this.sel, {
      p: [P.position.x, P.position.y, P.position.z].map(r3),
      r: [e.x / DEG, e.y / DEG, e.z / DEG].map(x => Math.round(x * 10) / 10),
      s: s.map(r3),
    }));
  }

  // ---------------- input ----------------
  bindDom() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { if (!this.active) return; down = { x: e.clientX, y: e.clientY, b: e.button }; });
    el.addEventListener('pointermove', (e) => { if (!this.active) return; if (!down) this.hover(e); });
    el.addEventListener('pointerup', (e) => {
      if (!this.active || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const b = down.b; down = null;
      if (moved < 5) this.click(e, b);
      this.hover(e);
    });
    $('hNew').onclick = () => { this.setBp(emptyBlueprint()); this.refreshLoadSel(); };
    $('hSave').onclick = async () => {
      const name = ($('bpName').value || '新机体').trim().slice(0, 24);
      if (!/^[0-9A-Za-z_\-\u3400-\u9fff\uf900-\ufaff]{1,24}$/.test(name)) { this.toast('名字只能用中文、字母、数字、- 和 _（它也是文件夹名）'); return; }
      this.bp.name = name;
      const where = await saveBuild(this.bp);
      this.toast(where === 'disk' ? `已保存到「${name}/${name}.json」` : where === 'local' ? `已存到这个浏览器里（不是用 start.command 本地运行，写不进文件夹）` : '保存失败');
      this.refreshLoadSel();
    };
    $('hExport').onclick = () => { this.bp.name = $('bpName').value || this.bp.name; exportFile(this.bp); };
    $('hImport').onclick = () => $('importFile').click();
    $('importFile').onchange = (e) => { const f = e.target.files[0]; if (!f) return; importFile(f).then(bp => { this.setBp(bp); this.toast(`已导入「${bp.name}」`); }).catch(err => this.toast('导入失败：' + err.message)); e.target.value = ''; };
    $('hUndo').onclick = () => this.undo();
    $('hRedo').onclick = () => this.redo();
    $('hMirror').onclick = () => this.setMirror(!this.mirror);
    $('hTool').onclick = () => this.setTool(this.tool === 'place' ? 'select' : 'place');
    $('hTest').onclick = () => this.test();
    if ($('hBack')) $('hBack').onclick = () => this.opts.onBack();
    $('bpName').onchange = () => this.patchBp(b => { b.name = $('bpName').value.slice(0, 24) || '新机体'; });
    $('loadSel').onchange = (e) => { const r = roster().find(x => x.id === e.target.value); if (r) { this.setBp(r.get()); } e.target.value = ''; };
    $('tabBuild').onclick = () => this.setTab('build');
    $('tabAct').onclick = () => this.setTab('act');
  }

  setMirror(v) { this.mirror = v; $('hMirror').setAttribute('aria-pressed', v ? 'true' : 'false'); }
  setTool(t) { this.tool = t; $('hTool').textContent = t === 'place' ? '放置' : '选择'; this.ghost.visible = false; this.attachSelection(); this.renderHint(); }
  setTab(t) {
    this.tab = t; this.preview = null;
    $('tabBuild').setAttribute('aria-selected', t === 'build'); $('tabAct').setAttribute('aria-selected', t === 'act');
    $('paneBuild').hidden = t !== 'build'; $('paneAct').hidden = t !== 'act';
    if (t === 'act' && !this.actId && this.bp.actions.length) this.actId = this.bp.actions[0].id;
    this.ghost.visible = false;
    this.applyPose(); this.attachSelection(); this.renderSide();
  }

  // the mech on the stand, ready to fight (a copy), or null with a toast saying why it can't
  ready() {
    const st = this.mech.stats;
    if (st.issues.length) { this.toast('不能出战：' + st.issues.join('；')); return null; }
    this.bp.name = $('bpName').value || this.bp.name;
    return clone(this.bp);
  }
  test() {
    const bp = this.ready();
    if (bp) this.opts.onTest(bp);
  }

  keydown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (this.binding) {
      e.preventDefault();
      if (e.code === 'Escape') { this.binding = false; this.renderSide(); return; }
      if (/^(Key[A-Z]|Digit[0-9])$/.test(e.code) && !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
        const code = e.code;
        this.patchBp(b => { for (const a of b.actions) if (a.key === code) a.key = ''; b.actions.find(a => a.id === this.actId).key = code; });
        this.binding = false; this.renderSide();
      } else this.toast('只能绑定字母或数字键（WASD 留给移动）');
      return;
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
    if (ctrl && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
    if (ctrl && e.code === 'KeyS') { e.preventDefault(); $('hSave').click(); return; }
    if (e.key === 'Shift') this.applySnap(true);
    if (e.key === 'Alt') { e.preventDefault(); this.freePlace = true; this.updateGhostFromLast(); }
    switch (e.code) {
      case 'KeyB': this.setTool('place'); break;
      case 'KeyV': this.setTool('select'); break;
      case 'KeyM': this.setMirror(!this.mirror); break;
      case 'KeyQ': this.spin = (this.spin - 15 + 360) % 360; this.hit && this.updateGhostFromLast(); break;
      case 'KeyE': this.spin = (this.spin + 15) % 360; this.hit && this.updateGhostFromLast(); break;
      case 'KeyG': this.gizmo.setMode('translate'); break;
      case 'KeyR': this.gizmo.setMode('rotate'); break;
      case 'KeyT': this.gizmo.setMode('scale'); break;
      case 'Delete': case 'Backspace': if (this.sel != null) { const pt = this.bp.parts.find(p => p.id === this.sel); if (pt && pt.type !== 'core') this.setBp(removePart(this.bp, this.sel)); } break;
      case 'Escape': this.select(null); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': {
        if (this.sel == null) break;
        e.preventDefault();
        const d = e.shiftKey ? 0.01 : 0.05;
        const v = { ArrowLeft: [d, 0, 0], ArrowRight: [-d, 0, 0], ArrowUp: [0, 0, d], ArrowDown: [0, 0, -d], PageUp: [0, d, 0], PageDown: [0, -d, 0] }[e.code];
        const pt = this.bp.parts.find(p => p.id === this.sel);
        if (pt.type !== 'core') this.setBp(updatePart(this.bp, this.sel, { p: pt.p.map((x, i) => r3(x + v[i])) }));
        break;
      }
      default: {
        const m = /^Digit(\d)$/.exec(e.code);
        if (m && this.tab === 'build') { const i = (+m[1] + 9) % 10; if (PLACEABLE[i]) this.setType(PLACEABLE[i]); }
      }
    }
  }
  keyup(e) { if (e.key === 'Shift') this.applySnap(false); if (e.key === 'Alt') { this.freePlace = false; this.updateGhostFromLast(); } }
  updateGhostFromLast() { if (this.lastEv) this.updateGhost(this.lastEv); }

  setType(t) { this.type = t; this.setTool('place'); this.renderPalette(); }

  duplicate() {
    if (this.sel == null) return;
    const pt = this.bp.parts.find(p => p.id === this.sel);
    if (!pt || pt.type === 'core') return;
    const copy = clone(pt); delete copy.m; copy.p = [pt.p[0], r3(pt.p[1] + 0.15), pt.p[2]];
    const { bp, ids } = addPart(this.bp, copy, this.mirror && pt.m != null);
    this.setBp(bp); this.select(ids[0]);
  }

  // ---------------- UI ----------------
  toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(this._tt); this._tt = setTimeout(() => { t.hidden = true; }, 2600);
  }

  renderHint() {
    $('hHint').textContent = this.tab === 'act'
      ? '点关节高亮它的滑条 · 拖动左键旋转视角 · 右键平移 · 滚轮缩放'
      : this.tool === 'place'
        ? '左键放置（自动对齐父零件的轴并居中，按住 Alt 自由贴面）· Q/E 转 15° · 右键删除 · 1–0 选零件 · M 镜像 · V 选择'
        : '左键选中 · G 移动 / R 旋转 / T 缩放（按住 Shift 取消吸附）· 方向键/PgUp/PgDn 微调 · Ctrl+D 复制 · Del 删除 · B 切到放置';
  }

  renderPalette() {
    const el = $('palette'); el.innerHTML = '';
    PLACEABLE.forEach((t, i) => {
      const P = PARTS[t];
      const b = document.createElement('button');
      b.setAttribute('aria-pressed', this.type === t && this.tool === 'place' ? 'true' : 'false');
      b.title = P.desc;
      b.innerHTML = `<span>${P.name}</span><span class="num">${P.load}</span><small>${i < 10 ? `<kbd>${(i + 1) % 10}</kbd> ` : ''}${esc(P.desc.split('。')[0])}</small>`;
      b.onclick = () => this.setType(t);
      el.appendChild(b);
    });
  }

  refreshLoadSel() {
    const s = $('loadSel');
    s.innerHTML = '<option value="">载入…</option>' + roster().map(r => `<option value="${esc(r.id)}">${esc(r.name)}${{ folder: '', local: '（浏览器）', preset: '（内置）' }[r.src]}</option>`).join('');
  }

  renderSide() {
    if (!this.bp) return;
    $('bpName').value = this.bp.name;
    this.renderHint();
    if (this.tab === 'build') this.renderBuild(); else this.renderAct();
  }

  renderBuild() {
    const st = this.mech.stats, sp = this.mech.spec;
    const pane = $('paneBuild');
    const over = st.load > st.budget + 1e-6;
    let html = `<div class="card"><h3>负载 / 数值</h3>
      <div class="loadbar ${over ? 'over' : ''}"><i style="transform:scaleX(${Math.min(1, st.load / Math.max(1, st.budget))})"></i></div>
      <div class="kv num">
        <span>负载</span><span>${st.load.toFixed(1)} / ${st.budget.toFixed(0)}</span>
        <span>零件</span><span>${st.parts}</span>
        <span>质量</span><span>${st.mass.toFixed(0)}</span>
        <span>总耐久</span><span>${st.hp.toFixed(0)}</span>
        <span>腿 / 轮</span><span>${st.support.legs.length} / ${st.support.wheels.length}</span>
        <span>步速</span><span>${sp.walk.toFixed(1)} m/s${sp.roll ? ` · 轮 ${sp.roll.toFixed(1)}` : ''}</span>
        <span>冲刺</span><span>${sp.dash ? sp.dash.toFixed(1) + ' m/s' : '无推进器'}${sp.hover ? ' · 可悬停' : ''}</span>
      </div>
      ${st.issues.length ? `<ul class="issues">${st.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    </div>`;
    const pt = this.sel != null ? this.bp.parts.find(p => p.id === this.sel) : null;
    if (pt) {
      const P = PARTS[pt.type];
      const rec = this.mech.parts.get(pt.id);
      const om = pt.type === 'joint' ? st.omegas[pt.id] : null;
      html += `<div class="card"><h3>${P.name} #${pt.id}${pt.m != null ? ` · 镜像 #${pt.m}` : ''}</h3>
        <div class="kv num"><span>负载</span><span>${partLoad(pt).toFixed(2)}</span><span>耐久</span><span>${rec.maxHp.toFixed(0)}</span>
        ${om != null ? `<span>转速</span><span>${om.toFixed(1)} rad/s（带的越重越慢）</span>` : ''}</div>
        ${this.xyz('位置', 'p', pt.p, 0.01)}${this.xyz('旋转°', 'r', pt.r, 1)}${this.xyz('缩放', 's', pt.s.map(Math.abs), 0.01)}
        ${P.rd != null ? this.slider('圆角', 'rd', pt.rd ?? P.rd, 0, 1, 0.05) : ''}
        ${['box', 'round', 'pole', 'wedge'].includes(P.shape) ? this.slider('收分', 'tp', pt.tp || 0, -0.9, 0.9, 0.05) + this.slider('扁收', 'tz', pt.tz || 0, -0.9, 0.9, 0.05) + this.slider('叶形', 'lf', pt.lf || 0, 0, 1, 0.05) + this.slider('弯曲', 'bd', pt.bd || 0, -1, 1, 0.05) : ''}
        ${P.variants ? `<div class="slide"><label>形状</label><select data-f="v">${P.variants.map(v => `<option ${pt.v === v ? 'selected' : ''}>${v}</option>`).join('')}</select><span></span></div>` : ''}
        <div class="slide"><label>颜色</label><select data-f="c">${Object.keys(DEFAULT_PALETTE).map(k => `<option value="${k}" ${pt.c === k ? 'selected' : ''}>${SLOT_NAMES[k] || k}</option>`).join('')}</select><span></span></div>
        ${pt.type === 'joint' ? this.slider('下限°', 'lim0', pt.lim[0], -360, 0, 5) + this.slider('上限°', 'lim1', pt.lim[1], 0, 360, 5) : ''}
        ${pt.type !== 'joint' && pt.type !== 'core' ? `<div class="slide"><label>双手握</label><select data-grip="part"><option value="">（不握）</option>${this.bp.parts.filter(q => ['pole', 'sword', 'blade'].includes(q.type) && q.id !== pt.id).map(q => `<option value="${q.id}" ${pt.grip && pt.grip.part === q.id ? 'selected' : ''}>${PARTS[q.type].name} #${q.id}</option>`).join('')}</select><span></span></div>
          ${pt.grip ? `<div class="slide"><label>握在(m)</label><input type="number" step="0.05" value="${pt.grip.at}" data-grip="at" aria-label="握持位置"><span></span></div><p class="note">这个零件所在的手臂会用 IK 贴住所选杆上的这个位置（沿杆的长轴，从杆中心量起）。两条手臂的关节力矩合起来挥这根杆。动作里设「grip: false」可松手。</p>` : ''}` : ''}
        <div class="btnrow"><button class="btn" data-do="dup">复制</button><button class="btn warn" data-do="del">删除</button>${pt.m != null ? '<button class="btn" data-do="unlink">断开镜像</button>' : ''}</div>
      </div>`;
    } else {
      html += `<div class="card"><h3>新零件</h3><p class="note">点零件栏选类型，再点机体表面放上去。新零件的缩放：</p>
        ${this.xyz('缩放', 'next', this.nextScale, 0.05)}</div>`;
    }
    html += `<div class="card"><h3>配色</h3>${Object.keys(DEFAULT_PALETTE).map(k => `<div class="slide"><label>${SLOT_NAMES[k] || k}</label><input type="color" data-pal="${k}" value="${this.bp.palette[k] || DEFAULT_PALETTE[k]}"><span></span></div>`).join('')}
      <div class="slide"><label>风格</label><select data-f="style"><option value="tech" ${this.bp.style !== 'ink' ? 'selected' : ''}>科技</option><option value="ink" ${this.bp.style === 'ink' ? 'selected' : ''}>水墨</option></select><span></span></div></div>`;
    pane.innerHTML = html;
    // wire inputs
    pane.querySelectorAll('[data-xyz]').forEach(inp => inp.onchange = () => {
      const [f, i] = inp.dataset.xyz.split(':'); const v = parseFloat(inp.value); if (!isFinite(v)) return;
      if (f === 'next') { this.nextScale[+i] = Math.max(0.05, v); return; }
      const cur = this.bp.parts.find(p => p.id === this.sel);
      const arr = cur[f].slice();
      if (f === 's') arr[+i] = Math.max(0.05, Math.abs(v)) * (i === '0' ? (Math.sign(cur.s[0]) || 1) : 1); else arr[+i] = v;
      this.setBp(updatePart(this.bp, this.sel, { [f]: arr }));
    });
    pane.querySelectorAll('input[type=range]').forEach(inp => {
      inp.oninput = () => { inp.nextElementSibling.textContent = (+inp.value).toFixed(2).replace(/\.?0+$/, ''); };
      inp.onchange = () => {
        const f = inp.dataset.f, v = +inp.value;
        const cur = this.bp.parts.find(p => p.id === this.sel);
        if (f === 'lim0' || f === 'lim1') { const lim = cur.lim.slice(); lim[f === 'lim0' ? 0 : 1] = v; this.setBp(updatePart(this.bp, this.sel, { lim })); }
        else this.setBp(updatePart(this.bp, this.sel, { [f]: v }));
      };
    });
    pane.querySelectorAll('select[data-f]').forEach(sel => sel.onchange = () => {
      const f = sel.dataset.f;
      if (f === 'style') { const b = clone(this.bp); b.style = sel.value; this.setBp(b); return; }
      this.setBp(updatePart(this.bp, this.sel, { [f]: sel.value }));
    });
    pane.querySelectorAll('[data-grip]').forEach(el => el.onchange = () => {
      const cur = this.bp.parts.find(p => p.id === this.sel);
      let grip = cur.grip ? { ...cur.grip } : null;
      if (el.dataset.grip === 'part') grip = el.value ? { part: +el.value, at: grip ? grip.at : 0 } : null;
      else if (grip) { const v = parseFloat(el.value); if (isFinite(v)) grip.at = v; }
      const b = clone(this.bp); const t = b.parts.find(p => p.id === this.sel);
      if (grip) t.grip = grip; else delete t.grip;
      this.setBp(b);
    });
    pane.querySelectorAll('[data-pal]').forEach(inp => inp.onchange = () => { const b = clone(this.bp); b.palette[inp.dataset.pal] = inp.value; this.setBp(b); });
    pane.querySelectorAll('[data-do]').forEach(btn => btn.onclick = () => {
      const d = btn.dataset.do;
      if (d === 'dup') this.duplicate();
      if (d === 'del') { const pt2 = this.bp.parts.find(p => p.id === this.sel); if (pt2.type !== 'core') this.setBp(removePart(this.bp, this.sel)); }
      if (d === 'unlink') this.setBp(unlinkMirror(this.bp, this.sel));
    });
  }

  xyz(label, f, v, step) {
    return `<div class="xyz"><label>${label}</label>${v.map((x, i) => `<input type="number" step="${step}" value="${r3(x)}" data-xyz="${f}:${i}" aria-label="${label} ${'xyz'[i]}">`).join('')}</div>`;
  }
  slider(label, f, v, lo, hi, step) {
    return `<div class="slide"><label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}" value="${v}" data-f="${f}" aria-label="${label}"><output>${(+v).toFixed(2).replace(/\.?0+$/, '')}</output></div>`;
  }

  // ---------------- action editor ----------------
  curAction() { return this.bp.actions.find(a => a.id === this.actId) || null; }

  jointLabel(pt) {
    const M = restMatrix(pt);
    const ax = new THREE.Vector3(1, 0, 0).transformDirection(M);
    const a = [Math.abs(ax.x), Math.abs(ax.y), Math.abs(ax.z)];
    const kind = a[1] > a[0] && a[1] > a[2] ? '偏航' : a[2] > a[0] ? '侧摆' : '俯仰';
    const side = pt.p[0] < -0.05 ? '右' : pt.p[0] > 0.05 ? '左' : '中';
    return `${side}${kind} <span class="num">y${pt.p[1].toFixed(1)}</span>${pt.v === 'spin' ? ' ⟳' : ''}`;
  }

  renderAct() {
    const pane = $('paneAct');
    const acts = this.bp.actions;
    const act = this.curAction();
    let html = `<div class="card"><h3>动作</h3><div class="actlist">${acts.map(a => `<button data-act="${esc(a.id)}" aria-pressed="${a.id === this.actId}"><span>${esc(a.name)}${a.next ? ' →' : ''}</span><span class="num">${a.mode === 'idle' ? '待机' : KEYLABEL(a.key)}${a.mode === 'hold' ? ' 按住' : ''}</span></button>`).join('') || '<p class="note">还没有动作。</p>'}</div>
      <div class="btnrow"><button class="btn" data-a="new">新动作</button>${act ? '<button class="btn" data-a="copy">复制</button><button class="btn warn" data-a="delact">删除</button>' : ''}</div></div>`;
    if (act) {
      const L = actionLength(act) || 1;
      const key = act.keys[Math.min(this.keyIdx, act.keys.length - 1)];
      html += `<div class="card"><h3>设置</h3>
        <div class="slide"><label>名称</label><input type="text" data-af="name" value="${esc(act.name)}" maxlength="12"><span></span></div>
        <div class="slide"><label>按键</label><button class="btn" data-a="bind">${this.binding ? '按下一个键…' : KEYLABEL(act.key)}</button><span></span></div>
        <div class="slide"><label>类型</label><select data-af="mode"><option value="once" ${act.mode === 'once' ? 'selected' : ''}>单次</option><option value="hold" ${act.mode === 'hold' ? 'selected' : ''}>按住保持</option><option value="idle" ${act.mode === 'idle' ? 'selected' : ''}>待机姿势</option></select><span></span></div>
        <div class="slide"><label>连招下一式</label><select data-af="next"><option value="">（无）</option>${acts.filter(a => a.id !== act.id && a.mode !== 'idle').map(a => `<option value="${esc(a.id)}" ${act.next === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><span></span></div>
        <div class="slide"><label>蹲下时</label><select data-af="low"><option value="0" ${!act.low ? 'selected' : ''}>普通动作</option><option value="1" ${act.low ? 'selected' : ''}>蹲下版（按住 C 再按键）</option></select><span></span></div>
        <div class="slide"><label>双手握</label><select data-af="grip"><option value="1" ${act.grip !== false ? 'selected' : ''}>保持</option><option value="0" ${act.grip === false ? 'selected' : ''}>本动作松手</option></select><span></span></div>
        <p class="note">连招：动作播放时再按同一个键，结束后接下一式。下一式不需要自己的按键。</p>
      </div>
      <div class="card"><h3>关键帧</h3>
        <div class="timeline" id="tl">${act.keys.map((k, i) => `<span class="k ${i === this.keyIdx ? 'sel' : ''}" style="left:${(k.t / L) * 100}%" data-k="${i}"></span>`).join('')}<span class="ph" id="playhead" style="left:0"></span></div>
        <div class="btnrow"><button class="btn primary" data-a="play">▶ 预览</button><button class="btn" data-a="addk">+ 帧</button><button class="btn warn" data-a="delk">删帧</button></div>
        ${key ? `<div class="xyz"><label>帧</label>
          <input type="number" step="0.02" min="0" value="${key.t}" data-kf="t" aria-label="时间 秒" title="时间（秒）">
          <input type="number" step="1" value="${key.lunge || 0}" data-kf="lunge" aria-label="前冲" title="前冲速度 m/s">
          <input type="number" step="5" value="${key.yaw ?? ''}" placeholder="—" data-kf="yaw" aria-label="身体转向" title="整机转向（度），留空=不控制"></div>
          <p class="note">三格依次是：时间(s) · 前冲(m/s) · 整机转向(°)。预览按真实转速播放，重武器会跟不上关键帧。</p>` : ''}
      </div>`;
      if (key) {
        const joints = this.bp.parts.filter(p => p.type === 'joint');
        html += `<div class="card"><h3>关节（本帧）</h3>${joints.map(j => {
          const v = key.j[j.id];
          const on = v !== undefined;
          const spin = v && typeof v === 'object';
          const lo = j.v === 'spin' && spin ? -40 : (j.v === 'spin' ? -360 : j.lim[0]), hi = j.v === 'spin' && spin ? 40 : (j.v === 'spin' ? 360 : j.lim[1]);
          const val = spin ? v.spin : (on ? v : 0);
          return `<div class="jrow ${on ? '' : 'off'} ${this.hotJoint === j.id ? 'hot' : ''}">
            <input type="checkbox" ${on ? 'checked' : ''} data-jon="${j.id}" aria-label="控制关节 ${j.id}">
            <label>${this.jointLabel(j)}</label>
            <input type="range" min="${lo}" max="${hi}" step="1" value="${val}" data-jv="${j.id}" ${on ? '' : 'disabled'} aria-label="角度">
            <output class="num">${spin ? val + 'r/s' : val + '°'}</output></div>
            ${j.v === 'spin' && on ? `<div class="jrow"><span></span><label class="note">旋转模式</label><select data-jspin="${j.id}"><option value="0" ${spin ? '' : 'selected'}>角度</option><option value="1" ${spin ? 'selected' : ''}>持续旋转</option></select><span></span></div>` : ''}`;
        }).join('') || '<p class="note">这台机体没有关节。</p>'}</div>`;
        const weps = this.bp.parts.filter(p => ['gun', 'cannon', 'sling'].includes(p.type));
        if (weps.length) html += `<div class="card"><h3>本帧开火</h3>${weps.map(w => {
          const e = (key.ev || []).find(x => x.part === w.id);
          return `<div class="jrow"><input type="checkbox" ${e ? 'checked' : ''} data-ev="${w.id}" aria-label="开火"><label>${PARTS[w.type].name} #${w.id}</label>
            ${w.type === 'sling' ? `<select data-evm="${w.id}" ${e ? '' : 'disabled'}><option value="pull" ${!e || e.mode !== 'push' ? 'selected' : ''}>拉</option><option value="push" ${e && e.mode === 'push' ? 'selected' : ''}>推</option></select>` : '<span></span>'}<span></span></div>`;
        }).join('')}<p class="note">按住类动作：最后一帧的开火会一直重复（连射）。</p></div>`;
      }
    }
    pane.innerHTML = html;
    this.wireAct(pane);
  }

  wireAct(pane) {
    const act = this.curAction();
    const key = act ? act.keys[Math.min(this.keyIdx, act.keys.length - 1)] : null;
    const editKey = (fn, history = true, rerender = true) => {
      this.patchBp(b => { const a = b.actions.find(x => x.id === this.actId); fn(a, a.keys[Math.min(this.keyIdx, a.keys.length - 1)]); }, history);
      this.applyPose();
      if (rerender) this.renderAct();
    };
    pane.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { this.actId = b.dataset.act; this.keyIdx = 0; this.preview = null; this.applyPose(); this.renderAct(); });
    pane.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const d = b.dataset.a;
      if (d === 'new') {
        const id = 'a' + Date.now().toString(36);
        this.patchBp(bb => bb.actions.push({ id, name: '新动作', key: '', mode: 'once', next: '', window: 0.35, keys: [{ t: 0, j: {} }, { t: 0.3, j: {} }] }));
        this.actId = id; this.keyIdx = 0;
      }
      if (d === 'copy') { const id = 'a' + Date.now().toString(36); this.patchBp(bb => { const a = clone(bb.actions.find(x => x.id === this.actId)); a.id = id; a.name = (a.name + '副本').slice(0, 12); a.key = ''; bb.actions.push(a); }); this.actId = id; }
      if (d === 'delact') { this.patchBp(bb => { bb.actions = bb.actions.filter(x => x.id !== this.actId); for (const a of bb.actions) if (a.next === this.actId) a.next = ''; }); this.actId = this.bp.actions[0]?.id || null; this.keyIdx = 0; }
      if (d === 'bind') { this.binding = true; }
      if (d === 'play') { this.playPreview(); return; }
      if (d === 'addk') { editKey((a, k) => { const last = a.keys[a.keys.length - 1]; const nk = clone(k || last); nk.t = r3((last ? last.t : 0) + 0.2); delete nk.lunge; a.keys.push(nk); }); this.keyIdx = this.curAction().keys.length - 1; }
      if (d === 'delk') { if (act.keys.length > 1) editKey((a) => { a.keys.splice(this.keyIdx, 1); }); this.keyIdx = Math.max(0, this.keyIdx - 1); }
      this.applyPose(); this.renderAct();
    });
    pane.querySelectorAll('[data-k]').forEach(k => k.onclick = (e) => { e.stopPropagation(); this.keyIdx = +k.dataset.k; this.preview = null; this.applyPose(); this.renderAct(); });
    pane.querySelectorAll('[data-af]').forEach(inp => inp.onchange = () => {
      const f = inp.dataset.af;
      this.patchBp(b => {
        const a = b.actions.find(x => x.id === this.actId);
        if (f === 'mode' && inp.value === 'idle') for (const o of b.actions) if (o.mode === 'idle') o.mode = 'once';
        if (f === 'grip') { if (inp.value === '0') a.grip = false; else delete a.grip; return; }
        if (f === 'low') { if (inp.value === '1') a.low = true; else delete a.low; return; }
        a[f] = f === 'name' ? (inp.value || '动作').slice(0, 12) : inp.value;
        if (f === 'mode' && inp.value === 'idle') { a.key = ''; a.next = ''; }
      });
      this.renderAct();
    });
    pane.querySelectorAll('[data-kf]').forEach(inp => inp.onchange = () => {
      const f = inp.dataset.kf; const v = parseFloat(inp.value);
      editKey((a, k) => {
        if (f === 'yaw') { if (inp.value === '') delete k.yaw; else if (isFinite(v)) k.yaw = v; return; }
        if (!isFinite(v)) return;
        if (f === 't') { k.t = Math.max(0, r3(v)); a.keys.sort((x, y) => x.t - y.t); this.keyIdx = a.keys.indexOf(k); }
        else if (v) k[f] = v; else delete k[f];
      });
    });
    pane.querySelectorAll('[data-jon]').forEach(cb => cb.onchange = () => {
      const id = cb.dataset.jon;
      editKey((a, k) => { if (cb.checked) { const rec = this.mech.parts.get(+id); k.j[id] = Math.round((rec.joint.a || 0) / DEG); } else delete k.j[id]; });
    });
    pane.querySelectorAll('[data-jv]').forEach(sl => {
      const id = sl.dataset.jv;
      const set = (history) => editKey((a, k) => { const v = +sl.value; if (k.j[id] && typeof k.j[id] === 'object') k.j[id] = { spin: v }; else k.j[id] = v; }, history, false);
      sl.oninput = () => { sl.nextElementSibling.textContent = sl.value + (key && typeof key.j[id] === 'object' ? 'r/s' : '°'); set(false); };
      sl.onpointerdown = () => { this.hist.push(this.bp); this.fut = []; };
    });
    pane.querySelectorAll('[data-jspin]').forEach(s => s.onchange = () => {
      const id = s.dataset.jspin;
      editKey((a, k) => { k.j[id] = s.value === '1' ? { spin: 15 } : 0; });
    });
    pane.querySelectorAll('[data-ev]').forEach(cb => cb.onchange = () => {
      const id = +cb.dataset.ev;
      editKey((a, k) => { k.ev = (k.ev || []).filter(e => e.part !== id); if (cb.checked) k.ev.push({ part: id, mode: 'pull' }); if (!k.ev.length) delete k.ev; });
    });
    pane.querySelectorAll('[data-evm]').forEach(s => s.onchange = () => {
      const id = +s.dataset.evm;
      editKey((a, k) => { const e = (k.ev || []).find(x => x.part === id); if (e) e.mode = s.value; });
    });
    const tl = $('tl');
    if (tl) tl.onclick = (e) => {
      if (!act) return;
      const r = tl.getBoundingClientRect(); const L = actionLength(act) || 1;
      const t = Math.max(0, (e.clientX - r.left) / r.width * L);
      let best = 0, bd = Infinity; act.keys.forEach((k, i) => { const d = Math.abs(k.t - t); if (d < bd) { bd = d; best = i; } });
      this.keyIdx = best; this.applyPose(); this.renderAct();
    };
  }
}
