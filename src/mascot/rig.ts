// Marshmori's stretchy body in 3D: a small bean of a torso under the big head, with
// short, stubby arms and legs — and a neck and arms that can stretch out very long,
// like soft dough. Every part is pulled toward where it wants to be by a damped spring,
// so nothing moves in a straight, stiff line: hands overshoot a little, legs bend like
// soft tubes, a stretched arm turns into a long wavy noodle.
//
// Units: the head's radius is 1. Body space has (0, 0, 0) in the middle of the torso,
// y up, z toward whoever Marshmori is facing (the viewer, unless it turns).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** A damped spring toward a target that can keep moving. */
export class Spring {
  value: number;
  target: number;
  velocity = 0;

  constructor(value: number, public stiffness = 170, public damping = 18) {
    this.value = value;
    this.target = value;
  }

  step(dt: number): number {
    // Semi-implicit Euler in small sub-steps: stable at any frame rate.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  snap(v: number) {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }
}

export class Spring3 {
  readonly x: Spring;
  readonly y: Spring;
  readonly z: Spring;

  constructor(v: Vec3, stiffness = 170, damping = 18) {
    this.x = new Spring(v.x, stiffness, damping);
    this.y = new Spring(v.y, stiffness, damping);
    this.z = new Spring(v.z, stiffness, damping);
  }

  set target(v: Vec3) {
    this.x.target = v.x;
    this.y.target = v.y;
    this.z.target = v.z;
  }

  get target(): Vec3 {
    return { x: this.x.target, y: this.y.target, z: this.z.target };
  }

  get value(): Vec3 {
    return { x: this.x.value, y: this.y.value, z: this.z.value };
  }

  step(dt: number): Vec3 {
    this.x.step(dt);
    this.y.step(dt);
    this.z.step(dt);
    return this.value;
  }

  snap(v: Vec3) {
    this.x.snap(v.x);
    this.y.snap(v.y);
    this.z.snap(v.z);
  }
}

/** Where every part wants to be. */
export interface Pose {
  /** Extra neck length; 0 = the head sits on the body. */
  neck: number;
  /** Sideways bend of the neck (moves the head along x). */
  neckBend: number;
  /** Head roll (tilting to one side). */
  headTilt: number;
  /** Body pitch forward (+) around the feet. */
  lean: number;
  /** 1 = normal, < 1 squashed, > 1 stretched tall. */
  squash: number;
  /** Lifts the whole body (+ up). */
  bob: number;
  lHand: Vec3;
  rHand: Vec3;
  lFoot: Vec3;
  rFoot: Vec3;
  /** 0 = only the head (tucked into the island), 1 = full body. */
  grow: number;
}

// Arms and legs start inside the body, so they grow out of it with no seam.
export const SHOULDER_L = v3(-0.2, 0.2, 0);
export const SHOULDER_R = v3(0.2, 0.2, 0);
export const HIP_L = v3(-0.2, -0.22, 0);
export const HIP_R = v3(0.2, -0.22, 0);
/** An arm's length at rest: short and stubby, like the legs (it stretches when it reaches). */
export const ARM_REST = 0.46;
export const LEG_REST = 0.44;
export const ARM_R = 0.125;
export const LEG_R = 0.158;
export const NECK_R = 0.19;
/** Bottom of the head above the torso centre when the neck is 0 (head on the shoulders). */
export const HEAD_SEAT = 0.37;
/** From the bottom of the head up to its widest line (the head's origin). */
export const HEAD_DROP = 0.65;
/** Torso centre above the ground when standing. */
export const TORSO_HEIGHT = 0.78;
/** No neck to see when Marshmori just stands there: the head sits right on the body. */
export const NECK_REST = 0;

const HAND_L = v3(-0.5, -0.1, 0.08);
const HAND_R = v3(0.5, -0.1, 0.08);
const FOOT_L = v3(-0.225, -0.665, 0.03);
const FOOT_R = v3(0.225, -0.665, 0.03);

export function standing(t = 0): Pose {
  const breathe = Math.sin(t * 2.1);
  return {
    neck: 0,
    neckBend: 0,
    headTilt: 0,
    lean: 0,
    squash: 1 + 0.018 * breathe,
    bob: 0,
    lHand: v3(HAND_L.x, HAND_L.y + breathe * 0.012, HAND_L.z),
    rHand: v3(HAND_R.x, HAND_R.y + breathe * 0.012, HAND_R.z),
    lFoot: { ...FOOT_L },
    rFoot: { ...FOOT_R },
    grow: 1,
  };
}

/** A soft, bouncy run toward +z (turn the body to run sideways). `phase` follows the distance. */
export function running(phase: number): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  return {
    neck: 0.03 * Math.abs(s),
    neckBend: 0,
    headTilt: 0.05 * s,
    lean: 0.2,
    squash: 1 + 0.05 * Math.abs(c),
    bob: 0.08 * Math.abs(s),
    lHand: v3(-0.5, -0.02 + 0.08 * Math.max(0, -c), -0.26 * c),
    rHand: v3(0.5, -0.02 + 0.08 * Math.max(0, c), 0.26 * c),
    lFoot: v3(-0.2, -0.665 + 0.13 * Math.max(0, s), 0.2 * c),
    rFoot: v3(0.2, -0.665 + 0.13 * Math.max(0, -s), -0.2 * c),
    grow: 1,
  };
}

