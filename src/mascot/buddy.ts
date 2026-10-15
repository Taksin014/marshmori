// Marshmori with its whole stretchy body, standing in a box of its own: the settings
// preview and the design pages. (In the island Mamori hangs on the edge by its hands;
// when it reaches out over the screen only its head and long neck travel, driven by
// roam/roamer.ts.)

import type { ColorName, ExpressionName } from "./expressions";
import { Marshmori } from "./marsh";
import {
  airborne,
  cheering,
  jumping,
  longArms,
  peeking,
  pointing,
  running,
  sitting,
  standing,
  stretching,
  v3,
  waving,
  type Pose,
} from "./rig";

export type BuddyPose =
  | "stand" | "wave" | "run" | "point" | "jump" | "stretch" | "peek" | "sit" | "hop" | "cheer"
  | "short" | "long" | "superlong" | "arms";

export const BUDDY_POSES: BuddyPose[] = ["stand", "wave", "run", "point", "hop", "cheer", "jump", "stretch", "peek", "sit"];

/** The stretchy modes: as usual, Long Neck (a bit and all the way), Long Arms. */
export const ELASTIC_POSES: BuddyPose[] = ["stand", "long", "superlong", "arms"];

export const POSE_LABELS: Record<BuddyPose, string> = {
  stand: "ยืน",
  wave: "โบกมือ",
  run: "วิ่ง",
  point: "ชี้",
  hop: "กระโดดดีใจ",
  jump: "ลอยกลางอากาศ",
  stretch: "ยืดตัว",
  peek: "ยื่นคอ",
  sit: "นั่งรอ",
  cheer: "ชูมือ",
  short: "ย่อตัว",
  long: "ยืดคอ",
  superlong: "คอยาวสุด ๆ",
  arms: "แขนยาว",
};

/** Where every part wants to be for `pose` at time `t` (seconds). */
export function poseTargets(pose: BuddyPose, t: number): Pose {
  switch (pose) {
    case "stand":
      return standing(t);
    case "run":
      return running(t * 9);
    case "point":
      return pointing(v3(2.1, 1.3, 0.6), t);
    case "wave":
      return waving(t, 1);
    case "sit":
      return sitting(t);
    case "stretch":
      return stretching(t);
    case "jump":
      return airborne(t);
    case "hop":
      return jumping(t);
    case "peek":
      return peeking(t);
    case "cheer":
      return cheering(t);
    case "short":
      return { ...standing(t), squash: 0.86, bob: -0.04 };
    case "long":
      return { ...standing(t), neck: 0.9 + 0.03 * Math.sin(t * 2) };
    case "superlong":
      return { ...standing(t), neck: 2.1 + 0.05 * Math.sin(t * 1.6), neckBend: 0.25 * Math.sin(t * 1.1), headTilt: -0.08 };
    case "arms":
      return longArms(t);
  }
}

/** How far the body turns for a pose (running is seen from the side). */
export function poseYaw(pose: BuddyPose): number {
  return pose === "run" ? 1.05 : 0;
}

export interface BuddyOptions {
  color?: ColorName;
  /** Stands still on "stand" but now and then waves or stretches. */
  idle?: boolean;
  quality?: "normal" | "high";
}

export class Buddy {
  readonly marsh: Marshmori;
  private pose: BuddyPose = "stand";
  private extra: { pose: BuddyPose; until: number } | null = null;
  private nextIdle = 5;
  private readonly idle: boolean;
  private t = 0;

  constructor(container: HTMLElement, opts: BuddyOptions = {}) {
    this.idle = opts.idle ?? true;
    this.marsh = new Marshmori(container, { mode: "full", color: opts.color, quality: opts.quality ?? "high", idle: true });
    this.marsh.onFrame = (dt) => {
      this.t += dt;
      if (this.idle && this.pose === "stand" && this.t >= this.nextIdle && !this.extra) {
        const pick: BuddyPose = Math.random() < 0.5 ? "wave" : Math.random() < 0.5 ? "stretch" : "hop";
        this.extra = { pose: pick, until: this.t + (pick === "wave" ? 1.5 : pick === "hop" ? 2.2 : 2.6) };
        this.nextIdle = this.t + 7 + Math.random() * 6;
      }
      if (this.extra && this.t >= this.extra.until) this.extra = null;
      this.marsh.yaw.target = poseYaw(this.current());
    };
    this.marsh.poseFor = (t) => poseTargets(this.current(), t);
  }

  private current(): BuddyPose {
    return this.extra && this.t < this.extra.until ? this.extra.pose : this.pose;
  }

  setPose(p: BuddyPose) {
    this.pose = p;
    this.extra = null;
  }

  setExpression(e: ExpressionName) {
    this.marsh.setExpression(e);
  }

  setColor(c: ColorName) {
    this.marsh.setColor(c);
  }

  setReducedMotion(on: boolean) {
    this.marsh.setReducedMotion(on);
  }

  lookAt(target: [number, number] | null) {
    this.marsh.lookAt(target);
  }

  poke() {
    this.marsh.poke();
  }

  stop() {
    this.marsh.dispose();
  }
}
