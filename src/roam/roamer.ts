// Mamori reaching out of the island to nudge you at the mouse pointer, in 3D.
//
// Mamori doesn't leave home. It reaches out one of two ways, whichever suits the news
// (or what you picked in the settings):
//   head  both little hands keep hold of the island's edge while the neck stretches out
//         like soft dough and carries the head to the pointer; it boops the pointer
//         twice and says what's up. For questions and problems: you see its face.
//   hand  the head stays in its seat and one hand lets go: its arm stretches across the
//         screen and the hand taps the pointer twice ("สะกิด"). For finished work.
// What stretches hangs down out of the island first, then swings over; the noodle sways
// behind (its two bend points are on springs of their own, so it lags and settles),
// gets a little thinner the farther it's pulled, and winds back in like a tape measure.
// Nothing moves in a straight line: it follows a curve with easing, on a spring.
//
// Positions are CSS pixels of the roam overlay, y down. The canvas covers the overlay.

import type { RoamKind, RoamRequest } from "../core/types";
import type { ColorName, ExpressionName } from "../mascot/expressions";
import { Marshmori } from "../mascot/marsh";
import { gripPoint, HANG_SCREEN, pawRadius, type ReachPose } from "../mascot/model";
import { Spring } from "../mascot/rig";

export type { RoamKind, RoamRequest } from "../core/types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Vec {
  x: number;
  y: number;
}

const vec = (x = 0, y = 0): Vec => ({ x, y });

type Phase = "hidden" | "travel" | "arrived" | "returning";
type TripStyle = "out" | "chase" | "back";

interface Trip {
  p0: Vec;
  p1: Vec;
  p2: Vec;
  p3: Vec;
  start: number;
  dur: number;
  style: TripStyle;
}

/** CSS pixels per head unit out on the screen (the head is 60 px wide there). */
export const ROAM_UNIT = 30;
/** How far the pointer may wander before Mamori follows it. */
const CHASE_DISTANCE = 110;
/** Done/error visits end on their own after this long (seconds, not counting while you look). */
const STAY: Record<RoamKind, number> = { approval: Infinity, done: 6.5, error: 10 };
/** A waiting approval nudges again every so often, in case you looked away. */
const ATTENTION_EVERY = 14;
/** How far a tap moves toward the pointer (CSS pixels). */
const TAP_REACH = { head: 16, hand: 9 };
/** Moments (seconds into the taps) when one lands: a ripple there. */
const TAP_HITS = [0.1, 0.4];

/** What Mamori reaches out with. */
export type ReachStyle = "head" | "hand";

