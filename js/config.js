// js/config.js — every tunable number in one table. Balance changes go here only.
// Units: metres, seconds, kg-ish. Mechs face +Z, up is +Y, a mech's right hand is -X.

export const CFG = {
  g: 26,                       // gravity (arcade, heavier than real so jumps feel weighty)

  arena: { radius: 46 },
  // online play (js/net.js, js/online.js). signal = the mailbox used to swap WebRTC offers: Skybreak's Worker.
  // The host runs the whole fight; guests send inputs and draw the host's snapshots, shown `delay` s behind.
  net: { signal: 'https://skybreak-lb.larryzhong.workers.dev', rate: 20, inputRate: 30, delay: 0.1, maxPlayers: 4 },

  build: {
    budgetDefault: 200,        // core load budget (see parts.js core.budget)
    maxParts: 260,
    snap: 0.05,                // position snap in the hangar (m)
    rotSnap: 15,               // rotation snap (deg)
    groundEps: 0.07,           // a part whose bottom is within this of the lowest point touches the ground
  },

  // Joints are kinematic servos. Max angular speed comes from torque / inertia of everything they carry,
  // so a long heavy lance swings slower than a bare fist. Inertia is measured in the rest pose.
  joint: {
    torque: 600,               // torque of a scale-1 joint; scales with joint volume
    omegaK: 6.5,               // omega = omegaK * torque / inertia
    omegaMin: 1.6,             // rad/s, even an overloaded joint still moves
    omegaMax: 24,              // rad/s
    I0: 4,                     // inertia floor so tiny limbs don't divide by ~0
    spinAccel: 40,             // rad/s^2 for continuous-spin joints spinning up
    minHp: 40,                 // joints never have less HP than this, however small
  },

  // Movement. Everything is relative to the stock build (spec.js), Skybreak-style: stock = 100%.
  walk: {
    base: 8.5,                 // m/s for the stock build
    turn: 5.0,                 // rad/s yaw rate on legs
    stepTime: 0.24,            // s per swing at stock speed
    stepHeight: 0.38,          // fraction of stride used as lift
    crouch: 0.06,              // body lowered by this fraction of leg length while standing (keeps knees soft)
    jump: 10.5,                // m/s take-off speed for the stock build
    minLegs: 2,
    stanceWidth: 0.12,         // feet planted this much wider than the rest pose (m)
    stanceStagger: 0.26,       // left foot forward, right foot back (m) — a fighting stance
  },
  wheel: { base: 14, turn: 2.6, minWheels: 2, accel: 18 },
  thrust: {
    dash: 24,                  // dash speed for stock thrust/weight
    dashTime: 0.26,
    dashCost: 26,              // boost gauge per dash
    hoverTWR: 0.12,            // thrust/weight (rel. to g) needed to hover while holding Space
    hoverCost: 30,             // gauge per second hovering
    lift: 13,                  // upward accel while hovering, before weight scaling
    cap: 100,                  // boost gauge
    regen: 34,                 // per second, only while grounded
    drift: 4,                  // air control accel without legs/wheels on the ground (thrusters only)
  },
  ground: { friction: 10, airFriction: 1.2, push: 1.0 },

  // Melee: damage scales with how fast the edge is moving at the contact point.
  melee: {
    refSpeed: 30,              // m/s edge speed that deals 1x damage
    minFactor: 0.25,
    maxFactor: 2.0,
    minSpeed: 5,               // below this an edge is just touching, no damage
    rehit: 0.32,               // s before the same edge can hit the same part again
    knock: 0.09,               // knockback per damage point, divided by target mass ratio
    hitStop: 0.06,
  },

  // Anti-ranged: a moving edge or pole destroys bullets it sweeps through.
  parry: {
    speed: 7,                  // edge speed needed to cut a bullet
    heavySpeed: 12,            // cannon shells need this, and a blade (a pole only blocks them)
    radius: 0.16,              // extra reach of an edge against bullets
  },

  aim: { cone: 22, pitch: 35, range: 60, margin: 0.35 },   // vertical aim assist: horizontal cone (deg), max pitch fix (deg), metres, keep-inside margin (m)
  gun:    { speed: 78, life: 1.4, radius: 0.09, heatPerShot: 9, cool: 38, overheat: 100, lockout: 1.6 },
  cannon: { speed: 42, life: 2.2, radius: 0.22, gravity: 7, splash: 1.9, splashFrac: 0.5, recoil: 5, heatPerShot: 42 },
  sling:  { speed: 46, life: 1.0, radius: 0.35, impulse: 19, stun: 0.35, lift: 3 },

  detach: { life: 7 },

  // Weapons and the joints holding them are hard to break: hits on them only count this much.
  grip: { armor: 0.35, depth: 3 },

  // Phantom weapon (幻影/墨影): when a held weapon is knocked off but any part of that arm survives,
  // a ghost of the lost weapon (same shape, same joints) forms on what's left of the arm.
  phantom: {
    cap: 100,                  // 灵能 gauge
    summon: 30,                // gauge needed to form the ghost again after it fades
    drain: 5,                  // per second while the ghost is out
    regen: 9,                  // per second while it is not
    cutCost: 4,                // gauge spent each time the ghost cuts a bullet
    dmg: 0.6,                  // damage multiplier for ghost edges and ghost bullets (ghosts can't cut cannon shells)
  },

  match: { roundTime: 120, roundDelay: 2.6 },

  // AI ladder (after Skybreak's): each level the AI is better; past skillCap only its HP and damage grow
  ladder: {
    skillAt: [[1, 0], [5, 0.35], [10, 0.6], [15, 0.78], [20, 0.9], [25, 0.97], [30, 1]],
    skillCap: 30,
    hpPerLevel: 0.08,
    dmgPerLevel: 0.04,
    rounds: 2,                 // best of three
  },

  ai: {
    think: 0.18,               // s between decisions
    reactBullets: 0.55,        // chance to raise a guard when bullets are incoming
    dodge: 0.25,               // chance to dash sideways when the player starts a swing nearby
    rangedPref: 17,            // preferred distance for gun builds
  },

  cam: { dist: 9.5, height: 3.6, side: 1.1, look: 0.32, lerp: 7 },

  // Palette for the ink renderer (sRGB hex, used as-is by the shaders)
  ink: {
    paper: '#ece5d3',
    paperDark: '#d9cfb8',
    ink: '#121a1c',
    mist: '#e4dcc8',
    seal: '#b8412e',
  },
};

// Colour slots a part can reference; a blueprint may override them in bp.palette
export const DEFAULT_PALETTE = {
  armor: '#3cb4ae',            // 青
  frame: '#1f3a3d',
  light: '#d8efe9',
  accent: '#b8412e',           // 朱砂
  steel: '#8a9a98',
  ink: '#16201f',
  glow: '#dffcf5',
};
