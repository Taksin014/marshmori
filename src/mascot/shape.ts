// Marshmori's shapes: the profile of the head (a big soft mochi: a round dome over a
// short, flat-bottomed base, wider than it is tall) and of the small bean of a body,
// turned into smooth meshes.
//
// Units: the head's widest radius is 1. The head's origin is on its widest line, which
// is also where the eyes sit.

import { BufferGeometry, Float32BufferAttribute } from "three";

/** Top of the head (a round dome, a touch fuller than a sphere): height and superellipse exponent. */
export const HEAD_TOP = 0.86;
const HEAD_TOP_N = 2.2;
/** Under the widest line: a short base with a flat bottom and soft, round corners. */
export const HEAD_BOTTOM = 0.65;
const HEAD_BOTTOM_N = 2.45;
/** Front-to-back depth of the head relative to its width. */
export const HEAD_DEPTH = 0.86;

/**
 * The face texture wraps the front of the head: ±FACE_LON radians round it, from
 * FACE_Y_TOP above the widest line to FACE_Y_BOTTOM below it (head units).
 */
export const FACE_LON = 1.0;
export const FACE_Y_TOP = 0.72;
export const FACE_Y_BOTTOM = 0.56;

/** Half the height of the torso (its centre is the body's origin, see rig.ts). */
export const TORSO_HALF = 0.47;
/** Front-to-back depth of the torso relative to its width. */
export const TORSO_DEPTH = 0.88;

/** A profile from the top pole (r = 0) down to the bottom pole (r = 0), by arc length. */
interface Profile {
  r: number[];
  y: number[];
  /** Outward normal in the (r, y) plane. */
  nr: number[];
  ny: number[];
  /** Arc length at each sample, 0…length. */
  s: number[];
  length: number;
}

function sampleProfile(f: (t: number) => [number, number], samples = 1200): Profile {
  const r: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  let len = 0;
  for (let i = 0; i <= samples; i++) {
    const [ri, yi] = f((i / samples) * Math.PI);
    if (i > 0) len += Math.hypot(ri - r[i - 1], yi - y[i - 1]);
    r.push(Math.max(0, ri));
    y.push(yi);
    s.push(len);
  }
  const nr: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(samples, i + 1);
    const tr = r[b] - r[a];
    const ty = y[b] - y[a];
    const l = Math.hypot(tr, ty) || 1;
    // Walking down the profile, outward is to the left of the tangent.
    nr.push(-ty / l);
    ny.push(tr / l);
  }
  // The poles point straight up and down.
  nr[0] = 0;
  ny[0] = 1;
  nr[samples] = 0;
  ny[samples] = -1;
  return { r, y, nr, ny, s, length: len };
}

/** Profile values at arc length `at` (linear between samples). */
function profileAt(p: Profile, at: number) {
  let lo = 0;
  let hi = p.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.s[mid] <= at) lo = mid;
    else hi = mid;
  }
  const span = p.s[hi] - p.s[lo] || 1;
  const k = Math.max(0, Math.min(1, (at - p.s[lo]) / span));
  const m = (a: number[]) => a[lo] + (a[hi] - a[lo]) * k;
  const nr = m(p.nr);
  const ny = m(p.ny);
  const l = Math.hypot(nr, ny) || 1;
  return { r: m(p.r), y: m(p.y), nr: nr / l, ny: ny / l };
}

/** Arc length where the profile first comes down to height `y`. */
function arcAtY(p: Profile, y: number): number {
  for (let i = 1; i < p.y.length; i++) {
    if (p.y[i] <= y) {
      const k = (p.y[i - 1] - y) / (p.y[i - 1] - p.y[i] || 1);
      return p.s[i - 1] + (p.s[i] - p.s[i - 1]) * k;
    }
  }
  return p.length;
}

function headCurve(t: number): [number, number] {
  const st = Math.sin(t);
  const ct = Math.cos(t);
  if (ct >= 0) {
    const e = 2 / HEAD_TOP_N;
    // A tiny peak where the sprout is planted.
    return [Math.pow(st, e), HEAD_TOP * Math.pow(ct, e) + 0.02 * Math.pow(ct, 40)];
  }
  const e = 2 / HEAD_BOTTOM_N;
  return [Math.pow(st, e), -HEAD_BOTTOM * Math.pow(-ct, e)];
}

/** A soft bean: fullest low down (the tummy), narrower at the shoulders, its top tucked into the head. */
function torsoCurve(t: number): [number, number] {
  const dy = Math.cos(t);
  const w = 0.42 - 0.08 * dy - 0.035 * dy * dy;
  // Blunt at the top (hidden in the head), rounder at the bottom between the legs.
  const e = dy > 0 ? 0.6 : 0.6 + 0.1 * -dy;
  return [Math.pow(Math.sin(t), e) * w, dy * TORSO_HALF];
}

