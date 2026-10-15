// Springs for the interface. The island's shape and Mamori's seat move like the
// Dynamic Island, only softer: a touch of overshoot, never a linear tween. A spring
// keeps its velocity when the target changes mid-flight, so a new state blends into
// the motion instead of restarting it.

import type { MotionSetting } from "./types";

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  /** A target to switch to once `wait` seconds have passed (a staggered start). */
  private next: number | null = null;
  private wait = 0;

  constructor(value: number, public stiffness = 260, public damping = 28) {
    this.value = value;
    this.target = value;
  }

  /** Where it is heading: the target, or the one it is about to switch to. */
  get goal(): number {
    return this.next ?? this.target;
  }

  /**
   * A new target, now or `delay` seconds from now (until then it carries on as it
   * was). A target that comes while a delayed one is still waiting takes its place
   * and keeps the wait, so a small correction doesn't cut a staggered start short.
   */
  aim(target: number, delay = 0) {
    if (delay > 0) {
      if (target === this.goal) return;
      this.next = target;
      this.wait = delay;
    } else if (this.next !== null) {
      this.next = target;
    } else {
      this.target = target;
    }
  }

  /** Semi-implicit Euler in small sub-steps: stable at any frame rate. */
  step(dt: number) {
    if (this.next !== null) {
      this.wait -= dt;
      if (this.wait <= 0) {
        this.target = this.next;
        this.next = null;
        this.wait = 0;
      }
    }
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
  }

  snap(v = this.goal) {
    this.value = v;
    this.target = v;
    this.velocity = 0;
    this.next = null;
    this.wait = 0;
  }

  /** Moves the whole motion by `d` (measured from somewhere else now): same place, same speed. */
  shift(d: number) {
    this.value += d;
    this.target += d;
    if (this.next !== null) this.next += d;
  }

  get settled(): boolean {
    return this.next === null && Math.abs(this.value - this.target) < 0.05 && Math.abs(this.velocity) < 0.5;
  }
}

/** How one spring moves: `delay` (seconds) holds it back a moment before it sets off. */
export interface Feel {
  stiffness: number;
  damping: number;
  delay?: number;
}

/** A spring by its bounce: `zeta` 1 settles without overshoot, lower overshoots more. */
export function feel(stiffness: number, zeta: number, delay = 0): Feel {
  return { stiffness, damping: 2 * zeta * Math.sqrt(stiffness), delay };
}

/** Several named springs moved together by one animation loop. */
export class Motion<K extends string> {
  readonly s: Record<K, Spring>;
  private raf = 0;
  reduced = false;

  /** Called with true when a motion starts and false once everything has settled. */
  onActive: ((moving: boolean) => void) | null = null;

  constructor(
    initial: Record<K, number>,
    private readonly apply: (v: Record<K, number>) => void,
    stiffness = 260,
    damping = 28,
  ) {
    const s = {} as Record<K, Spring>;
    for (const k of Object.keys(initial) as K[]) s[k] = new Spring(initial[k], stiffness, damping);
    this.s = s;
  }

  values(): Record<K, number> {
    const out = {} as Record<K, number>;
    for (const k of Object.keys(this.s) as K[]) out[k] = this.s[k].value;
    return out;
  }

  /** Where each spring is heading (a delayed target counts). */
  targets(): Record<K, number> {
    const out = {} as Record<K, number>;
    for (const k of Object.keys(this.s) as K[]) out[k] = this.s[k].goal;
    return out;
  }

  /** New targets; the motion carries on from where it is. */
  to(targets: Partial<Record<K, number>>, opts: Partial<Feel> & { snap?: boolean } = {}) {
    for (const k of Object.keys(targets) as K[]) {
      const sp = this.s[k];
      const t = targets[k];
      if (!sp || t === undefined || !Number.isFinite(t)) continue;
      if (opts.stiffness) sp.stiffness = opts.stiffness;
      if (opts.damping) sp.damping = opts.damping;
      if (opts.snap || this.reduced) sp.snap(t);
      else sp.aim(t, opts.delay ?? 0);
    }
    this.kick();
  }

  get moving(): boolean {
    return (Object.values(this.s) as Spring[]).some((sp) => !sp.settled);
  }

  /** Draws the current values again (something they're measured against moved). */
  redraw() {
    this.apply(this.values());
  }

  private kick() {
    this.apply(this.values());
    if (this.raf || !this.moving) return;
    this.onActive?.(true);
    let last = -1;
    const loop = (now: number) => {
      // The first frame steps one frame's worth: a frame's timestamp can be older than
      // the moment the motion was asked for, and a negative step would jerk it back.
      const dt = last < 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      for (const sp of Object.values(this.s) as Spring[]) sp.step(dt);
      this.apply(this.values());
      if (this.moving) {
        this.raf = requestAnimationFrame(loop);
      } else {
        this.raf = 0;
        this.onActive?.(false);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }
}

// Windows' "Animation effects" off shows up as prefers-reduced-motion. The motion
// setting (ตั้งค่า › ทั่วไป › การเคลื่อนไหว) either follows it or overrides it, so each
// page keeps the setting here and asks reducedMotion() instead of the media query.
const reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let motionSetting: MotionSetting = "system";

/** Windows' "Animation effects" are off, whatever the setting says. */
export const systemReducesMotion = () => reduceQuery?.matches === true;

/** Calm motion only: Windows' animations are off and the setting follows Windows. */
export const reducedMotion = () => motionSetting !== "full" && systemReducesMotion();

/**
 * Keeps reducedMotion() and `<html data-motion="reduced|full">` (what the CSS goes by)
 * in step with the setting, now and whenever Windows' setting changes. `changed` hears
 * about every flip, the first one included.
 */
export function useMotion(get: () => MotionSetting | undefined, changed?: (reduced: boolean) => void): () => void {
  const apply = () => {
    motionSetting = get() ?? "system";
    const motion = reducedMotion() ? "reduced" : "full";
    if (document.documentElement.dataset.motion !== motion) {
      document.documentElement.dataset.motion = motion;
      changed?.(motion === "reduced");
    }
  };
  apply();
  reduceQuery?.addEventListener("change", apply);
  return apply;
}