/** Two quick taps toward the pointer: out and back twice in about half a second. */
function taps(u: number): number {
  const one = (x: number) => (x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0);
  return one(u / 0.2) + one((u - 0.3) / 0.2);
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const inBox = (p: Vec, b: Box, m = 0) => p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;

function bezier(trip: Trip, u: number): Vec {
  const a = 1 - u;
  const b0 = a * a * a;
  const b1 = 3 * a * a * u;
  const b2 = 3 * a * u * u;
  const b3 = u * u * u;
  return vec(
    b0 * trip.p0.x + b1 * trip.p1.x + b2 * trip.p2.x + b3 * trip.p3.x,
    b0 * trip.p0.y + b1 * trip.p1.y + b2 * trip.p2.y + b3 * trip.p3.y,
  );
}

class Spring2 {
  readonly x: Spring;
  readonly y: Spring;
  constructor(v: Vec, k: number, d: number) {
    this.x = new Spring(v.x, k, d);
    this.y = new Spring(v.y, k, d);
  }
  set target(v: Vec) {
    this.x.target = v.x;
    this.y.target = v.y;
  }
  get target(): Vec {
    return vec(this.x.target, this.y.target);
  }
  get value(): Vec {
    return vec(this.x.value, this.y.value);
  }
  get velocity(): Vec {
    return vec(this.x.velocity, this.y.velocity);
  }
  step(dt: number) {
    this.x.step(dt);
    this.y.step(dt);
  }
  snap(v: Vec) {
    this.x.snap(v.x);
    this.y.snap(v.y);
  }
}

/** Pulls a trailing spring point back to within `max` of where it is heading. */
function leash2(p: Spring2, max: number) {
  const dx = p.x.value - p.x.target;
  const dy = p.y.value - p.y.target;
  const l = Math.hypot(dx, dy);
  if (l <= max) return;
  const k = max / l;
  p.x.value = p.x.target + dx * k;
  p.y.value = p.y.target + dy * k;
}

export class Roamer {
  readonly marsh: Marshmori;
  /** Called once Mamori's head is back inside the island. */
  onHome: () => void = () => {};
  /** Called when the head reaches the pointer (each time, chases included). */
  onArrive: () => void = () => {};
  /** Called every frame after Mamori moved (the view places the bubble). */
  onMoved: () => void = () => {};
  /** A tap landed on the pointer (the view draws a ripple there). */
  onTap: (at: Vec) => void = () => {};
  request: RoamRequest | null = null;
  screen = { w: 1920, h: 1080 };
  /** Where the pointer means "I'm dealing with it" (the bubble, the head, with a margin). */
  zones: Box[] = [];

  private readonly unit: number;
  /** How it reaches out this time. */
  private style: ReachStyle = "head";
  /** Which hand reaches out (hand style): -1 left, 1 right. */
  private handSide = 1;
  /** The head's centre. In hand style it stays in its seat. */
  private head = new Spring2(vec(), 120, 17);
  /** The reaching hand's centre (hand style). */
  private paw = new Spring2(vec(), 130, 16);
  /** Pixels per head unit of what is out here (the head, or the hand), grows as it goes. */
  private size = new Spring(ROAM_UNIT, 110, 15);
  /** Two taps toward the pointer, started at this time (-1: not tapping). */
  private tapAt = -1;
  private tapDir = vec(0, -1);
  private tapsLanded = 0;
  /** The neck's two bend points: they trail the head, so the noodle swings. */
  private c1 = new Spring2(vec(), 60, 10);
  private c2 = new Spring2(vec(), 80, 11);
  private tilt = new Spring(0, 90, 10);
  /**
   * Where the hands hold on: the island's edge under Mamori's seat. When the island
   * changes shape while the head is out (a card closes, the pill grows) this glides
   * after it with the same spring as the island's own, so the hands never let go.
   */
  private hold = new Spring2(vec(), 260, 28);
  private holdScale = new Spring(0.55, 260, 28);
  private phase: Phase = "hidden";
  private trip: Trip | null = null;
  private time = 0;
  private nest = vec();
  private nestScale = 0.55;
  private cursor = vec();
  private aimedAt = vec();
  private arrivedAt = 0;
  private phaseStart = 0;
  private side = 1;
  private stayed = 0;
  private engagedNow = false;
  private engagedFor = 0;
  private lastPointer = vec();
  /** Where the pointer was when Mamori got there (resting there isn't "dealing with it"). */
  private pointerAtArrival = vec();
  private everEngaged = false;
  private waveAt = 0;
  private cheerUntil = 0;
  private homeAt = Infinity;
  private reduced = false;

  constructor(container: HTMLElement, color: ColorName = "cream", opts: { unit?: number } = {}) {
    this.unit = opts.unit ?? ROAM_UNIT;
    this.size.snap(this.unit);
    this.marsh = new Marshmori(container, { mode: "reach", color, quality: "normal", autoStart: false, idle: false });
    this.marsh.onFrame = (dt) => this.tick(dt);
  }

  get visible(): boolean {
    return this.phase !== "hidden";
  }

  /** The head is next to the pointer (the bubble shows only then). */
  get arrived(): boolean {
    return this.phase === "arrived";
  }

  /** Scene time in seconds (stepped by hand while recording). */
  get now(): number {
    return this.time;
  }

  get reducedMotion(): boolean {
    return this.reduced;
  }

  /** The pointer is over the bubble or Mamori's head right now. */
  get engaged(): boolean {
    return this.engagedNow;
  }

  get pointer(): Vec {
    return this.cursor;
  }

  setColor(c: ColorName) {
    this.marsh.setColor(c);
  }

  setReducedMotion(on: boolean) {
    this.reduced = on;
    this.marsh.setReducedMotion(on);
  }

  /** Pixels per head unit back in the island. */
  private get nestPx(): number {
    return this.unit * this.nestScale;
  }

  /** Pixels per head unit where the hands are right now (follows the island). */
  private get holdPx(): number {
    return this.unit * this.holdScale.value;
  }

  /** The middle of the island's edge, where the hands hold on and the neck comes out. */
  private get anchor(): Vec {
    return vec(this.hold.x.value, this.hold.y.value + HANG_SCREEN.lip * this.holdPx);
  }

  /** What travels: the head, or the reaching hand. */
  private get mover(): Spring2 {
    return this.style === "hand" ? this.paw : this.head;
  }

  /** Where the reaching hand held the edge (and goes back to). */
  private pawHome(): Vec {
    return gripPoint(this.anchor, this.holdPx, this.handSide);
  }

  /** Where what's out here goes back to. */
  private homePoint(): Vec {
    return this.style === "hand" ? this.pawHome() : this.nest;
  }

  /**
   * Reach out of the island (`nest` = the head's centre there, `nestScale` its size
   * relative to full) to `cursor`. Called again while out, it just follows.
   */
  go(nest: Vec, nestScale: number, cursor: Vec, request: RoamRequest) {
    this.request = request;
    this.nest = { ...nest };
    this.nestScale = nestScale;
    this.cursor = { ...cursor };
    this.stayed = 0;
    this.engagedFor = 0;
    this.everEngaged = false;
    this.cheerUntil = 0;
    this.homeAt = Infinity;
    this.marsh.resize();
    if (this.phase === "hidden") {
      this.style = request.reach === "hand" ? "hand" : "head";
      this.handSide = cursor.x >= nest.x ? 1 : -1;
      this.hold.snap(nest);
      this.holdScale.snap(nestScale);
      this.head.snap(nest);
      this.size.snap(this.nestPx);
      this.tapAt = -1;
      const a = this.anchor;
      if (this.style === "hand") {
        const root = this.pawHome();
        this.paw.snap(root);
        this.c1.snap(vec(root.x, root.y + 4));
        this.c2.snap(vec(root.x, root.y + 8));
      } else {
        this.c1.snap(vec(a.x, a.y + 4));
        this.c2.snap(vec(nest.x, nest.y + this.nestPx));
      }
      this.tilt.snap(0);
      this.startTrip(this.targetFor(cursor), "out");
      // A little pop as it comes out.
      this.marsh.bump(2.2);
    } else {
      this.hold.target = nest;
      this.holdScale.target = nestScale;
      this.startTrip(this.targetFor(cursor), "chase");
    }
    this.setPhase("travel");
    this.marsh.setExpression("excited");
  }

  /** The neck (or the arm) winds back into the island. */
  home() {
    if (this.phase === "hidden" || this.phase === "returning") return;
    this.setPhase("returning");
    this.tapAt = -1;
    if (this.time >= this.cheerUntil) this.marsh.setExpression("happy");
    this.startTrip(this.homePoint(), "back");
  }

  /** A happy little moment (an approval answered), then home. */
  celebrate(face: ExpressionName = "love") {
    if (!this.visible) return;
    this.marsh.setExpression(face);
    this.cheerUntil = this.time + 0.75;
    this.marsh.bump(2.8);
    this.head.y.velocity -= 260;
    this.request = null;
    this.homeAt = this.time + 0.65;
  }

  /** Gone at once (the island was hidden, the display changed…). */
  abort() {
    this.phase = "hidden";
    this.trip = null;
    this.request = null;
    this.homeAt = Infinity;
    this.marsh.reach = null;
    this.marsh.stop();
  }

  /** The island grew or shrank, so Mamori's seat (and the edge it holds) moved. */
  setNest(nest: Vec, nestScale: number) {
    this.nest = { ...nest };
    this.nestScale = nestScale;
    this.hold.target = nest;
    this.holdScale.target = nestScale;
    if (this.phase === "returning") this.startTrip(this.style === "hand" ? gripPoint(vec(nest.x, nest.y + HANG_SCREEN.lip * this.unit * nestScale), this.unit * nestScale, this.handSide) : this.nest, "back");
  }

  setCursor(p: Vec) {
    this.cursor = { ...p };
  }

  // ── Planning ────────────────────────────────────────────────────────────────

  /**
   * Where the head goes: beside the pointer and a little below it, on the island's
   * side, so the neck never crosses what you're pointing at. The hand goes right up to
   * the tip of the pointer, from the island's way.
   */
  private targetFor(cursor: Vec): Vec {
    const { w, h } = this.screen;
    const u = this.unit;
    const a = this.anchor;
    this.aimedAt = { ...cursor };
    if (this.style === "hand") {
      const root = this.pawHome();
      const d = Math.max(1, dist(cursor, root));
      const r = pawRadius(u) + 3;
      const t = vec(cursor.x - ((cursor.x - root.x) / d) * r, cursor.y - ((cursor.y - root.y) / d) * r);
      return vec(clamp(t.x, r, w - r), clamp(t.y, r, h - r));
    }
    let side = a.x >= cursor.x ? 1 : -1;
    if (cursor.x + side * 2.6 * u > w - u) side = -1;
    if (cursor.x + side * 2.6 * u < u) side = 1;
    const t = vec(cursor.x + side * 1.6 * u, cursor.y + 0.95 * u);
    t.x = clamp(t.x, 1.4 * u, w - 1.4 * u);
    t.y = clamp(t.y, 1.8 * u, h - 1.4 * u);
    return t;
  }

  private startTrip(to: Vec, style: TripStyle) {
    const from = this.mover.value;
    const v = this.mover.velocity;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    const ux = d > 0.5 ? dx / d : 0;
    const uy = d > 0.5 ? dy / d : 0;
    const nx = -uy;
    const ny = ux;
    const drift = v.x * nx + v.y * ny;
    if (Math.abs(drift) > 30) this.side = Math.sign(drift);
    const arc = (this.reduced ? 0 : clamp(d * 0.22, 20, 170)) * this.side;
    let p1: Vec;
    let p2: Vec;
    let dur: number;
    switch (style) {
      case "out": // down out of the island first, then over to the pointer
        p1 = vec(from.x, from.y + Math.min(230, 50 + d * 0.35));
        p2 = vec(to.x - ux * d * 0.3 + nx * arc * 0.6, to.y - uy * d * 0.3 + ny * arc * 0.6);
        dur = clamp(0.55 + d / 1500, 0.6, 1.5);
        break;
      case "back": // up into the island from below, like a tape measure winding in
        p1 = vec(from.x + v.x * 0.15, from.y + v.y * 0.15 + 30);
        p2 = vec(to.x, to.y + Math.min(220, 40 + d * 0.32));
        dur = clamp(0.45 + d / 1700, 0.5, 1.3);
        break;
      default:
        p1 = vec(from.x + v.x * 0.25 + ux * d * 0.25 + nx * arc, from.y + v.y * 0.25 + uy * d * 0.25 + ny * arc);
        p2 = vec(to.x - ux * d * 0.3 + nx * arc * 0.6, to.y - uy * d * 0.3 + ny * arc * 0.6);
        dur = clamp(0.4 + d / 1500, 0.45, 1.3);
    }
    if (this.reduced) dur *= 0.7;
    this.trip = { p0: from, p1, p2, p3: to, start: this.time, dur, style };
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseStart = this.time;
  }

  /** Two taps toward the pointer: the nudge ("สะกิด"). */
  private tap() {
    if (this.reduced) return;
    const at = this.style === "hand" ? this.paw.value : this.head.value;
    const d = dist(this.cursor, at);
    this.tapDir = d > 1 ? vec((this.cursor.x - at.x) / d, (this.cursor.y - at.y) / d) : vec(0, -1);
    this.tapAt = this.time;
    this.tapsLanded = 0;
  }

  /** How far the taps have it moved toward the pointer right now. */
  private tapOffset(): Vec {
    if (this.tapAt < 0) return vec();
    const k = taps(this.time - this.tapAt) * TAP_REACH[this.style];
    return vec(this.tapDir.x * k, this.tapDir.y * k);
  }

  private arrivalFace(): ExpressionName {
    switch (this.request?.kind) {
      case "done":
        return "done";
      case "error":
        return "error";
      default:
        return "ask";
    }
  }

  // ── Every frame (called by the Marshmori before it draws) ───────────────────

  private tick(dt: number) {
    if (this.phase === "hidden") return;
    // Keeps up with the clock even when frames come slowly (springs sub-step, so a
    // long step is still stable); only a stall longer than this slows it down.
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const t = this.time;
    if (t >= this.homeAt) {
      this.homeAt = Infinity;
      this.home();
    }

    const mover = this.mover;
    if (this.trip) {
      const u = clamp((t - this.trip.start) / this.trip.dur, 0, 1);
      const k = this.trip.style === "chase" ? easeOut(u) : easeInOut(u);
      mover.target = bezier(this.trip, k);
    }
    // Full size out here; back to the island's size on the way home.
    this.size.target = this.phase === "returning" ? this.nestPx : this.unit;
    this.hold.step(dt);
    this.holdScale.step(dt);
    // Reaching with a hand, the head stays right in its seat (which glides with the island).
    if (this.style === "hand") {
      this.head.snap(this.hold.value);
      this.paw.step(dt);
    } else {
      this.head.step(dt);
    }
    this.size.step(dt);

    const p = mover.value;
    const v = mover.velocity;
    const speed = Math.hypot(v.x, v.y);
    const tripDone = !this.trip || t - this.trip.start >= this.trip.dur;
    const settled = tripDone && dist(p, mover.target) < 3 && speed < 60;

    // The taps: a ripple each time one lands.
    if (this.tapAt >= 0) {
      const u = t - this.tapAt;
      while (this.tapsLanded < TAP_HITS.length && u >= TAP_HITS[this.tapsLanded]) {
        this.tapsLanded++;
        this.onTap({ ...this.cursor });
      }
      if (u > 0.6) this.tapAt = -1;
    }
    const pointerSpeed = dt > 0 ? dist(this.cursor, this.lastPointer) / dt : 0;
    this.lastPointer = { ...this.cursor };
    // On the bubble or Mamori, after moving there: the pointer just resting where it
    // was (the hand taps right on it) doesn't count.
    const moved = this.phase !== "arrived" || dist(this.cursor, this.pointerAtArrival) > 6;
    this.engagedNow = moved && this.zones.some((z) => inBox(this.cursor, z));
    if (!this.engagedNow) this.engagedFor = 0;
    else if (pointerSpeed < 220) this.engagedFor += dt;
    if (this.engagedFor > 0.35) this.everEngaged = true;

    switch (this.phase) {
      case "travel":
        if (settled) {
          this.setPhase("arrived");
          this.arrivedAt = t;
          this.waveAt = t;
          this.pointerAtArrival = { ...this.cursor };
          this.marsh.setExpression(this.arrivalFace());
          this.marsh.bump(2);
          this.tap();
          this.onArrive();
        } else if (this.trip && this.request && t - this.trip.start > 0.3 && dist(this.cursor, this.aimedAt) > 50) {
          this.startTrip(this.targetFor(this.cursor), "chase");
        }
        break;
      case "arrived": {
        if (!this.engagedNow) this.stayed += dt;
        const kind = this.request?.kind ?? "done";
        if (this.request && this.stayed > STAY[kind]) {
          this.home();
          break;
        }
        const wandered = dist(this.cursor, this.aimedAt) > CHASE_DISTANCE;
        const near = this.zones.some((z) => inBox(this.cursor, z, 60));
        if (wandered && !near && !this.everEngaged && t - this.arrivedAt > 0.35 && this.request) {
          this.setPhase("travel");
          this.marsh.setExpression("happy");
          this.startTrip(this.targetFor(this.cursor), "chase");
        } else if (t - this.waveAt > ATTENTION_EVERY && !this.engagedNow && this.request?.kind === "approval") {
          // Still waiting: another nudge to say "over here".
          this.waveAt = t;
          this.marsh.react("excited", 900);
          this.marsh.bump(2.6);
          this.tap();
        }
        break;
      }
      case "returning":
        if ((tripDone && dist(p, this.homePoint()) < 2.5 && Math.abs(this.size.value - this.nestPx) < 0.8) || t - this.phaseStart > 2.6) {
          this.setPhase("hidden");
          this.trip = null;
          this.request = null;
          this.marsh.reach = null;
          this.marsh.stop();
          this.onHome();
          return;
        }
        break;
    }

    this.noodle(dt, v);

    // The head leans into the way it's going, and sways a little while it waits. Left
    // at home (hand style), it leans a little toward where its hand went.
    const sway = this.phase === "arrived" && !this.reduced ? 0.05 * Math.sin(t * 1.3) : 0;
    const lean = this.style === "hand" ? clamp((this.head.value.x - this.paw.value.x) * 0.0004, -0.18, 0.18) : clamp(-v.x * 0.00045, -0.3, 0.3);
    this.tilt.target = this.reduced ? 0 : lean + sway;
    this.tilt.step(dt);

    // Drawn smoothly while moving; half the frames while it just waits.
    this.marsh.fpsHint = this.phase === "arrived" && speed < 20 && !this.engagedNow && this.tapAt < 0 ? 30 : 60;

    // Eyes on the pointer.
    const head = this.marsh.headOnScreen();
    this.marsh.lookAt([clamp((this.cursor.x - head.x) / 170, -1, 1), clamp((this.cursor.y - head.y) / 170, -1, 1)]);
    this.marsh.reach = this.pose();
    this.onMoved();
  }

  /**
   * The bend points of what is stretched (the neck, or the arm): straight down out of
   * the island first, then up into the head (or the hand) from below — a soft hanging
   * noodle that trails behind when it moves.
   */
  private noodle(dt: number, v: Vec) {
    const hand = this.style === "hand";
    const a = hand ? this.pawHome() : this.anchor;
    const s = this.size.value;
    const chin = hand ? this.paw.value : vec(this.head.value.x, this.head.value.y + 0.5 * s);
    const d = dist(a, chin);
    const t = this.time;
    const idle = this.phase === "arrived" && !this.reduced;
    const sway1 = idle ? 9 * Math.sin(t * 1.1) : 0;
    const sway2 = idle ? 6 * Math.sin(t * 1.45 + 1) : 0;
    if (d < 2 * s || this.phase === "returning") {
      // Barely out, or being reeled in: a taut neck with a little sag, so it winds home
      // like a tape measure instead of curling past the head.
      const sag = Math.min(d * 0.15, 40);
      this.c1.target = vec(a.x + (chin.x - a.x) * 0.33, a.y + (chin.y - a.y) * 0.33 + sag);
      this.c2.target = vec(a.x + (chin.x - a.x) * 0.7, a.y + (chin.y - a.y) * 0.7 + sag * 0.7);
    } else if (hand) {
      // An arm reaches: out of the island and down a little, then along the way to the
      // hand, sagging softly in the middle under its own weight.
      const ux = (chin.x - a.x) / d;
      const uy = (chin.y - a.y) / d;
      const sag = clamp(d * 0.12, 10, 90);
      this.c1.target = vec(a.x + ux * d * 0.18 + sway1 * 0.5, a.y + clamp(d * 0.22, 0.5 * this.holdPx, 160) + sag * 0.4);
      this.c2.target = vec(chin.x - ux * d * 0.34 - v.x * 0.06 + sway2 * 0.5, chin.y - uy * d * 0.34 + sag - v.y * 0.04);
    } else {
      this.c1.target = vec(a.x + sway1, a.y + clamp(d * 0.42, 0.6 * this.holdPx, 280));
      this.c2.target = vec(chin.x - v.x * 0.08 + sway2, chin.y + clamp(d * 0.32, 0.4 * s, 220) - v.y * 0.05);
    }
    this.c1.step(dt);
    this.c2.step(dt);
    // They trail the head, but never so far behind that the noodle loops around it.
    const leash = 12 + d * 0.3;
    leash2(this.c1, leash);
    leash2(this.c2, leash);
  }

  private pose(): ReachPose {
    const a = this.anchor;
    const off = this.tapOffset();
    if (this.style === "hand") {
      const at = this.paw.value;
      return {
        anchor: a,
        anchorScale: this.holdPx,
        head: this.head.value,
        headScale: this.holdPx,
        c1: this.c1.value,
        c2: this.c2.value,
        tilt: this.tilt.value,
        grip: clamp((dist(a, at) - 8 * this.unit) / (30 * this.unit), 0, 0.6),
        paw: { side: this.handSide, at: vec(at.x + off.x, at.y + off.y), scale: this.size.value },
      };
    }
    const head = this.head.value;
    const d = dist(a, head);
    return {
      anchor: a,
      anchorScale: this.holdPx,
      head: vec(head.x + off.x, head.y + off.y),
      headScale: this.size.value,
      c1: this.c1.value,
      c2: this.c2.value,
      tilt: this.tilt.value,
      grip: clamp((d - 6 * this.unit) / (24 * this.unit), 0, 1),
    };
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /**
   * What is out here (the head, or the reaching hand): centre and radius in overlay
   * pixels, as drawn, taps included.
   */
  headCenter(): { x: number; y: number; r: number } {
    if (this.style === "hand") {
      const off = this.tapOffset();
      const at = this.paw.value;
      return { x: at.x + off.x, y: at.y + off.y, r: pawRadius(this.size.value) };
    }
    return this.marsh.headOnScreen();
  }

  /** Where the bubble points: the top of the head, or just above the hand. */
  bubbleAnchor(): Vec {
    const h = this.headCenter();
    return vec(h.x, h.y - h.r * (this.style === "hand" ? 1.4 : 1.2));
  }

  /** Overlay rectangle around the head (or the hand), for click-through (the neck and the arm let clicks through). */
  bounds(): Box {
    const h = this.headCenter();
    if (this.style === "hand") {
      const r = h.r * 1.6;
      return { x: h.x - r, y: h.y - r, w: r * 2, h: r * 2 };
    }
    const top = h.y - h.r * 1.55;
    const bottom = h.y + h.r * 0.95;
    return { x: h.x - h.r * 1.15, y: top, w: h.r * 2.3, h: bottom - top };
  }
}
