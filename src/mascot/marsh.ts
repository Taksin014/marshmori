// Marshmori in 3D: one WebGL canvas (three.js) for the character and a 2D canvas on
// top for the little effects around its head (sparkles, hearts, "!", "zz"…).
//
// The same component shows just the head (the island at the top of the screen) or
// the whole stretchy body (the settings preview, and the trips to the mouse pointer).
// It renders only while it is on screen, and at 30 frames a second when nothing
// much is happening.

import {
  Color,
  NeutralToneMapping,
  DirectionalLight,
  HemisphereLight,
  OrthographicCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import {
  BADGE_COLORS,
  BADGE_FOR,
  MOOD_COLORS,
  EXPR,
  type BadgeKind,
  type ColorName,
  type Effect,
  type Expression,
  type ExpressionName,
  type MotionKind,
  type SproutKind,
} from "./expressions";
import { FacePainter, heartPath } from "./face";
import { HEAD_R, MarshModel, VIEW_ELEVATION, type ModelControls, type ReachPose } from "./model";
import { HANG_REST_Y, hanging, Rig, Spring, standing, TORSO_HEIGHT, v3, type Pose, type Vec3 } from "./rig";

export type { BadgeKind, ColorName, ExpressionName } from "./expressions";

export interface MarshOptions {
  /**
   * "head" for the island, "full" for the whole body, "reach" for the head out on its
   * long neck across the screen (the box is the whole overlay; see `reach`).
   */
  mode?: "head" | "full" | "reach";
  color?: ColorName;
  /** "high" paints the face sharper, for big previews. */
  quality?: "normal" | "high";
  /** Start the animation loop right away (default true). */
  autoStart?: boolean;
  /** Little idle actions (a glance, a double blink, a hop, a yawn) when nothing is going on. */
  idle?: boolean;
  /** Effects around the head (default true). */
  effects?: boolean;
}

interface Particle {
  kind: "z" | "spark" | "heart" | "puff";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  color: string;
}

type IdleKind = "glance" | "blink2" | "leaves" | "hop" | "smile" | "yawn";

const TAU = Math.PI * 2;
const INK = "#211A16";
/** The indigo of "!!", "?" and "z" (like the marks on the character sheet). */
const MARK = "#5B5BD6";
const GOLD = "#F2B53A";
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Head motion of each expression, in face units (1/31 of the head's radius). */
function motionPose(kind: MotionKind, t: number) {
  const p = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
  switch (kind) {
    case "breathe": {
      const s = Math.sin((t * TAU) / 3.4);
      p.sx = 1 - 0.018 * s;
      p.sy = 1 + 0.024 * s;
      break;
    }
    case "bounce": {
      const up = Math.max(0, Math.sin((t * TAU) / 0.9));
      p.dy = -2.4 * up;
      p.sx = 1 + 0.035 * (1 - up) - 0.01;
      p.sy = 1 - 0.035 * (1 - up) + 0.015 * up;
      break;
    }
    case "bob": {
      const q = (t % 0.62) / 0.62;
      const s = Math.abs(Math.sin(q * Math.PI));
      p.dy = -2.8 * s;
      p.sx = 1 + 0.04 * (1 - s);
      p.sy = 1 - 0.04 * (1 - s);
      break;
    }
    case "hop": {
      const q = (t % 1.5) / 1.5;
      if (q < 0.12) {
        const k = q / 0.12;
        p.sx = 1 + 0.1 * k;
        p.sy = 1 - 0.1 * k;
      } else if (q < 0.52) {
        const r = (q - 0.12) / 0.4;
        p.dy = -11 * Math.sin(r * Math.PI);
        p.sx = 0.95 + 0.05 * Math.abs(r - 0.5) * 2;
        p.sy = 1.06 - 0.06 * Math.abs(r - 0.5) * 2;
      } else if (q < 0.66) {
        const k = 1 - (q - 0.52) / 0.14;
        p.sx = 1 + 0.12 * k;
        p.sy = 1 - 0.12 * k;
      }
      break;
    }
    case "wiggle":
      p.rot = 0.085 * Math.sin((t * TAU) / 0.5);
      p.sy = 1 + 0.015 * Math.sin((t * TAU) / 0.25);
      break;
    case "shiver":
      p.dx = 0.75 * Math.sin(t * TAU * 13);
      p.rot = 0.02 * Math.sin(t * TAU * 7);
      break;
    case "sway": {
      const s = Math.sin((t * TAU) / 2.6);
      p.rot = 0.06 * s;
      p.dx = 1.2 * s;
      break;
    }
    case "sink": {
      const s = Math.sin((t * TAU) / 4.2);
      p.sx = 1.035 + 0.012 * s;
      p.sy = 0.95 - 0.016 * s;
      break;
    }
    case "wobble":
      p.rot = 0.16 * Math.sin(t * 6.5);
      p.dx = 2.2 * Math.cos(t * 6.5);
      break;
    case "still":
      break;
  }
  return p;
}

/**
 * "low" when WebGL runs without a real graphics card (a software renderer: no GPU
 * driver, a remote desktop, a blocked GPU). Mamori then draws at most 30 frames a
 * second and at a lower resolution, so the rest of the computer stays smooth.
 */
let tier: "high" | "low" | null = null;
export function gpuTier(): "high" | "low" {
  if (tier) return tier;
  tier = "high";
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) tier = "low";
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // Keep "high": the renderer itself will say if WebGL is missing.
  }
  return tier;
}

function star4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, inner: number, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : inner;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
}

export class Marshmori {
  readonly el: HTMLDivElement;
  readonly gl: HTMLCanvasElement;
  readonly fx: HTMLCanvasElement;
  readonly rig = new Rig();
  readonly model: MarshModel | null = null;
  /** Full body: the pose for time t (default: standing about). */
  poseFor: ((t: number) => Pose) | null = null;
  /** Called every frame before anything moves (the roamer steers from here). */
  onFrame: ((dt: number) => void) | null = null;
  /** Turning the body (full mode): yaw toward the way it runs, roll into curves. */
  readonly yaw = new Spring(0, 70, 12);
  readonly roll = new Spring(0, 60, 11);
  extraLean = 0;
  stretch = 1;
  /** Reach mode: where the head, the neck and the hands are this frame (set from onFrame). */
  reach: ReachPose | null = null;
  /** The most frames a second worth drawing right now (the roamer lowers it when still). */
  fpsHint = 60;