/** Arms up and legs tucked: hopping in or out of the island. */
export function airborne(t = 0): Pose {
  return {
    neck: 0.05,
    neckBend: 0,
    headTilt: 0.05 * Math.sin(t * 9),
    lean: 0,
    squash: 1.06,
    bob: 0,
    lHand: v3(-0.86, 0.36, 0.1),
    rHand: v3(0.86, 0.36, 0.1),
    lFoot: v3(-0.25, -0.56, 0.1),
    rFoot: v3(0.25, -0.56, 0.1),
    grow: 1,
  };
}

/** Reaches toward `target` (body space) with the nearer arm — it stretches as far as it needs to. */
export function pointing(target: Vec3, t: number): Pose {
  const base = standing(t);
  const side = target.x >= 0 ? 1 : -1;
  const shoulder = side > 0 ? SHOULDER_R : SHOULDER_L;
  let dx = target.x - shoulder.x;
  let dy = target.y - shoulder.y;
  let dz = target.z - shoulder.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const reach = Math.min(d, 3.2);
  // A small "tap tap" at the end of the reach.
  const tap = Math.max(0, Math.sin(t * 7)) * 0.07;
  const k = (reach - tap) / d;
  dx *= k;
  dy *= k;
  dz *= k;
  const hand = v3(shoulder.x + dx, shoulder.y + dy, shoulder.z + dz);
  const other = v3(-side * 0.5, -0.06 + 0.03 * Math.sin(t * 3), 0.12);
  return {
    ...base,
    neck: 0.1 + 0.04 * Math.sin(t * 2.4),
    neckBend: side * 0.12,
    headTilt: -side * 0.14,
    lean: 0.04,
    lHand: side > 0 ? other : hand,
    rHand: side > 0 ? hand : other,
  };
}

/** Waving hello with the hand on the `side` (1 = right, as the viewer sees it). */
export function waving(t: number, side = 1): Pose {
  const base = standing(t);
  // Raised hands have to stretch past the big head to be seen: the arm goes noodly.
  const wave = v3(side * (0.98 + 0.08 * Math.sin(t * 11)), 0.62 + 0.05 * Math.cos(t * 11), 0.16);
  return {
    ...base,
    neck: 0.04,
    headTilt: -side * 0.1 * Math.sin(t * 5.5),
    lHand: side < 0 ? wave : base.lHand,
    rHand: side > 0 ? wave : base.rHand,
  };
}

/** Sitting with the stubby legs out front, for waiting next to the pointer. */
export function sitting(t: number): Pose {
  const breathe = Math.sin(t * 1.8);
  return {
    neck: 0,
    neckBend: 0,
    headTilt: 0.04 * Math.sin(t * 0.9),
    lean: -0.06,
    squash: 0.97 + 0.02 * breathe,
    bob: -0.26,
    lHand: v3(-0.5, -0.22, 0.16),
    rHand: v3(0.5, -0.22, 0.16),
    lFoot: v3(-0.25, -0.44, 0.42),
    rFoot: v3(0.25, -0.44, 0.42),
    grow: 1,
  };
}

