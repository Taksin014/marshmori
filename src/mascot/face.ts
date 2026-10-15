// Marshmori's face, painted into a small transparent texture that wraps the front of
// the 3D head (see shape.ts and model.ts). Drawing on the head's own surface is what
// makes the eyes slide round it when Marshmori looks at something, like real eyes would.
//
// The look: two small, glossy black ovals with a soft glint, a little shallow smile
// level with the bottoms of the eyes, and soft peach cheeks just below and outside
// them — all on the head's widest line, low on the big round head.
//
// Coordinates are "face units" with (0, 0) on the middle of the face at the widest
// line: x is 1/31 of a radian round the head, y is 1/31 of a head unit down.

import type { BrowKind, EyeKind, Expression, MouthKind } from "./expressions";
import { FACE_LON, FACE_Y_BOTTOM, FACE_Y_TOP } from "./shape";

const UNIT = 1 / 31;

/** Warm near-black for the eyes and every line. */
const INK = "#211A16";
const BLUSH = "244,148,128";
const ANGRY_BLUSH = "240,108,98";
const TONGUE = "#F2899A";
const TAU = Math.PI * 2;

const EYE_X = 12.9;
const EYE_Y = -0.9;
const EYE_RX = 3.05;
const EYE_RY = 4.25;
const MOUTH_Y = 3.2;
const CHEEK_X = 18.2;
const CHEEK_Y = 4.6;
const CHEEK_R = 5.6;

export interface FaceState {
  expr: Expression;
  /** -1…1 each way: where the eyes point on the face. */
  gaze: [number, number];
  /** 1 = open, small = closing. */
  blink: number;
  /** Eyes a little bigger while the pointer is on Marshmori. */
  eyeScale: number;
  t: number;
  /** Lines get thicker when the head is small on screen. */
  thick: number;
  idle?: "smile" | "yawn" | null;
  /** Seconds since the face last changed. */
  sinceChange: number;
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
}

function star4(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, inner: number, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : inner;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.35);
  ctx.bezierCurveTo(x - s * 0.1, y + s * 0.25, x - s * 0.55, y + s * 0.05, x - s * 0.5, y - s * 0.22);
  ctx.bezierCurveTo(x - s * 0.45, y - s * 0.52, x - s * 0.05, y - s * 0.52, x, y - s * 0.22);
  ctx.bezierCurveTo(x + s * 0.05, y - s * 0.52, x + s * 0.45, y - s * 0.52, x + s * 0.5, y - s * 0.22);
  ctx.bezierCurveTo(x + s * 0.55, y + s * 0.05, x + s * 0.1, y + s * 0.25, x, y + s * 0.35);
  ctx.closePath();
}