  private readonly mode: "head" | "full" | "reach";
  private readonly fxCtx: CanvasRenderingContext2D;
  private readonly painter: FacePainter;
  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private viewCenter: Vec3 = { x: 0, y: 0, z: 0 };
  private unitPx = 40;
  /** The canvas is shown scaled by this much (CSS transform): lines thicken when small. */
  private displayScale = 1;
  private autoFrame = true;
  private cssW = 1;
  private cssH = 1;
  private readonly effects: boolean;
  private readonly idleEnabled: boolean;

  private base: ExpressionName = "normal";
  private current: ExpressionName = "normal";
  private reactionUntil = 0;
  private changedAt = 0;
  private gaze: [number, number] = [0, 0];
  private gazeTarget: [number, number] | null = null;
  private readonly headYaw = new Spring(0, 80, 13);
  private readonly headPitch = new Spring(0, 80, 13);
  private readonly squish = new Spring(1, 300, 13);
  private readonly eyeGrow = new Spring(1, 200, 16);
  private nextBlink = 1.5;
  private blinkStart = -10;
  private secondBlink = false;
  private idleAction: { kind: IdleKind; start: number; dur: number } | null = null;
  private nextIdle = 6;
  private particles: Particle[] = [];
  private emitClock: Record<string, number> = {};
  private pokes: number[] = [];
  private faceKey = "";
  /** The effects layer has something on it (it is hidden otherwise). */
  private fxShown = true;
  private time = 0;
  private raf = 0;
  private running = false;
  private lastFrame = 0;
  private lastTick = 0;
  private reducedMotion = false;
  private visible = true;
  private resizeObserver: ResizeObserver | null = null;
  /** The status bud: set from outside, or (undefined) whatever the face brings. */
  private badgeWanted: BadgeKind | null | undefined = undefined;
  private badge: BadgeKind | null = null;
  private badgeSince = -10;
  /** The bud on its way out (it shrinks away while the next one pops up). */
  private badgeOut: { kind: BadgeKind; at: number } | null = null;
  /** The rim light, tinted with the bud's colour: Mamori's mood shows round its edge. */
  private rimLight: DirectionalLight | null = null;
  private readonly rimColor = new Color("#e4ecff");
  private readonly rimRest = new Color("#e4ecff");
  private readonly rimWant = new Color("#e4ecff");
  /** The feeling's colour on the head (MOOD_COLORS): what it is, how strong, how far down. */
  private readonly moodColor = new Color("#ffffff");
  private readonly moodWant = new Color("#ffffff");
  private moodAmount = 0;
  private moodFill = 0;
  private readonly tmpV = new Vector3();