/** Neck stretched up high and arms overhead — the big stretch. */
export function stretching(t: number): Pose {
  const k = 0.5 + 0.5 * Math.sin(t * 2.2);
  return {
    neck: 0.2 + 0.85 * k,
    neckBend: 0.08 * Math.sin(t * 1.1),
    headTilt: 0.05 * Math.sin(t * 1.3),
    lean: 0,
    squash: 1 + 0.04 * k,
    bob: 0,
    lHand: v3(-0.62, 0.95 + 0.5 * k, 0.05),
    rHand: v3(0.62, 0.95 + 0.5 * k, 0.05),
    lFoot: { ...FOOT_L },
    rFoot: { ...FOOT_R },
    grow: 1,
  };
}

/** Long neck round to one side, sneaking a look. */
export function peeking(t: number): Pose {
  return {
    ...standing(t),
    neck: 0.55,
    neckBend: 0.6,
    headTilt: -0.3,
    lean: 0.05,
    lHand: v3(-0.5, -0.06, 0.14),
    rHand: v3(0.52, 0.08, 0.2),
  };
}

/** A happy jump on the spot (job done!). */
export function jumping(t: number): Pose {
  const p = (t % 1.1) / 1.1;
  const up = p < 0.55 ? Math.sin((p / 0.55) * Math.PI) : 0;
  const crouch = p >= 0.55 && p < 0.75 ? Math.sin(((p - 0.55) / 0.2) * Math.PI) : 0;
  return {
    ...standing(t),
    bob: 0.5 * up - 0.06 * crouch,
    squash: 1 + 0.07 * up - 0.11 * crouch,
    neck: 0.06 * up,
    lHand: v3(-0.84, 0.3 + 0.45 * up, 0.12),
    rHand: v3(0.84, 0.3 + 0.45 * up, 0.12),
    lFoot: v3(-0.24, -0.665 + 0.08 * up, 0.04),
    rFoot: v3(0.24, -0.665 + 0.08 * up, 0.04),
  };
}

/** Both little arms thrown up and out: "yay!" */
export function cheering(t: number): Pose {
  const k = Math.sin(t * 7);
  return {
    ...standing(t),
    squash: 1.02 + 0.02 * k,
    bob: 0.03 * Math.max(0, k),
    lHand: v3(-0.98, 0.62 + 0.06 * k, 0.12),
    rHand: v3(0.98, 0.62 - 0.06 * k, 0.12),
  };
}

/** Long Arms: both arms stretched out far to the sides, like two soft noodles. */
export function longArms(t: number): Pose {
  return {
    ...standing(t),
    lHand: v3(-2.7, 0.12 + 0.12 * Math.sin(t * 1.7), 0.15),
    rHand: v3(2.7, 0.12 + 0.12 * Math.sin(t * 1.7 + 1.3), 0.15),
  };
}

/** Blends two poses: k = 0 gives `a`, 1 gives `b`. */
export function blend(a: Pose, b: Pose, k: number): Pose {
  const m = (x: number, y: number) => x + (y - x) * k;
  const mv = (p: Vec3, q: Vec3) => v3(m(p.x, q.x), m(p.y, q.y), m(p.z, q.z));
  return {
    neck: m(a.neck, b.neck),
    neckBend: m(a.neckBend, b.neckBend),
    headTilt: m(a.headTilt, b.headTilt),
    lean: m(a.lean, b.lean),
    squash: m(a.squash, b.squash),
    bob: m(a.bob, b.bob),
    lHand: mv(a.lHand, b.lHand),
    rHand: mv(a.rHand, b.rHand),
    lFoot: mv(a.lFoot, b.lFoot),
    rFoot: mv(a.rFoot, b.rFoot),
    grow: m(a.grow, b.grow),
  };
}

/**
 * Where the two hands rest when only the head shows: on the edge Marshmori is holding
 * on to, just under its face (body space, neck tucked in). `kind` says what they do.
 */
export type HangKind = "rest" | "pat" | "wave" | "type" | "tap" | "up" | "low" | "shake" | "cheeks" | "chin";

export const HANG_REST_Y = HEAD_SEAT + HEAD_DROP - 0.5;