export function dropPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.bezierCurveTo(x + s * 0.2, y - s * 0.4, x + s * 0.7, y + s * 0.1, x, y + s * 0.75);
  ctx.bezierCurveTo(x - s * 0.7, y + s * 0.1, x - s * 0.2, y - s * 0.4, x, y - s);
  ctx.closePath();
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class FacePainter {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly k: number;

  /** `pxPerUnit`: texture pixels per head unit (150 is plenty up to ~120 px heads). */
  constructor(pxPerUnit = 150) {
    this.k = pxPerUnit;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(2 * FACE_LON * pxPerUnit);
    this.canvas.height = Math.round((FACE_Y_TOP + FACE_Y_BOTTOM) * pxPerUnit);
    this.ctx = this.canvas.getContext("2d")!;
  }

  paint(s: FaceState) {
    const ctx = this.ctx;
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k * UNIT, 0, 0, k * UNIT, FACE_LON * k, FACE_Y_TOP * k);

    const ex = s.expr;
    const fx = s.gaze[0] * 2.6;
    const fy = s.gaze[1] * 2;
    const eyeY = EYE_Y + fy;
    const xL = -EYE_X + fx;
    const xR = EYE_X + fx;

    // Cheeks first, under everything: soft peach, no edge.
    const blush = s.idle === "smile" ? Math.max(ex.blush, 0.8) : ex.blush;
    if (blush > 0) {
      const rgb = ex.brows === "angry" ? ANGRY_BLUSH : BLUSH;
      for (const side of [-1, 1]) {
        const bx = side * CHEEK_X + fx * 0.75;
        const by = CHEEK_Y + fy * 0.6;
        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(1, 0.62);
        const g = ctx.createRadialGradient(0, 0, 0.2, 0, 0, CHEEK_R);
        g.addColorStop(0, `rgba(${rgb},${0.72 * blush})`);
        g.addColorStop(0.5, `rgba(${rgb},${0.46 * blush})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ellipse(ctx, 0, 0, CHEEK_R, CHEEK_R);
        ctx.fill();
        ctx.restore();
      }
    }

    let eyes = ex.eyes;
    if (s.idle === "smile") eyes = "happy";
    if (s.idle === "yawn") eyes = "closed";
    this.eyes(eyes, xL, xR, eyeY, s.blink, s.eyeScale, s.t, s.thick);
    if (ex.brows && ex.brows !== "none") this.brows(ex.brows, xL, xR, eyeY, s.thick);

    let mouth = ex.mouth;
    if (s.idle === "smile") mouth = "grin";
    if (s.idle === "yawn") mouth = "o";
    this.mouth(mouth, fx * 0.9, MOUTH_Y + fy * 0.8, s.t, s.thick, s.idle === "yawn");

    const effects = ex.effects ?? [];
    if (effects.includes("tear")) this.tear(xL, eyeY, s.t);
    if (effects.includes("sweat")) this.sweat(21, -10, s.t);
  }

  // ── Eyes ──────────────────────────────────────────────────────────────────

  private eyes(kind: EyeKind, xL: number, xR: number, y: number, blink: number, grow: number, t: number, thick: number) {
    const ctx = this.ctx;
    const RX = EYE_RX * grow;
    const RY = EYE_RY * grow;
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    /** The everyday eye: a small upright bean with a dot of light near the top. */
    const bean = (x: number, yy: number, sx = 1, sy = 1, b = blink) => {
      const rx = RX * sx;
      const ry = RY * sy * Math.max(0.12, b);
      ellipse(ctx, x, yy, rx, ry);
      ctx.fillStyle = INK;
      ctx.fill();
      if (b > 0.5) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ellipse(ctx, x - rx * 0.32, yy - ry * 0.42, rx * 0.3, ry * 0.26, -0.35);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ellipse(ctx, x + rx * 0.34, yy + ry * 0.5, rx * 0.16, rx * 0.16);
        ctx.fill();
      }
    };
    const arcUp = (x: number) => {
      ctx.lineWidth = 1.3 * thick;
      ctx.beginPath();
      ctx.arc(x, y + 2.2, 2.9, Math.PI * 1.16, Math.PI * 1.84);
      ctx.stroke();
    };
    const arcDown = (x: number) => {
      ctx.lineWidth = 1.25 * thick;
      ctx.beginPath();
      ctx.arc(x, y - 0.6, 3, Math.PI * 0.16, Math.PI * 0.84);
      ctx.stroke();
    };
    const lidded = (x: number, keep: number, slant: number) => {
      ctx.save();
      ctx.beginPath();
      const lidY = y + RY * (1 - 2 * keep);
      ctx.rect(x - RX - 2, lidY, RX * 2 + 4, RY * 3);
      ctx.clip();
      bean(x, y, 1, 1, 1);
      ctx.restore();
      // The lid: just as wide as the eye, a little heavy.
      ctx.lineWidth = 0.95 * thick;
      ctx.beginPath();
      ctx.moveTo(x - RX * 1.18, lidY + slant);
      ctx.quadraticCurveTo(x, lidY - 0.35, x + RX * 1.18, lidY - slant);
      ctx.stroke();
    };

    switch (kind) {
      case "round":
      case "up":
        bean(xL, y);
        bean(xR, y);
        break;
      case "wide":
        bean(xL, y, 1.14, 1.1);
        bean(xR, y, 1.14, 1.1);
        break;
      case "happy":
        arcUp(xL);
        arcUp(xR);
        break;
      case "closed":
        arcDown(xL);
        arcDown(xR);
        break;
      case "wink":
        arcUp(xL);
        bean(xR, y);
        break;
      case "focus":
        lidded(xL, 0.62, -0.5);
        lidded(xR, 0.62, 0.5);
        break;
      case "tired":
        lidded(xL, 0.5, 0.55);
        lidded(xR, 0.5, -0.55);
        break;
      case "squint": {
        // > < : scrunched up, poked.
        ctx.lineWidth = 1.4 * thick;
        ctx.beginPath();
        ctx.moveTo(xL - 2.4, y - 2.8);
        ctx.lineTo(xL + 2.2, y);
        ctx.lineTo(xL - 2.4, y + 2.8);
        ctx.moveTo(xR + 2.4, y - 2.8);
        ctx.lineTo(xR - 2.2, y);
        ctx.lineTo(xR + 2.4, y + 2.8);
        ctx.stroke();
        break;
      }
      case "star": {
        const kk = 1 + 0.12 * Math.sin(t * 8);
        for (const x of [xL, xR]) {
          ctx.fillStyle = INK;
          star4(ctx, x, y, 4.2 * kk, 1.5 * kk);
          ctx.fill();
          ctx.fillStyle = "#FFFFFF";
          ellipse(ctx, x - 0.6, y - 0.9, 0.7, 0.7);
          ctx.fill();
        }
        break;
      }
      case "heart": {
        const kk = 1 + 0.1 * Math.sin(t * 7);
        for (const x of [xL, xR]) {
          ctx.fillStyle = "#F4577D";
          heartPath(ctx, x, y + 0.6, 7.4 * kk);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ellipse(ctx, x - 1.4, y - 0.9, 0.85, 0.6, -0.5);
          ctx.fill();
        }
        break;
      }
      case "swirl": {
        ctx.lineWidth = 1.05 * thick;
        for (const [x, dir] of [[xL, 1], [xR, -1]] as const) {
          ctx.beginPath();
          for (let a = 0; a <= Math.PI * 3.4; a += 0.2) {
            const r = 0.3 * a;
            const ang = a * dir + t * 5 * dir;
            const px = x + Math.cos(ang) * r;
            const py = y + Math.sin(ang) * r * 1.2;
            if (a === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        break;
      }
      case "x":
        ctx.lineWidth = 1.4 * thick;
        for (const x of [xL, xR]) {
          ctx.beginPath();
          ctx.moveTo(x - 2.5, y - 2.5);
          ctx.lineTo(x + 2.5, y + 2.5);
          ctx.moveTo(x + 2.5, y - 2.5);
          ctx.lineTo(x - 2.5, y + 2.5);
          ctx.stroke();
        }
        break;
    }
  }

  private brows(kind: BrowKind, xL: number, xR: number, y: number, thick: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.15 * thick;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (kind === "angry") {
      ctx.moveTo(xL - 3.2, y - 7.4);
      ctx.lineTo(xL + 2.6, y - 5.2);
      ctx.moveTo(xR + 3.2, y - 7.4);
      ctx.lineTo(xR - 2.6, y - 5.2);
    } else if (kind === "worried") {
      ctx.moveTo(xL - 3, y - 5.3);
      ctx.lineTo(xL + 2.6, y - 7.3);
      ctx.moveTo(xR + 3, y - 5.3);
      ctx.lineTo(xR - 2.6, y - 7.3);
    }
    ctx.stroke();
  }

  // ── Mouth ─────────────────────────────────────────────────────────────────

  private mouth(kind: MouthKind, x: number, y: number, t: number, thick: number, yawning: boolean) {
    const ctx = this.ctx;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 1.1 * thick;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    switch (kind) {
      case "smile":
        ctx.beginPath();
        ctx.arc(x, y - 3.4, 4.3, Math.PI * 0.28, Math.PI * 0.72);
        ctx.stroke();
        break;
      case "small":
        ctx.beginPath();
        ctx.arc(x, y - 1.1, 1.6, Math.PI * 0.22, Math.PI * 0.78);
        ctx.stroke();
        break;
      case "smirk":
        ctx.beginPath();
        ctx.arc(x + 0.9, y - 1.4, 1.9, Math.PI * 0.15, Math.PI * 0.72);
        ctx.stroke();
        break;
      case "grin": {
        // A little open smile with a pink tongue.
        ctx.beginPath();
        ctx.moveTo(x - 2.9, y - 1.1);
        ctx.quadraticCurveTo(x, y + 4.4, x + 2.9, y - 1.1);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = TONGUE;
        ellipse(ctx, x, y + 2.3, 1.8, 1.3);
        ctx.fill();
        ctx.restore();
        break;
      }
      case "cat":
        ctx.lineWidth = 1 * thick;
        ctx.beginPath();
        ctx.arc(x - 1.3, y - 0.8, 1.3, Math.PI * 0.05, Math.PI * 0.95);
        ctx.moveTo(x + 2.6, y - 0.7);
        ctx.arc(x + 1.3, y - 0.8, 1.3, Math.PI * 0.05, Math.PI * 0.95);
        ctx.stroke();
        break;
      case "o": {
        const open = yawning ? 1.6 + Math.sin(clamp01((t % 1.6) / 1.6) * Math.PI) * 1.1 : 1;
        ellipse(ctx, x, y + 0.2, 1.4 * Math.min(1.4, open), 1.75 * open);
        ctx.fill();
        break;
      }
      case "open": {
        const chomp = 0.62 + 0.38 * Math.abs(Math.sin(t * 6));
        ctx.save();
        ellipse(ctx, x, y + 0.9, 3.3, 3.5 * chomp);
        ctx.fill();
        ctx.clip();
        ctx.fillStyle = TONGUE;
        ellipse(ctx, x, y + 0.9 + 3.5 * chomp, 2.4, 1.9);
        ctx.fill();
        ctx.restore();
        break;
      }
      case "tongue": {
        ctx.beginPath();
        ctx.arc(x, y - 1.5, 2, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();
        ctx.fillStyle = TONGUE;
        ellipse(ctx, x + 0.8, y + 0.4, 0.9, 1.15, -0.25);
        ctx.fill();
        break;
      }
      case "pout":
        ctx.beginPath();
        ctx.arc(x, y + 1.4, 1.6, Math.PI * 1.18, Math.PI * 1.82);
        ctx.stroke();
        break;
      case "flat":
        ctx.beginPath();
        ctx.moveTo(x - 1.8, y);
        ctx.lineTo(x + 1.8, y);
        ctx.stroke();
        break;
      case "frown":
        ctx.beginPath();
        ctx.arc(x, y + 2.2, 2.1, Math.PI * 1.22, Math.PI * 1.78);
        ctx.stroke();
        break;
      case "wavy":
        ctx.lineWidth = 1 * thick;
        ctx.beginPath();
        ctx.moveTo(x - 2.8, y + 0.2);
        ctx.lineTo(x - 1.4, y - 0.7);
        ctx.lineTo(x, y + 0.2);
        ctx.lineTo(x + 1.4, y - 0.7);
        ctx.lineTo(x + 2.8, y + 0.2);
        ctx.stroke();
        break;
    }
  }

  // ── On-face effects ───────────────────────────────────────────────────────

  private tear(xL: number, eyeY: number, t: number) {
    const ctx = this.ctx;
    const p = (t % 1.7) / 1.7;
    const y = eyeY + 3.8 + p * 11;
    ctx.globalAlpha = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2;
    ctx.fillStyle = "#86C6F2";
    dropPath(ctx, xL + 1.2, y, 1.9);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ellipse(ctx, xL + 0.8, y + 0.2, 0.4, 0.6);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private sweat(x: number, y: number, t: number) {
    const ctx = this.ctx;
    const p = (t % 1.9) / 1.9;
    ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
    ctx.fillStyle = "#8FCDF5";
    dropPath(ctx, x, y + p * 6, 2.3);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ellipse(ctx, x - 0.5, y + p * 6 + 0.3, 0.4, 0.65);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