  constructor(container: HTMLElement, opts: MarshOptions = {}) {
    this.mode = opts.mode ?? "head";
    this.effects = opts.effects ?? true;
    this.idleEnabled = opts.idle ?? true;
    this.el = document.createElement("div");
    this.el.className = "marsh";
    this.el.style.cssText = "position:relative;width:100%;height:100%;";
    this.gl = document.createElement("canvas");
    this.fx = document.createElement("canvas");
    for (const c of [this.gl, this.fx]) {
      c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;";
    }
    this.el.append(this.gl, this.fx);
    container.appendChild(this.el);
    this.fxCtx = this.fx.getContext("2d")!;
    this.painter = new FacePainter(opts.quality === "high" ? 300 : 150);

    try {
      this.renderer = new WebGLRenderer({
        canvas: this.gl,
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: "low-power",
      });
    } catch {
      this.renderer = null;
    }
    if (this.renderer) {
      const r = this.renderer;
      r.setClearColor(0x000000, 0);
      r.outputColorSpace = SRGBColorSpace;
      // Neutral keeps the cream skin cream (ACES and AgX wash it out to grey).
      r.toneMapping = NeutralToneMapping;
      r.toneMappingExposure = 1;
      const pmrem = new PMREMGenerator(r);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      // Soft, low-contrast light, like a toy on a sunny desk: lots of ambient, a warm
      // key from the upper left, a faint cool rim from behind.
      this.scene.environmentIntensity = 0.85;
      const key = new DirectionalLight("#fff3e6", 1.2);
      key.position.set(-2.5, 4, 5);
      const rim = new DirectionalLight("#e4ecff", 0.7);
      rim.position.set(3.2, 2.4, -4);
      this.rimLight = rim;
      const fill = new HemisphereLight("#fffaf4", "#f1e2d4", 0.6);
      this.scene.add(key, rim, fill);
      const model = new MarshModel(this.painter.canvas, r.capabilities.getMaxAnisotropy());
      model.setColor(opts.color ?? "cream");
      model.setHeadOnly(this.mode === "head");
      this.scene.add(model.root);
      (this as { model: MarshModel | null }).model = model;
      this.gl.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.stop();
      });
      this.gl.addEventListener("webglcontextrestored", () => this.start());
    } else {
      this.el.classList.add("no-webgl");
    }

    // The island shows only the head, and the two hands holding on to the edge.
    this.rig.snap(standing(0));
    if (this.mode === "head") {
      const [l, r] = hanging("rest", 0);
      this.rig.lHand.snap(l);
      this.rig.rHand.snap(r);
    }
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.el);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    if (opts.autoStart !== false) this.start();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get ok(): boolean {
    return this.renderer !== null;
  }

  /** The resting face, driven by what the agents are doing. */
  setExpression(name: ExpressionName) {
    if (this.base === name) return;
    this.base = name;
    if (this.time >= this.reactionUntil) this.switchTo(name);
  }

  /** A short reaction on top of the resting face. */
  react(name: ExpressionName, ms = 1200) {
    this.reactionUntil = this.time + ms / 1000;
    this.switchTo(name);
  }

  get expression(): ExpressionName {
    return this.current;
  }

  /** Where to look, -1…1 each way (screen directions). `null` lets Marshmori look around. */
  lookAt(target: [number, number] | null) {
    this.gazeTarget = target ? [clamp(target[0], -1, 1), clamp(target[1], -1, 1)] : null;
  }

  setColor(color: ColorName) {
    this.model?.setColor(color);
    this.faceKey = "";
    if (!this.running) this.frame(0);
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
  }

  /** The pointer is on Marshmori: eyes a little bigger, and a blink hello. */
  setHover(on: boolean) {
    this.eyeGrow.target = on ? 1.14 : 1;
    if (on) this.nextBlink = this.time;
  }

  /** A click on Marshmori: squish and grumble; three quick ones and it gets dizzy. */
  poke() {
    const now = this.time;
    this.pokes = this.pokes.filter((p) => now - p < 1.3);
    this.pokes.push(now);
    this.squish.velocity -= 3.2;
    if (this.pokes.length >= 3) {
      this.pokes = [];
      this.react("dizzy", 2600);
    } else {
      this.react("annoyed", 900);
    }
  }

  /** A bounce from outside (landing, a decision…). */
  bump(amount = 2.4) {
    this.squish.velocity -= amount;
  }

  /**
   * The status bud on top of the sprout. `undefined` (the default) lets the face decide
   * (thinking, working, asking, done, a problem); `null` hides it; a kind shows that one.
   */
  setBadge(kind: BadgeKind | null | undefined) {
    this.badgeWanted = kind;
  }

  /** The bud showing right now. */
  get badgeShown(): BadgeKind | null {
    return this.badge;
  }

  /** Frames the camera: `center` (body space of the root) at the middle, `unitPx` CSS px per unit. */
  setView(center: Vec3, unitPx: number) {
    this.autoFrame = false;
    this.viewCenter = { ...center };
    this.unitPx = unitPx;
    this.updateCamera();
  }

  /** CSS pixels per unit (the head's radius is 1 unit). */
  get pixelsPerUnit(): number {
    return this.unitPx;
  }

  /** How much the page scales the canvas down (or up) when showing it. */
  setDisplayScale(k: number) {
    this.displayScale = Math.max(0.05, k);
  }

  /**
   * Still pictures of Marshmori (the island's side column): one throwaway renderer
   * draws them all. Returns PNG data URLs keyed "color|expression".
   */
  static avatars(list: { color: ColorName; expr: ExpressionName }[], size = 96): Map<string, string> {
    const out = new Map<string, string>();
    if (!list.length) return out;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:-10000px;top:0;width:${size}px;height:${size}px;pointer-events:none;`;
    document.body.appendChild(box);
    const m = new Marshmori(box, { mode: "head", quality: "high", autoStart: false, idle: false, effects: false });
    try {
      for (const { color, expr } of list) {
        const key = `${color}|${expr}`;
        if (out.has(key)) continue;
        m.setColor(color);
        m.renderAt(1.2, expr);
        out.set(key, m.snapshot());
      }
    } finally {
      m.dispose();
      box.remove();
    }
    return out;
  }

  /** Head centre and radius in CSS pixels, relative to the component's box. */
  headOnScreen(): { x: number; y: number; r: number } {
    if (!this.model) return { x: this.cssW / 2, y: this.cssH / 2, r: Math.min(this.cssW, this.cssH) * 0.35 };
    const v = new Vector3();
    this.model.head.getWorldPosition(v);
    v.project(this.camera);
    const r = this.mode === "reach" ? (this.reach?.headScale ?? this.unitPx) : this.unitPx;
    return { x: ((v.x + 1) / 2) * this.cssW, y: ((1 - v.y) / 2) * this.cssH, r: r * HEAD_R.x };
  }

  /**
   * Head only: how far down the component (CSS px) the edge Marshmori holds on to runs —
   * line it up with the bottom of the island, and the hands hang over it.
   */
  lipOnScreen(): number {
    return this.toScreen(v3(0, TORSO_HEIGHT + HANG_REST_Y + 0.05, 0.46)).y;
  }

  /** Head only, at rest (whatever the face is doing): head centre and radius, and the lip, in CSS px. */
  restOnScreen(): { x: number; y: number; r: number; lip: number } {
    const c = this.toScreen(MarshModel.headRest());
    return { x: c.x, y: c.y, r: this.unitPx * HEAD_R.x, lip: this.lipOnScreen() };
  }

  /** Any point of the body (body space of the root) in CSS pixels. */
  toScreen(p: Vec3): { x: number; y: number } {
    const v = new Vector3(p.x, p.y, p.z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.cssW, y: ((1 - v.y) / 2) * this.cssH };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTick = -1;
    this.lastFrame = -1;
    const loop = (ms: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const fps = this.reducedMotion ? 15 : this.targetFps();
      if (fps < 50 && this.lastFrame >= 0) {
        // A calm moment: every other refresh or so, kept on a steady grid (with slack
        // for vsync jitter) so it doesn't drift into a 1-2-1-3 stutter.
        const interval = 1000 / fps;
        const elapsed = ms - this.lastFrame;
        if (elapsed < interval - 4) return;
        this.lastFrame = elapsed >= interval ? ms - (elapsed % interval) : ms;
      } else {
        // Anything moving: every refresh the screen makes, the smoothest there is.
        this.lastFrame = ms;
      }
      const dt = this.lastTick < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (ms - this.lastTick) / 1000));
      this.lastTick = ms;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Advances by `dt` seconds and draws. Use instead of start() to drive it by hand. */
  frame(dt: number) {
    this.advance(dt);
    this.draw(this.time, dt);
  }

  /** Moves everything on by `dt` seconds without drawing. */
  advance(dt: number) {
    this.time += dt;
    this.onFrame?.(dt);
    this.step(this.time, dt);
  }

  /** Draws a still at time `seconds` with `expression` (exports, avatars). */
  renderAt(seconds: number, expression?: ExpressionName) {
    if (expression) {
      this.base = expression;
      this.current = expression;
      this.changedAt = seconds - 2;
    }
    this.time = Math.max(0, seconds - 2);
    this.particles = [];
    this.emitClock = {};
    // Let springs and particles settle, then draw that one frame.
    while (this.time < seconds - 1e-6) this.advance(Math.min(1 / 30, seconds - this.time));
    this.faceKey = "";
    this.draw(this.time, 0);
  }

  /** The effects layer is showing (copy it along with the WebGL canvas). */
  get effectsShown(): boolean {
    return this.fxShown;
  }

  /** The current frame as a PNG data URL. */
  snapshot(): string {
    if (!this.renderer) return "";
    this.draw(this.time, 0);
    const out = document.createElement("canvas");
    out.width = this.gl.width;
    out.height = this.gl.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(this.gl, 0, 0);
    if (this.fxShown) ctx.drawImage(this.fx, 0, 0);
    return out.toDataURL("image/png");
  }

  resize() {
    // Layout size, not the on-screen one: a parent may scale the box with a CSS
    // transform (the island's seat), and the canvas should stay sharp at its full size.
    const rect = this.el.getBoundingClientRect();
    this.cssW = Math.max(1, this.el.clientWidth || rect.width || 64);
    this.cssH = Math.max(1, this.el.clientHeight || rect.height || 64);
    // Sharp where it's small (the island), lighter where the canvas is big, and
    // lighter still without a real graphics card.
    const low = gpuTier() === "low";
    const cap = low ? (this.mode === "head" ? 1.5 : 1) : this.mode === "reach" ? 1.25 : this.mode === "full" ? 1.5 : 2;
    const dpr = Math.max(1, Math.min(cap, window.devicePixelRatio || 1));
    this.renderer?.setPixelRatio(dpr);
    this.renderer?.setSize(this.cssW, this.cssH, false);
    this.fx.width = Math.round(this.cssW * dpr);
    this.fx.height = Math.round(this.cssH * dpr);
    if (this.autoFrame) {
      if (this.mode === "head") {
        // The head (its origin is the widest line, eye level), dome and sprout, and the
        // hands below it, with room for a wave.
        const rest = MarshModel.headRest();
        this.viewCenter = { x: 0, y: rest.y + 0.28, z: 0 };
        this.unitPx = Math.min(this.cssW / 2.65, this.cssH / 2.45);
      } else {
        // Standing, sprout and all, with room above for a stretched neck.
        this.viewCenter = { x: 0, y: 1.95, z: 0 };
        this.unitPx = Math.min(this.cssW / 3.2, this.cssH / 4.9);
      }
    }
    this.updateCamera();
    if (!this.running) this.frame(0);
  }

  dispose() {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver?.disconnect();
    this.model?.dispose();
    // Hand the WebGL context back now (browsers keep only a handful alive).
    try {
      this.renderer?.forceContextLoss();
    } catch {
      // Already gone.
    }
    this.renderer?.dispose();
    this.el.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private onVisibility = () => {
    const wasVisible = this.visible;
    this.visible = document.visibilityState !== "hidden";
    if (this.visible && !wasVisible && this.running) {
      // Back on screen: carry on from here rather than catching up on the time away.
      this.lastTick = -1;
    }
  };

  private targetFps(): number {
    if (!this.visible) return 4;
    // A bounce in progress (a hop as the island opens, a bob as it lands, a poke) gets
    // every refresh, whatever the face's own pace: at 30 a squish reads as a stutter.
    const bouncing = Math.abs(this.squish.velocity) > 0.05 || Math.abs(this.squish.value - this.squish.target) > 0.004;
    const fps = bouncing ? 60 : this.mode === "reach" ? this.fpsHint : this.mode === "full" ? 60 : EXPR[this.current].fps;
    return gpuTier() === "low" ? Math.min(30, fps) : fps;
  }

  private updateCamera() {
    if (this.mode === "reach") {
      // One unit per CSS pixel over the whole overlay, y up; looking straight on (the
      // head tilts itself toward the camera instead, see MarshModel.updateReach).
      const cam = this.camera;
      cam.left = 0;
      cam.right = this.cssW;
      cam.top = 0;
      cam.bottom = -this.cssH;
      cam.near = 1;
      cam.far = 4000;
      cam.position.set(0, 0, 2000);
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      return;
    }
    const halfW = this.cssW / 2 / this.unitPx;
    const halfH = this.cssH / 2 / this.unitPx;
    const cam = this.camera;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    const e = VIEW_ELEVATION;
    const c = this.viewCenter;
    cam.position.set(c.x, c.y + Math.sin(e) * 30, c.z + Math.cos(e) * 30);
    cam.lookAt(c.x, c.y, c.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private switchTo(name: ExpressionName) {
    if (this.current === name) return;
    this.current = name;
    this.changedAt = this.time;
    this.particles = this.particles.filter((p) => p.age < p.life * 0.5);
  }

  private step(t: number, dt: number) {
    if (this.current !== this.base && t >= this.reactionUntil) this.switchTo(this.base);
    const ex = EXPR[this.current];

    // Blinking (twice now and then).
    if (t >= this.nextBlink) {
      this.blinkStart = t;
      if (this.secondBlink) {
        this.secondBlink = false;
        this.nextBlink = t + 2.4 + Math.random() * 3.2;
      } else if (Math.random() < 0.18) {
        this.secondBlink = true;
        this.nextBlink = t + 0.28;
      } else {
        this.nextBlink = t + 2.4 + Math.random() * 3.2;
      }
    }

    // Idle actions when nothing is going on.
    if (this.idleEnabled && this.current === "normal" && !this.reducedMotion) {
      if (!this.idleAction && t >= this.nextIdle) {
        const kinds: IdleKind[] = ["glance", "blink2", "leaves", "hop", "smile", "glance", "yawn"];
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        const dur = kind === "glance" ? 1.8 : kind === "yawn" ? 1.6 : kind === "smile" ? 1.3 : 0.9;
        this.idleAction = { kind, start: t, dur };
        if (kind === "blink2") {
          this.nextBlink = t;
          this.secondBlink = false;
        }
      }
      if (this.idleAction && t > this.idleAction.start + this.idleAction.dur) {
        this.idleAction = null;
        this.nextIdle = t + 6 + Math.random() * 9;
      }
    } else if (this.idleAction) {
      this.idleAction = null;
      this.nextIdle = t + 6;
    }

    // Gaze eases toward its target; the head turns with it.
    let target: [number, number] = this.gazeTarget ?? [0, 0];
    if (ex.look) target = ex.look;
    if (this.idleAction?.kind === "glance" && !this.gazeTarget) {
      const k = (t - this.idleAction.start) / this.idleAction.dur;
      target = [k < 0.5 ? -0.8 : 0.8, -0.1];
    }
    const ease = Math.min(1, dt * 9);
    this.gaze[0] += (target[0] - this.gaze[0]) * ease;
    this.gaze[1] += (target[1] - this.gaze[1]) * ease;
    this.headYaw.target = this.gaze[0] * 0.42;
    this.headPitch.target = this.gaze[1] * 0.26;
    this.headYaw.step(dt);
    this.headPitch.step(dt);
    this.squish.step(dt);
    this.eyeGrow.step(dt);
    this.yaw.step(dt);
    this.roll.step(dt);

    // The body; with only the head showing, just the hands.
    if (this.mode === "full") {
      this.rig.setTargets(this.poseFor ? this.poseFor(t) : standing(t));
      this.rig.step(dt);
    } else {
      const kind = this.reducedMotion ? "rest" : this.idleAction?.kind === "hop" ? "pat" : (ex.hands ?? "rest");
      const [l, r] = hanging(kind, t);
      this.rig.lHand.target = l;
      this.rig.rHand.target = r;
      this.rig.lHand.step(dt);
      this.rig.rHand.step(dt);
    }

    // Particles.
    if (this.effects && !this.reducedMotion) this.emit(ex.effects ?? [], t);
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "heart") p.x += Math.sin((p.age + p.rot) * 5) * 4 * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);

    // The status bud and the mood round Mamori's edge.
    const want = !this.effects ? null : this.badgeWanted !== undefined ? this.badgeWanted : (BADGE_FOR[this.current] ?? null);
    if (want !== this.badge) {
      if (this.badge) this.badgeOut = { kind: this.badge, at: t };
      this.badge = want;
      this.badgeSince = t;
      if (want === "done" && !this.reducedMotion) this.budBurst();
    }
    if (this.badgeOut && t - this.badgeOut.at > 0.25) this.badgeOut = null;
    // A feeling's colour runs down from the top of the head, and lifts off when it goes.
    const mood = MOOD_COLORS[this.current];
    if (mood) this.moodWant.set(mood.color);
    // Nothing showing yet: start in the new colour rather than blending from the last one.
    if (this.moodAmount < 0.02) this.moodColor.copy(this.moodWant);
    const rate = (r: number) => (this.reducedMotion ? 1 : Math.min(1, dt * r));
    this.moodColor.lerp(this.moodWant, rate(4.5));
    this.moodAmount += ((mood ? mood.amount : 0) - this.moodAmount) * rate(5);
    this.moodFill += ((mood ? 1 : 0) - this.moodFill) * rate(mood ? 2.6 : 4);
    if (this.rimLight) {
      this.rimWant.set(this.badge && this.badge !== "online" ? BADGE_COLORS[this.badge] : this.rimRest);
      const k = Math.min(1, dt * 3.2);
      this.rimColor.lerp(this.rimWant, k);
      this.rimLight.color.copy(this.rimColor);
      const glow = this.badge && this.badge !== "online" ? 1.25 : 0.7;
      this.rimLight.intensity += (glow - this.rimLight.intensity) * k;
    }
  }

  /** Where the bud sits, in the effects layer's units (31 to the head's radius, from its centre). */
  private budPoint(head: { x: number; y: number; r: number }): { x: number; y: number } {
    if (!this.model) return { x: 0, y: -52 };
    this.model.sproutTip(this.tmpV);
    this.tmpV.project(this.camera);
    const sx = ((this.tmpV.x + 1) / 2) * this.cssW;
    const sy = ((1 - this.tmpV.y) / 2) * this.cssH;
    return { x: ((sx - head.x) / head.r) * 31, y: ((sy - head.y) / head.r) * 31 - 7.5 };
  }

  /** Done: a little burst of sparkles out of the bud. */
  private budBurst() {
    const head = this.headOnScreen();
    const at = this.budPoint(head);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + Math.random() * 0.4;
      this.particles.push({
        kind: "spark",
        x: at.x,
        y: at.y,
        vx: Math.cos(a) * 26,
        vy: Math.sin(a) * 22 - 8,
        age: 0,
        life: 0.7,
        size: 2.6 + Math.random() * 1.8,
        rot: Math.random(),
        color: i % 2 ? GOLD : "#FFFFFF",
      });
    }
  }

  private blinkFactor(t: number): number {
    const d = t - this.blinkStart;
    if (d < 0 || d > 0.15) return 1;
    return 1 - Math.sin((d / 0.15) * Math.PI) * 0.92;
  }

  private sproutControls(kind: SproutKind, t: number): ModelControls["sprout"] {
    let s = 0;
    switch (kind) {
      case "sway": s = 0.1 * Math.sin((t * TAU) / 2.8); break;
      case "wiggle": s = 0.2 * Math.sin((t * TAU) / 0.45); break;
      case "tilt": s = 0.24 + 0.06 * Math.sin((t * TAU) / 2); break;
      case "perk": s = 0.035 * Math.sin((t * TAU) / 0.28); break;
      case "droop": s = -0.5 + 0.03 * Math.sin((t * TAU) / 3); break;
      case "fold": s = 0.06 * Math.sin((t * TAU) / 4.2); break;
      case "bloom": s = 0.08 * Math.sin((t * TAU) / 2); break;
      case "spin": s = 0.03 * Math.sin((t * TAU) / 0.5); break;
    }
    const bloom = kind === "bloom" ? easeOutBack(clamp01((t - this.changedAt) / 0.5)) : 0;
    switch (kind) {
      case "spin":
        return { lean: s, left: 0, right: 0, spin: t * 14, bloom };
      case "perk":
      case "bloom":
        return { lean: s, left: 1.18 + s, right: 0.98 - s, spin: null, bloom };
      case "fold":
        return { lean: s, left: 1.42 + s, right: 1.42 - s, spin: null, bloom };
      case "droop":
        return { lean: s, left: -0.42, right: -0.26, spin: null, bloom };
      default:
        // At rest the two leaves open into an uneven V, one a little higher.
        return { lean: s, left: 0.84 + s * 0.8, right: 0.54 - s * 0.8, spin: null, bloom };
    }
  }

  private draw(t: number, dt: number) {
    const ex = EXPR[this.current];
    const model = this.model;
    if (model && this.renderer) {
      // Face texture: repainted only when something on it changed.
      const animated = ["star", "heart", "swirl"].includes(ex.eyes) || ["open", "o"].includes(ex.mouth) || (ex.effects ?? []).some((e) => e === "tear" || e === "sweat");
      const blink = this.reducedMotion ? 1 : this.blinkFactor(t);
      const shown = this.unitPx * this.displayScale;
      const thick = shown < 14 ? 1.7 : shown < 22 ? 1.45 : shown < 40 ? 1.2 : 1;
      const idle = this.idleAction?.kind === "smile" ? "smile" : this.idleAction?.kind === "yawn" ? "yawn" : null;
      // Tiny on screen (the pill): the eyes a touch bigger so they still read.
      const boost = shown < 16 ? 1.22 : shown < 24 ? 1.1 : 1;
      const eyeScale = this.eyeGrow.value * boost;
      const key = `${this.current}|${blink.toFixed(2)}|${this.gaze[0].toFixed(2)}|${this.gaze[1].toFixed(2)}|${eyeScale.toFixed(2)}|${idle}|${thick}|${animated ? t.toFixed(2) : ""}`;
      if (key !== this.faceKey) {
        this.faceKey = key;
        this.painter.paint({
          expr: ex,
          gaze: this.gaze,
          blink,
          eyeScale,
          t,
          thick,
          idle,
          sinceChange: t - this.changedAt,
        });
        model.faceTexture.needsUpdate = true;
      }

      // Head motion: the expression's, the "pop" on every change, a hop when idle.
      let motion = ex.motion;
      if (this.idleAction?.kind === "hop") motion = "hop";
      const mp = this.reducedMotion ? motionPose("still", t) : motionPose(motion, this.idleAction?.kind === "hop" ? t - this.idleAction.start + 0.05 : t);
      const since = t - this.changedAt;
      if (since >= 0 && since < 0.22 && !this.reducedMotion) {
        const k = 1 - since / 0.22;
        mp.sx *= 1 + 0.09 * k;
        mp.sy *= 1 - 0.09 * k;
      }
      // In full mode the body carries the big moves; the head keeps the small ones.
      const big = this.mode === "head" ? 1 : this.mode === "reach" ? 0.6 : 0.35;
      let sprout = ex.sprout;
      if (this.idleAction?.kind === "leaves") sprout = "wiggle";
      const controls: ModelControls = {
        time: t,
        yaw: this.yaw.value,
        lean: this.extraLean,
        roll: this.roll.value,
        stretch: this.stretch,
        headYaw: this.headYaw.value,
        headPitch: this.headPitch.value,
        head: { dx: (mp.dx / 31) * big, dy: (-mp.dy / 31) * big, sx: mp.sx, sy: mp.sy, rot: -mp.rot },
        sprout: this.sproutControls(sprout, t),
        tint: ex.tint ?? 0,
        mood: { color: this.moodColor, amount: this.moodAmount, fill: this.moodFill },
        squish: this.squish.value,
      };
      if (this.mode === "reach") {
        if (this.reach) model.updateReach(this.reach, controls);
      } else {
        model.update(this.rig, controls);
      }
      this.renderer.render(this.scene, this.camera);
    }
    this.drawEffects(ex, t, dt);
  }

  // ── Effects around the head (2D overlay) ────────────────────────────────────
  //
  // Same units as the face (31 to the head's radius), with (0, 0) on the head's widest
  // line; the top of the dome is at y ≈ -35. Every mark has a soft white rim so it reads
  // on the black island as well as on a light desktop.

  private every(key: string, t: number, period: number): boolean {
    const last = this.emitClock[key] ?? -Infinity;
    if (t - last >= period) {
      this.emitClock[key] = t;
      return true;
    }
    return false;
  }

  private emit(effects: Effect[], t: number) {
    if (effects.includes("zz") && this.every("zz", t, 1.25)) {
      this.particles.push({ kind: "z", x: 22, y: -36, vx: 5, vy: -7.5, age: 0, life: 2.3, size: 4.4, rot: 0, color: MARK });
    }
    if (effects.includes("sparkle") && this.every("spark", t, 0.2)) {
      const a = Math.random() * TAU;
      const r = 40 + Math.random() * 9;
      this.particles.push({
        kind: "spark",
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.8 - 10,
        vx: 0,
        vy: -3,
        age: 0,
        life: 0.75,
        size: 3.4 + Math.random() * 2.6,
        rot: Math.random() * 0.6,
        color: Math.random() < 0.65 ? GOLD : "#FFFFFF",
      });
    }
    if (effects.includes("hearts") && this.every("heart", t, 0.45)) {
      this.particles.push({
        kind: "heart",
        x: 14 + Math.random() * 18,
        y: -34,
        vx: (Math.random() - 0.2) * 4,
        vy: -11,
        age: 0,
        life: 1.7,
        size: 6 + Math.random() * 2,
        rot: Math.random() * 3,
        color: Math.random() < 0.5 ? "#F4577D" : "#F98BA6",
      });
    }
  }

  private drawEffects(ex: Expression, t: number, _dt: number) {
    const ctx = this.fxCtx;
    const dpr = this.fx.width / this.cssW;
    // With the bud saying it, the face doesn't repeat it with "!!" or "…".
    const budSays = this.badge === "ask" || this.badge === "thinking" || this.badge === "waiting";
    const effects = this.effects ? (ex.effects ?? []).filter((e) => !(budSays && (e === "bang" || e === "dots"))) : [];
    const marks: Effect[] = ["bang", "question", "dots", "stars", "anger", "rays", "scribble"];
    if (!this.particles.length && !effects.some((e) => marks.includes(e)) && !this.badge && !this.badgeOut) {
      // Nothing to draw: hide the layer. (Chromium can drop a clearRect that has no
      // drawing after it, which would leave the last marks on screen.)
      if (this.fxShown) {
        this.fx.style.visibility = "hidden";
        this.fxShown = false;
      }
      return;
    }
    if (!this.fxShown) {
      this.fx.style.visibility = "visible";
      this.fxShown = true;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.fx.width, this.fx.height);
    const head = this.headOnScreen();
    const k = (head.r / 31) * dpr;
    ctx.setTransform(k, 0, 0, k, head.x * dpr, head.y * dpr);
    const shownR = head.r * this.displayScale;
    const thick = shownR < 14 ? 1.6 : shownR < 22 ? 1.35 : 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const p of this.particles) this.drawParticle(ctx, p, thick);
    const bx = 31;
    const by = -33;
    if (effects.includes("rays")) this.rays(ctx, t, thick);
    if (effects.includes("bang")) this.bang(ctx, bx, by, t, thick);
    if (effects.includes("question")) this.question(ctx, bx, by, t, thick);
    if (effects.includes("dots")) this.dots(ctx, bx - 2, by + 2, t);
    if (effects.includes("anger")) this.anger(ctx, bx, by + 2, t, thick);
    if (effects.includes("stars")) this.orbit(ctx, t);
    if (effects.includes("scribble")) this.scribble(ctx, bx + 1, by - 1, t, thick);
    if (this.badge || this.badgeOut) {
      const at = this.budPoint(head);
      // Never off the top of the canvas (the island's small seat): it slides down onto
      // the leaves instead.
      const top = (3 - head.y) / (head.r / 31) + 8;
      if (at.y < top) at.y = top;
      if (this.badgeOut) this.drawBud(ctx, at, this.badgeOut.kind, 1 - clamp01((t - this.badgeOut.at) / 0.22), t, thick);
      if (this.badge) {
        const since = t - this.badgeSince;
        const pop = this.reducedMotion ? 1 : since < 0.12 ? 0 : easeOutBack(clamp01((since - 0.12) / 0.42));
        this.drawBud(ctx, at, this.badge, pop, t, thick);
      }
    }
  }

  /**
   * The status bud: a round bud on the sprout in the state's colour, white-rimmed so it
   * reads on the black island and on a light desktop, with a little white sign in it.
   */
  private drawBud(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, kind: BadgeKind, scale: number, t: number, thick: number) {
    if (scale <= 0.01) return;
    const color = BADGE_COLORS[kind];
    const small = kind === "online";
    const R = small ? 3.3 : 6.2;
    const bob = this.reducedMotion ? 0 : Math.sin(t * 2.3) * 0.7;
    ctx.save();
    ctx.translate(at.x, at.y + bob);
    ctx.scale(scale, scale);
    // Asking: a soft ring keeps rippling out, so it is noticed from the corner of an eye.
    if ((kind === "ask" || kind === "online") && !this.reducedMotion) {
      const q = (t % 1.4) / 1.4;
      ctx.globalAlpha = (1 - q) * (kind === "online" ? 0.35 : 0.6);
      ctx.beginPath();
      ctx.arc(0, 0, R + 1 + q * 6, 0, TAU);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Rim, body and a glint.
    ctx.beginPath();
    ctx.arc(0, 0, R + 1.4 * thick, 0, TAU);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fill();
    const g = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.35, color);
    g.addColorStop(1, color);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    if (small) {
      ctx.restore();
      return;
    }
    ctx.strokeStyle = "#FFFFFF";
    ctx.fillStyle = "#FFFFFF";
    ctx.lineWidth = 1.55 * Math.min(1.3, thick);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    switch (kind) {
      case "thinking":
        // Three dots, lit one after another.
        for (let i = 0; i < 3; i++) {
          const lit = this.reducedMotion ? 1 : 0.6 + 0.4 * Math.max(0, Math.sin(t * 5 - i * 0.9));
          ctx.globalAlpha = lit;
          ctx.beginPath();
          ctx.arc((i - 1) * 2.6, 0.2, 1.15, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        break;
      case "working": {
        // A little arc going round.
        const a = this.reducedMotion ? 0 : t * 5.5;
        ctx.beginPath();
        ctx.arc(0, 0, 2.9, a, a + Math.PI * 1.45);
        ctx.stroke();
        break;
      }
      case "ask":
        ctx.beginPath();
        ctx.moveTo(0, -3.1);
        ctx.lineTo(0, 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 2.9, 0.95, 0, TAU);
        ctx.fill();
        break;
      case "waiting":
        ctx.beginPath();
        ctx.arc(0, -1.3, 1.9, Math.PI * 1.05, Math.PI * 2.35);
        ctx.quadraticCurveTo(0, 0.2, 0, 0.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 3, 0.9, 0, TAU);
        ctx.fill();
        break;
      case "done":
        ctx.beginPath();
        ctx.moveTo(-2.7, 0.2);
        ctx.lineTo(-0.8, 2.1);
        ctx.lineTo(2.8, -1.9);
        ctx.stroke();
        break;
      case "error":
        ctx.beginPath();
        ctx.moveTo(-2.1, -2.1);
        ctx.lineTo(2.1, 2.1);
        ctx.moveTo(2.1, -2.1);
        ctx.lineTo(-2.1, 2.1);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  /** A stroke with a white rim under it. */
  private rimmed(ctx: CanvasRenderingContext2D, width: number, color: string) {
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = width + 2.2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private drawParticle(ctx: CanvasRenderingContext2D, p: Particle, thick: number) {
    const k = p.age / p.life;
    ctx.save();
    ctx.translate(p.x, p.y);
    switch (p.kind) {
      case "z": {
        const s = p.size * (0.7 + k * 0.8);
        ctx.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.6) / 0.4);
        ctx.beginPath();
        ctx.moveTo(-s / 2, -s / 2);
        ctx.lineTo(s / 2, -s / 2);
        ctx.lineTo(-s / 2, s / 2);
        ctx.lineTo(s / 2, s / 2);
        this.rimmed(ctx, 1.4 * thick, p.color);
        break;
      }
      case "spark": {
        const s = p.size * Math.sin(k * Math.PI);
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = p.color;
        star4(ctx, 0, 0, s, s * 0.32, p.rot);
        ctx.fill();
        break;
      }
      case "heart":
        ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
        ctx.rotate(Math.sin(p.rot + k * 4) * 0.2);
        heartPath(ctx, 0, 0, p.size * (0.8 + 0.3 * Math.sin(k * Math.PI)));
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.fillStyle = p.color;
        ctx.fill();
        break;
      case "puff":
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = p.color;
        ellipse(ctx, 0, 0, p.size * (1 + k * 1.4), p.size * (1 + k * 1.4));
        ctx.fill();
        break;
    }
    ctx.restore();
  }

  /** "!!" — surprised, or something needs you. */
  private bang(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, thick: number) {
    const pop = 1 + 0.1 * Math.max(0, Math.sin(t * 7));
    for (const [dx, tilt] of [[-2.6, -0.12], [2.6, 0.06]] as const) {
      ctx.save();
      ctx.translate(x + dx, y);
      ctx.rotate(tilt);
      ctx.scale(pop, pop);
      ctx.beginPath();
      ctx.moveTo(0, -5.2);
      ctx.lineTo(0, 0.6);
      this.rimmed(ctx, 2.1 * thick, MARK);
      ctx.beginPath();
      ctx.arc(0, 3.6, 1.15 * thick, 0, TAU);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.save();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = MARK;
      ctx.fill();
      ctx.restore();
    }
  }

  /** "?" — confused. */
  private question(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, thick: number) {
    ctx.save();
    ctx.translate(x, y + Math.sin(t * 3) * 1.1);
    ctx.rotate(0.12 * Math.sin(t * 1.7));
    ctx.beginPath();
    ctx.arc(0, -2.6, 2.9, Math.PI * 1.05, Math.PI * 2.3);
    ctx.quadraticCurveTo(0, 0.2, 0, 1.4);
    this.rimmed(ctx, 1.9 * thick, MARK);
    ctx.beginPath();
    ctx.arc(0, 4.6, 1.1 * thick, 0, TAU);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.stroke();
    ctx.fillStyle = MARK;
    ctx.fill();
    ctx.restore();
  }

  /** "• • •" — thinking, waiting. */
  private dots(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
    for (let i = 0; i < 3; i++) {
      const phase = (t * 2.2 - i * 0.22) % 1;
      const lift = phase < 0.4 ? Math.sin((phase / 0.4) * Math.PI) : 0;
      ctx.globalAlpha = 0.5 + 0.5 * lift;
      ellipse(ctx, x - 4.4 + i * 4.4, y - lift * 1.6, 1.5, 1.5);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** The cross-shaped anger mark. */
  private anger(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, thick: number) {
    const k = 1 + 0.14 * Math.max(0, Math.sin(t * 9));
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.beginPath();
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      ctx.moveTo(sx * 1.2, sy * 4.6);
      ctx.quadraticCurveTo(sx * 1.3, sy * 1.3, sx * 4.6, sy * 1.2);
    }
    this.rimmed(ctx, 1.7 * thick, "#E5484D");
    ctx.restore();
  }

  /** Little gold lines beside the head — a happy glow. */
  private rays(ctx: CanvasRenderingContext2D, t: number, thick: number) {
    const pulse = 0.75 + 0.25 * Math.sin(t * 6);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = -0.95 + i * 0.42;
        const cx = side * Math.cos(a) * 40;
        const cy = Math.sin(a) * 36 - 6;
        const len = (i === 1 ? 5.4 : 4.2) * pulse;
        const ux = side * Math.cos(a);
        const uy = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + ux * len, cy + uy * len);
        this.rimmed(ctx, 1.5 * thick, GOLD);
      }
    }
  }

  /** A little thought bubble with a tangle in it — tired, all worn out. */
  private scribble(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, thick: number) {
    const bob = Math.sin(t * 2) * 0.8;
    ctx.save();
    ctx.translate(x, y + bob);
    // The bubble, and its two little dots down toward the head.
    ellipse(ctx, 0, 0, 7.2, 6.4);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fill();
    ctx.lineWidth = 0.9 * thick;
    ctx.strokeStyle = "rgba(33,26,22,0.55)";
    ctx.stroke();
    for (const [dx, dy, r] of [[-5.6, 7.6, 1.5], [-8.2, 10.6, 0.9]] as const) {
      ellipse(ctx, dx, dy, r, r);
      ctx.fill();
      ctx.stroke();
    }
    // The tangle: a wobbly spiral that keeps turning.
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 5.2; a += 0.18) {
      const r = 0.5 + a * 0.27;
      const px = Math.cos(a + t * 2.4) * r * 1.1;
      const py = Math.sin(a + t * 2.4) * r * 0.85;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineWidth = 0.95 * thick;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  /** Little stars going round the head (dizzy). */
  private orbit(ctx: CanvasRenderingContext2D, t: number) {
    for (let i = 0; i < 3; i++) {
      const a = t * 4.2 + (i * TAU) / 3;
      const x = Math.cos(a) * 27;
      const y = -38 + Math.sin(a) * 6;
      const front = Math.sin(a) > 0;
      ctx.globalAlpha = front ? 1 : 0.55;
      ctx.fillStyle = GOLD;
      star4(ctx, x, y, front ? 5 : 3.8, front ? 1.9 : 1.4, t);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