export function hanging(kind: HangKind, t: number): [Vec3, Vec3] {
  const y = HANG_REST_Y;
  const l = v3(-0.46, y, 0.46);
  const r = v3(0.46, y, 0.46);
  switch (kind) {
    case "pat": {
      // Little happy pats on the edge.
      const k = Math.max(0, Math.sin(t * 8));
      l.y += 0.05 * k;
      r.y += 0.05 * Math.max(0, Math.sin(t * 8 + Math.PI));
      break;
    }
    case "wave":
      r.x = 1.0 + 0.07 * Math.sin(t * 11);
      r.y = y + 0.55 + 0.05 * Math.cos(t * 11);
      r.z = 0.3;
      break;
    case "type": {
      // Typing away, one nub after the other.
      l.y += 0.07 * Math.max(0, Math.sin(t * 13));
      r.y += 0.07 * Math.max(0, Math.sin(t * 13 + Math.PI));
      l.x += 0.04;
      r.x -= 0.04;
      break;
    }
    case "tap":
      // Waiting: one slow tap.
      r.y += 0.05 * Math.max(0, Math.sin(t * 4.5));
      break;
    case "up": {
      const k = Math.sin(t * 8);
      l.x = -1.02;
      r.x = 1.02;
      l.y = y + 0.66 + 0.05 * k;
      r.y = y + 0.66 - 0.05 * k;
      l.z = r.z = 0.24;
      break;
    }
    case "low":
      l.x = -0.37;
      r.x = 0.37;
      l.y = r.y = y - 0.05;
      break;
    case "shake":
      l.x += 0.03 * Math.sin(t * 40);
      r.x += 0.03 * Math.sin(t * 40 + 1);
      break;
    case "cheeks":
      // Hands up to the cheeks: shy, or in love.
      l.x = -0.66;
      r.x = 0.66;
      l.y = r.y = y + 0.42 + 0.02 * Math.sin(t * 3);
      l.z = r.z = 0.55;
      break;
    case "chin":
      r.x = 0.22;
      r.y = y + 0.15;
      r.z = 0.62;
      break;
    case "rest":
      break;
  }
  return [l, r];
}

/** The live state of a body: a spring on every part. */
export class Rig {
  neck = new Spring(NECK_REST, 120, 11);
  neckBend = new Spring(0, 120, 12);
  headTilt = new Spring(0, 140, 14);
  lean = new Spring(0, 90, 12);
  squash = new Spring(1, 220, 14);
  bob = new Spring(0, 260, 20);
  grow = new Spring(1, 130, 16);
  // Soft but not wobbly: a little overshoot, no trembling after a move.
  lHand = new Spring3(HAND_L, 200, 19);
  rHand = new Spring3(HAND_R, 200, 19);
  lFoot = new Spring3(FOOT_L, 260, 20);
  rFoot = new Spring3(FOOT_R, 260, 20);

  setTargets(p: Pose) {
    this.neck.target = p.neck;
    this.neckBend.target = p.neckBend;
    this.headTilt.target = p.headTilt;
    this.lean.target = p.lean;
    this.squash.target = p.squash;
    this.bob.target = p.bob;
    this.grow.target = p.grow;
    this.lHand.target = p.lHand;
    this.rHand.target = p.rHand;
    this.lFoot.target = p.lFoot;
    this.rFoot.target = p.rFoot;
  }

  snap(p: Pose) {
    this.neck.snap(p.neck);
    this.neckBend.snap(p.neckBend);
    this.headTilt.snap(p.headTilt);
    this.lean.snap(p.lean);
    this.squash.snap(p.squash);
    this.bob.snap(p.bob);
    this.grow.snap(p.grow);
    this.lHand.snap(p.lHand);
    this.rHand.snap(p.rHand);
    this.lFoot.snap(p.lFoot);
    this.rFoot.snap(p.rFoot);
  }

  step(dt: number) {
    for (const s of [this.neck, this.neckBend, this.headTilt, this.lean, this.squash, this.bob, this.grow]) s.step(dt);
    for (const s of [this.lHand, this.rHand, this.lFoot, this.rFoot]) s.step(dt);
  }

  /** The head's origin (its widest line, where the eyes are) in body space, ignoring lean and squash. */
  headCenter(): Vec3 {
    return v3(this.neckBend.value, HEAD_SEAT + Math.max(0, this.neck.value) + HEAD_DROP + this.bob.value, 0);
  }
}