const HEAD = sampleProfile(headCurve);
const TORSO = sampleProfile(torsoCurve);

/** Top of the head above its widest line (where the sprout is planted). */
export const HEAD_PEAK = HEAD.y[0];

/** Half-width of the head at height `y` (for placing things on its surface). */
export function headRadiusAt(y: number): number {
  return profileAt(HEAD, arcAtY(HEAD, y)).r;
}

/** Half-width of the torso's upper half at height `y` (body space: its centre is 0). */
export function torsoRadiusAt(y: number): number {
  return profileAt(TORSO, arcAtY(TORSO, y)).r;
}

/** Height of the torso's upper surface at half-width `r` (the shoulders, where the neck comes out). */
export function torsoHeightAt(r: number): number {
  for (let i = 1; i < TORSO.r.length; i++) {
    if (TORSO.r[i] >= r) {
      const k = (r - TORSO.r[i - 1]) / (TORSO.r[i] - TORSO.r[i - 1] || 1);
      return TORSO.y[i - 1] + (TORSO.y[i] - TORSO.y[i - 1]) * k;
    }
  }
  return 0;
}

interface LatheOptions {
  rows: number;
  cols: number;
  phiStart?: number;
  phiLength?: number;
  /** Only the band between these heights (both on the front of the profile). */
  yTop?: number;
  yBottom?: number;
  depth?: number;
  /** Pushes the surface out along its normal. */
  lift?: number;
}

/**
 * Turns a profile round the y axis (angles as three.js' SphereGeometry: φ = π/2 faces
 * +z). Rows are spaced evenly along the profile; normals come from the profile itself.
 * UVs: u across φ, v by height (1 at `yTop`), so a texture keeps true proportions.
 */
function lathe(p: Profile, o: LatheOptions): BufferGeometry {
  const phiStart = o.phiStart ?? 0;
  const phiLength = o.phiLength ?? Math.PI * 2;
  const depth = o.depth ?? 1;
  const lift = o.lift ?? 0;
  const s0 = o.yTop !== undefined ? arcAtY(p, o.yTop) : 0;
  const s1 = o.yBottom !== undefined ? arcAtY(p, o.yBottom) : p.length;
  const yTop = o.yTop ?? p.y[0];
  const yBottom = o.yBottom ?? p.y[p.y.length - 1];
  const closedTop = s0 <= 1e-9;
  const closedBottom = s1 >= p.length - 1e-9;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let iy = 0; iy <= o.rows; iy++) {
    const q = profileAt(p, s0 + ((s1 - s0) * iy) / o.rows);
    for (let ix = 0; ix <= o.cols; ix++) {
      const u = ix / o.cols;
      const phi = phiStart + u * phiLength;
      const cx = -Math.cos(phi);
      const cz = Math.sin(phi);
      let nx = cx * q.nr;
      let ny = q.ny;
      let nz = (cz * q.nr) / depth;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      pos.push(cx * q.r + nx * lift, q.y + ny * lift, cz * q.r * depth + nz * lift);
      nor.push(nx, ny, nz);
      uv.push(u, (q.y - yBottom) / (yTop - yBottom || 1));
    }
  }
  const ring = o.cols + 1;
  for (let iy = 0; iy < o.rows; iy++) {
    for (let ix = 0; ix < o.cols; ix++) {
      const a = iy * ring + ix + 1;
      const b = iy * ring + ix;
      const c = (iy + 1) * ring + ix;
      const d = (iy + 1) * ring + ix + 1;
      if (iy !== 0 || !closedTop) index.push(a, b, d);
      if (iy !== o.rows - 1 || !closedBottom) index.push(b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setIndex(index);
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return g;
}

export function headGeometry(): BufferGeometry {
  return lathe(HEAD, { rows: 64, cols: 72, depth: HEAD_DEPTH });
}

/** The front of the head, just above its surface, for the painted face. */
export function faceGeometry(): BufferGeometry {
  return lathe(HEAD, {
    rows: 44,
    cols: 48,
    phiStart: Math.PI / 2 - FACE_LON,
    phiLength: FACE_LON * 2,
    yTop: FACE_Y_TOP,
    yBottom: -FACE_Y_BOTTOM,
    depth: HEAD_DEPTH,
    lift: 0.004,
  });
}

export function torsoGeometry(): BufferGeometry {
  return lathe(TORSO, { rows: 56, cols: 56, depth: TORSO_DEPTH });
}
