// js/spec.js — derived stats -> movement numbers, as ratios to a reference build (Skybreak's trick:
// the reference maps to exactly the tuned values in config.js, everything else scales from there).
// REF is measured from the stock build (see test/headless.mjs, which checks it is still in sync).

import { CFG } from './config.js';

export const REF = { mass: 330, legTorque: 4200, legLen: 2.2, thrust: 1500 };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function specFromStats(st) {
  const mr = st.mass / REF.mass;
  const legs = st.canWalk;
  const legPow = legs ? clamp(Math.sqrt((st.legTorque / st.mass) / (REF.legTorque / REF.mass)), 0.3, 1.3) : 0;
  const stride = legs ? clamp(Math.sqrt(st.legLen / REF.legLen), 0.5, 1.5) : 0;
  const twr = st.thrust / (st.mass * CFG.g);
  const refTwr = REF.thrust / (REF.mass * CFG.g);
  const thr = st.thrust > 0 ? clamp(Math.sqrt(twr / refTwr), 0.35, 1.45) : 0;
  const nW = st.support.wheels.length;
  const roll = nW >= CFG.wheel.minWheels ? CFG.wheel.base * clamp(Math.sqrt(nW / 4 / mr), 0.4, 1.3) : 0;
  return {
    refMass: REF.mass,
    walk: CFG.walk.base * legPow * stride,
    walkRef: CFG.walk.base,
    turn: CFG.walk.turn * (legs ? clamp(legPow, 0.5, 1.2) : 0.6),
    wheelTurn: CFG.wheel.turn,
    roll,
    jump: legs ? CFG.walk.jump * clamp(legPow, 0.5, 1.15) : 0,
    dash: CFG.thrust.dash * thr,
    hover: twr >= CFG.thrust.hoverTWR,
    lift: CFG.thrust.lift * thr,
    twr,
  };
}
