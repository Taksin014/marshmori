// The 3D Marshmori: soft ivory skin like a marshmallow, a big round mochi of a head with
// the face painted on its front, a two-leaf sprout, a small bean of a body with chunky
// little arms and legs, rebuilt every frame from the springs in rig.ts. The arms and
// the neck are soft tubes: they can stretch out very long, like dough.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ExtrudeGeometry,
  Group,
  LinearMipmapLinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  type Vector3,
} from "three";

import { SKIN, type ColorName } from "./expressions";
import {
  ARM_R,
  ARM_REST,
  HEAD_DROP,
  HEAD_SEAT,
  HIP_L,
  HIP_R,
  LEG_R,
  LEG_REST,
  NECK_R,
  Rig,
  SHOULDER_L,
  SHOULDER_R,
  TORSO_HEIGHT,
  v3,
  type Vec3,
} from "./rig";
import {
  faceGeometry,
  HEAD_BOTTOM,
  HEAD_DEPTH,
  HEAD_PEAK,
  HEAD_TOP,
  headGeometry,
  TORSO_DEPTH,
  torsoGeometry,
  torsoHeightAt,
  torsoRadiusAt,
} from "./shape";

/** Rough head radii (framing and hit tests): `y` is the dome above the widest line. */
export const HEAD_R = { x: 1, y: HEAD_TOP, z: HEAD_DEPTH, below: HEAD_BOTTOM };

/** How far down the head a feeling's colour runs (head space, 0 = the widest line, where the eyes are). */
const MOOD_BOTTOM = -0.34;
/** The softest the colour's edge gets (keeps the fade from ever being a hard line). */
const MOOD_EDGE = 0.08;

/** The hands are drawn this much bigger when only the head shows (hanging on to the island's edge). */
const HANG_HAND = 1.45;

/** The camera looks down at Marshmori this much (radians): a touch of the top of the head shows. */
export const VIEW_ELEVATION = 0.14;

/**
 * Head only, on screen (head units, y down from the head's centre): where the edge
 * Marshmori holds on to runs, and where its two hands sit on it.
 */
export const HANG_SCREEN = {
  lip: 0.45 * Math.cos(VIEW_ELEVATION) + 0.46 * Math.sin(VIEW_ELEVATION),
  handX: 0.46,
  handY: 0.5 * Math.cos(VIEW_ELEVATION) + 0.46 * Math.sin(VIEW_ELEVATION),
};

/**
 * The neck stretched out of the island (see roam/roamer.ts), in overlay pixels with
 * y down: the hands stay on the island's edge at `anchor`, the neck runs out through
 * `c1` and `c2`, and the head is at `head`.
 */
export interface ReachPose {
  /** The middle of the edge the hands hold on to. */
  anchor: { x: number; y: number };
  /** Pixels per head unit back at the island (the hands, the root of the neck). */
  anchorScale: number;
  /** The head's centre (its widest line). */
  head: { x: number; y: number };
  /** Pixels per head unit for the head out here. */
  headScale: number;
  /** Bend points of what is stretched out: the neck, or the reaching arm. */
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  /** Head roll (radians). */
  tilt: number;
  /** 0…1: the hands squeeze the edge (the neck is pulled far). */
  grip: number;
  /** One hand lets go of the edge and its arm stretches out instead of the neck. */
  paw?: {
    /** Which hand: -1 left, 1 right. */
    side: number;
    /** The hand's centre. */
    at: { x: number; y: number };
    /** Pixels per head unit for the hand out here (it grows as it goes). */
    scale: number;
  };
}

/** The hand that reaches out is drawn this much bigger than the ones on the edge. */
export const PAW_SIZE = 2.5;
/** Radius of a hand in head units (before HANG_HAND and PAW_SIZE). */
export const HAND_RADIUS = 0.13;

/** Radius in pixels of the reaching hand at `scale` pixels per head unit. */
export function pawRadius(scale: number): number {
  return HAND_RADIUS * HANG_HAND * PAW_SIZE * scale;
}

/** Where a hand holds the edge, in overlay pixels (for the arm's root). */
export function gripPoint(anchor: { x: number; y: number }, anchorScale: number, side: number): { x: number; y: number } {
  return { x: anchor.x + side * HANG_SCREEN.handX * anchorScale, y: anchor.y + (HANG_SCREEN.handY - HANG_SCREEN.lip) * anchorScale };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ── The neck's shape ───────────────────────────────────────────────────────────

/** Where the neck starts, inside the torso (body space, y up from the torso's centre). */
const NECK_BASE_Y = 0.2;
/** How far the neck's end goes up into the head, past its flat bottom. */
const NECK_INTO_HEAD = 0.12;
/** Where the neck comes out of the body: on its shoulders, this far from the middle… */
const NECK_EXIT_R = 0.3;
/** …at this height, where the shoulders slope this much (half-width per unit up). */
const NECK_EXIT_Y = torsoHeightAt(NECK_EXIT_R);
const NECK_EXIT_SLOPE = (torsoRadiusAt(NECK_EXIT_Y + 0.004) - torsoRadiusAt(NECK_EXIT_Y - 0.004)) / 0.008;
/** How tall the curve up from the shoulders is, and the round fillet into the head. */
const BODY_FILLET = 0.24;
const HEAD_FILLET = 0.16;
/**
 * The head's bottom curves up a little away from its middle: the fillet's flat lip sits
 * this far inside, so the head's surface covers it instead of a thin rim showing.
 */
const HEAD_FILLET_SINK = 0.03;

/**
 * The neck's thickness along its length `len` (from inside the torso to inside the
 * head), measured by distance `s` from its start. It leaves the shoulders along their
 * own slope, oval like the body, and curves up into a round neck; under the head it
 * spreads out in a quarter-round fillet that meets the flat bottom level, so neither
 * end shows a crease. A short neck gets proportionally smaller curves.
 */
export function neckShape(len: number) {
  const exitS = NECK_EXIT_Y - NECK_BASE_Y;
  const contactS = len - NECK_INTO_HEAD + HEAD_FILLET_SINK;
  const k = clamp((contactS - exitS) / (BODY_FILLET + HEAD_FILLET), 0, 1);
  const hb = Math.max(0.02, BODY_FILLET * k);
  const ht = Math.max(0.02, HEAD_FILLET * k);
  const r0 = NECK_EXIT_R - 0.004;
  return {
    /** Radius at `s`, where the plain neck is `mid` thick. */
    radius(s: number, mid: number): number {
      let r: number;
      if (s <= exitS) {
        // Inside the body: just under its surface.
        r = Math.max(mid, torsoRadiusAt(NECK_BASE_Y + s) - 0.004);
      } else if (s < exitS + hb) {
        // Up from the shoulders: a smooth curve from their slope to the neck's width.
        const x = (s - exitS) / hb;
        const x2 = x * x;
        const x3 = x2 * x;
        r = (2 * x3 - 3 * x2 + 1) * r0 + (x3 - 2 * x2 + x) * NECK_EXIT_SLOPE * hb + (-2 * x3 + 3 * x2) * mid;
      } else {
        r = mid;
      }
      // Into the head: a quarter round out to the flat bottom.
      const below = contactS - s;
      if (below < ht) {
        const p = Math.max(0, below);
        r = Math.max(r, mid + ht - Math.sqrt(Math.max(0, ht * ht - (ht - p) * (ht - p))));
      }
      return r;
    },
    /** How deep it is for its width: oval like the body where it comes out of it, round above. */
    depth(s: number): number {
      if (s <= exitS) return TORSO_DEPTH;
      const x = Math.min(1, (s - exitS) / hb);
      return TORSO_DEPTH + (1 - TORSO_DEPTH) * x * x * (3 - 2 * x);
    },
  };
}

// ── A tube that can be bent every frame without allocating ─────────────────────

/**
 * A soft tube (an arm, a leg, the neck, the stem) along a curve, closed at both ends
 * with round caps, so wherever an end shows it looks like a little rounded nub and
 * never like a cut sleeve.
 */
export class Tube {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly geom: BufferGeometry;
  private readonly rings: number;
  /** Per ring along the curve: centre, frame (t, n, b), radius, depth, distance from the start. */
  private readonly frames: Float32Array;
  /**
   * Where the rings go along the curve (0…1 in, 0…1 out). The default spaces them
   * evenly; a tube that flares at its ends packs more rings there.
   */
  spacing: (x: number) => number = (x) => x;

  constructor(material: Material, private readonly segs = 14, private readonly radial = 12, private readonly cap = 5) {
    const ring = radial + 1;
    this.rings = segs + 1 + cap * 2;
    const count = this.rings * ring;
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    this.frames = new Float32Array((segs + 1) * 15);
    const index: number[] = [];
    for (let i = 0; i < this.rings - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * ring + j;
        const b = (i + 1) * ring + j;
        // Counter-clockwise seen from outside (the ring turns from n toward t × n).
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.geom = new BufferGeometry();
    this.geom.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geom.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geom.setIndex(index);
    this.mesh = new Mesh(this.geom, material);
    this.mesh.frustumCulled = false;
  }

  /**
   * One ring of the tube from the stored frame `f` (centre, t along, n and b across,
   * radius, depth), rounded by `bend` (0 = side, ±π/2 = pole). `slope` is how fast the
   * radius changes along the tube: a flare's surface faces partly along it, and its
   * normals have to say so, or a tapering neck shades like a straight pipe and shows
   * a line where it meets the body.
   */
  private ring(index: number, f: number, bend: number, slope: number) {
    const F = this.frames;
    const o = f * 15;
    const cx = F[o];
    const cy = F[o + 1];
    const cz = F[o + 2];
    const tx = F[o + 3];
    const ty = F[o + 4];
    const tz = F[o + 5];
    const nx = F[o + 6];
    const ny = F[o + 7];
    const nz = F[o + 8];
    const bx = F[o + 9];
    const by = F[o + 10];
    const bz = F[o + 11];
    const r = F[o + 12];
    const depth = F[o + 13];
    const ringSize = this.radial + 1;
    const cb = Math.cos(bend);
    const sb = Math.sin(bend);
    // Along the tube by r·sin(bend), radius r·cos(bend): a hemisphere for the caps.
    const ox0 = cx + tx * r * sb;
    const oy0 = cy + ty * r * sb;
    const oz0 = cz + tz * r * sb;
    for (let j = 0; j <= this.radial; j++) {
      const ang = (j / this.radial) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // An ellipse when `depth` < 1 (squeezed along n), a circle otherwise.
      const dx = nx * ca * depth + bx * sa;
      const dy = ny * ca * depth + by * sa;
      const dz = nz * ca * depth + bz * sa;
      // The ellipse's own outward normal, then tilted along the tube by the slope.
      let mx = (nx * ca) / depth + bx * sa;
      let my = (ny * ca) / depth + by * sa;
      let mz = (nz * ca) / depth + bz * sa;
      const ml = Math.hypot(mx, my, mz) || 1;
      mx /= ml;
      my /= ml;
      mz /= ml;
      const lean = slope * (dx * mx + dy * my + dz * mz);
      let ex = mx * cb - tx * lean * cb + tx * sb;
      let ey = my * cb - ty * lean * cb + ty * sb;
      let ez = mz * cb - tz * lean * cb + tz * sb;
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el;
      ey /= el;
      ez /= el;
      const k = (index * ringSize + j) * 3;
      this.pos[k] = ox0 + dx * r * cb;
      this.pos[k + 1] = oy0 + dy * r * cb;
      this.pos[k + 2] = oz0 + dz * r * cb;
      this.nor[k] = ex;
      this.nor[k + 1] = ey;
      this.nor[k + 2] = ez;
    }
  }

  /**
   * Bends the tube along the cubic curve a → c1 → c2 → b, `radius(u)` thick at each
   * point (u from 0 at `a` to 1 at `b`), and `depth(u)` as deep as it is wide (an oval
   * where it has to sit in the oval body).
   */
  update(a: Vec3, c1: Vec3, c2: Vec3, b: Vec3, radius: (u: number) => number, depth?: (u: number) => number) {
    // First frame vector: anything not parallel to the curve.
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (Math.abs(tz) > 0.9) {
      nx = 1;
      nz = 0;
    }
    const F = this.frames;
    let s = 0;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (let i = 0; i <= this.segs; i++) {
      const u = this.spacing(i / this.segs);
      const iu = 1 - u;
      const w0 = iu * iu * iu;
      const w1 = 3 * iu * iu * u;
      const w2 = 3 * iu * u * u;
      const w3 = u * u * u;
      const px = w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x;
      const py = w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y;
      const pz = w0 * a.z + w1 * c1.z + w2 * c2.z + w3 * b.z;
      if (i > 0) s += Math.hypot(px - lx, py - ly, pz - lz);
      lx = px;
      ly = py;
      lz = pz;
      // Tangent of the curve (straight from a to b where the curve has none).
      let qx = 3 * iu * iu * (c1.x - a.x) + 6 * iu * u * (c2.x - c1.x) + 3 * u * u * (b.x - c2.x);
      let qy = 3 * iu * iu * (c1.y - a.y) + 6 * iu * u * (c2.y - c1.y) + 3 * u * u * (b.y - c2.y);
      let qz = 3 * iu * iu * (c1.z - a.z) + 6 * iu * u * (c2.z - c1.z) + 3 * u * u * (b.z - c2.z);
      const ql = Math.hypot(qx, qy, qz);
      if (ql > 1e-6) {
        qx /= ql;
        qy /= ql;
        qz /= ql;
        tx = qx;
        ty = qy;
        tz = qz;
      }
      // Parallel transport of the normal: keeps the rings from twisting.
      const d = nx * tx + ny * ty + nz * tz;
      nx -= tx * d;
      ny -= ty * d;
      nz -= tz * d;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const o = i * 15;
      F[o] = px;
      F[o + 1] = py;
      F[o + 2] = pz;
      F[o + 3] = tx;
      F[o + 4] = ty;
      F[o + 5] = tz;
      F[o + 6] = nx;
      F[o + 7] = ny;
      F[o + 8] = nz;
      F[o + 9] = ty * nz - tz * ny;
      F[o + 10] = tz * nx - tx * nz;
      F[o + 11] = tx * ny - ty * nx;
      F[o + 12] = radius(u);
      F[o + 13] = depth ? Math.max(0.3, depth(u)) : 1;
      F[o + 14] = s;
    }
    const cap = this.cap;
    const last = this.segs;
    for (let i = 0; i <= last; i++) {
      // How fast the radius changes along the tube, from the neighbouring rings.
      const p = Math.max(0, i - 1);
      const q = Math.min(last, i + 1);
      const ds = F[q * 15 + 14] - F[p * 15 + 14];
      const slope = ds > 1e-6 ? (F[q * 15 + 12] - F[p * 15 + 12]) / ds : 0;
      this.ring(cap + i, i, 0, Math.max(-6, Math.min(6, slope)));
    }
    // Round caps: from the pole to the first ring, and from the last ring to the pole.
    for (let k = 0; k < cap; k++) this.ring(k, 0, -((cap - k) / cap) * (Math.PI / 2), 0);
    for (let k = 0; k < cap; k++) this.ring(cap + last + 1 + k, last, ((k + 1) / cap) * (Math.PI / 2), 0);
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.normal.needsUpdate = true;
  }

  /** Along the quadratic curve a → (c) → b, from `rA` thick to `rB`. */
  quad(a: Vec3, c: Vec3, b: Vec3, rA: number, rB: number) {
    const c1 = v3(a.x + ((c.x - a.x) * 2) / 3, a.y + ((c.y - a.y) * 2) / 3, a.z + ((c.z - a.z) * 2) / 3);
    const c2 = v3(b.x + ((c.x - b.x) * 2) / 3, b.y + ((c.y - b.y) * 2) / 3, b.z + ((c.z - b.z) * 2) / 3);
    this.update(a, c1, c2, b, (u) => rA + (rB - rA) * u);
  }

  dispose() {
    this.geom.dispose();
  }
}

// ── Sprout and shadow ──────────────────────────────────────────────────────────

/** A plump, rounded seed leaf, cupped a little, lighter toward the tip. */
function leafGeometry(): BufferGeometry {
  // Plump little ovals with round tips, like two beans.
  const L = 0.5;
  const W = 0.16;
  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(L * 0.08, W * 1.22, L * 0.94, W * 1.26, L, 0.004);
  shape.bezierCurveTo(L * 0.94, -W * 1.26, L * 0.08, -W * 1.22, 0, 0);
  const g = new ExtrudeGeometry(shape, {
    depth: 0.022,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.024,
    bevelSegments: 4,
    curveSegments: 20,
    steps: 1,
  });
  g.translate(0, 0, -0.009);
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const base = new Color("#667540");
  const mid = new Color("#7F8E52");
  const tip = new Color("#9AA66E");
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const u = clamp(x / L, 0, 1);
    // Cup: edges and tip curl up toward +z; a soft crease down the middle.
    const crease = Math.exp(-(y * y) / 0.0006) * 0.012 * Math.sin(Math.PI * u);
    p.setZ(i, p.getZ(i) + 0.07 * u * u + 0.9 * y * y - crease);
    if (u < 0.45) c.copy(base).lerp(mid, u / 0.45);
    else c.copy(mid).lerp(tip, (u - 0.45) / 0.55);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function shadowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, "rgba(70,48,34,0.42)");
  g.addColorStop(0.45, "rgba(70,48,34,0.2)");
  g.addColorStop(1, "rgba(70,48,34,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export interface ModelControls {
  /** Seconds (the wave running along a stretched arm). */
  time: number;
  /** Body turn (radians, + turns Marshmori's face to the viewer's right). */
  yaw: number;
  /** Extra forward lean from the run and sideways roll from the curve. */
  lean: number;
  roll: number;
  /** Stretch along the travel. */
  stretch: number;
  /** Where the head looks (radians). */
  headYaw: number;
  headPitch: number;
  /** Expression motion of the head (world units / radians / scale). */
  head: { dx: number; dy: number; sx: number; sy: number; rot: number };
  /** Sprout: lean of the stem, spread of the leaves, spin (working), bloom (0…1). */
  sprout: { lean: number; left: number; right: number; spin: number | null; bloom: number };
  /** 0…1: washed-out colours (error). */
  tint: number;
  /**
   * The feeling's colour washed down the head from the top (MOOD_COLORS): `amount` at
   * the very top, `fill` 0…1 how far down it has run (it flows down as it comes).
   */
  mood: { color: Color; amount: number; fill: number };
  /** Head squish from a poke (1 = none). */
  squish: number;
}

export class MarshModel {
  readonly root = new Group();
  readonly pivot = new Group();
  readonly body = new Group();
  readonly headPivot = new Group();
  readonly headTurn = new Group();
  readonly headMotion = new Group();
  readonly head: Mesh;
  readonly face: Mesh;
  readonly faceTexture: CanvasTexture;
  readonly shadow: Mesh;

  private readonly skin: MeshPhysicalMaterial;
  /** The head's own skin: the same, plus the feeling's colour washed down from the top. */
  private readonly headSkin: MeshPhysicalMaterial;
  private readonly moodUniforms = {
    uMood: { value: new Color("#ffffff") },
    uMoodAmt: { value: 0 },
    uMoodTop: { value: HEAD_PEAK },
    uMoodBottom: { value: HEAD_PEAK - MOOD_EDGE },
  };
  private readonly faceMat: MeshPhysicalMaterial;
  private readonly torso: Mesh;
  private readonly neck: Tube;
  private readonly arms: [Tube, Tube];
  private readonly legs: [Tube, Tube];
  private readonly hands: [Mesh, Mesh];
  /** A little thumb on the hand that reaches out, so it reads as a mitten. */
  private readonly thumb: Mesh;
  private readonly feet: [Mesh, Mesh];
  readonly sprout = new Group();
  private readonly stem: Tube;
  private readonly leafPivot = new Group();
  private readonly leaves: [Group, Group];
  private readonly flower = new Group();
  private skinColor = new Color(SKIN.cream);
  private headOnly = false;
  /** A long, many-ringed neck for reaching across the screen (made on first use). */
  private reachNeck: Tube | null = null;
  private reachArm: Tube | null = null;
  /** With only the head showing: draw the two hands holding on (off for icons). */
  hangHands = true;

  constructor(faceCanvas: HTMLCanvasElement, maxAnisotropy = 4) {
    // Matte and soft, with a warm sheen at the edges, like light going into a marshmallow.
    this.skin = new MeshPhysicalMaterial({
      color: this.skinColor,
      roughness: 0.64,
      metalness: 0,
      sheen: 0.7,
      sheenRoughness: 0.55,
      sheenColor: new Color("#FFE6D6"),
    });

    // Head: a marshmallow bun, the face texture on a cap just above its surface.
    this.headSkin = this.skin.clone();
    const mood = this.moodUniforms;
    this.headSkin.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, mood);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vMoodY;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMoodY = position.y;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vMoodY;\nuniform vec3 uMood;\nuniform float uMoodAmt;\nuniform float uMoodTop;\nuniform float uMoodBottom;",
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\nfloat moodW = uMoodAmt * smoothstep(uMoodBottom, uMoodTop, vMoodY);\ndiffuseColor.rgb = mix(diffuseColor.rgb, uMood, moodW);",
        )
        // A little glow of its own, so the colour still reads on the head's shaded side.
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uMood * moodW * 0.14;");
    };
    this.headSkin.customProgramCacheKey = () => "marshmori-head-mood";
    this.head = new Mesh(headGeometry(), this.headSkin);
    this.head.position.set(0, HEAD_DROP, 0);

    this.faceTexture = new CanvasTexture(faceCanvas);
    this.faceTexture.colorSpace = SRGBColorSpace;
    this.faceTexture.anisotropy = maxAnisotropy;
    this.faceTexture.minFilter = LinearMipmapLinearFilter;
    // As soft as the skin around it: a glossy cap would flash a grey blob over an eye
    // whenever the head turns into the key light. The painted highlights do the shine.
    this.faceMat = new MeshPhysicalMaterial({
      map: this.faceTexture,
      transparent: true,
      roughness: 0.6,
      metalness: 0,
      sheen: 0.4,
      sheenRoughness: 0.55,
      sheenColor: new Color("#FFE6D6"),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.face = new Mesh(faceGeometry(), this.faceMat);
    this.face.renderOrder = 2;
    this.head.add(this.face);

    // Sprout: a short stem, two plump seed leaves, a flower that pops out when a job is done.
    const stemMat = new MeshPhysicalMaterial({ color: "#5F6F36", roughness: 0.6, sheen: 0.3, sheenColor: new Color("#E9F2D2") });
    this.stem = new Tube(stemMat, 8, 10);
    this.sprout.add(this.stem.mesh);
    const leafMat = new MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.6,
      sheen: 0.25,
      sheenRoughness: 0.6,
      sheenColor: new Color("#E3EACB"),
    });
    const leafGeom = leafGeometry();
    const makeLeaf = () => {
      const holder = new Group();
      const leaf = new Mesh(leafGeom, leafMat);
      // Cupped side up and a little toward the viewer.
      leaf.rotation.x = -0.55;
      holder.add(leaf);
      this.leafPivot.add(holder);
      return holder;
    };
    this.leaves = [makeLeaf(), makeLeaf()];
    const petalMat = new MeshPhysicalMaterial({ color: "#FFC6CF", roughness: 0.55, sheen: 0.6, sheenColor: new Color("#FFFFFF") });
    const petalGeom = new SphereGeometry(0.07, 16, 12);
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      const petal = new Mesh(petalGeom, petalMat);
      petal.scale.set(1.35, 0.42, 0.95);
      petal.position.set(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08);
      petal.rotation.y = -a;
      this.flower.add(petal);
    }
    const middle = new Mesh(new SphereGeometry(0.05, 16, 12), new MeshPhysicalMaterial({ color: "#F5CF62", roughness: 0.55 }));
    middle.position.y = 0.02;
    this.flower.add(middle);
    this.flower.scale.setScalar(0);
    this.leafPivot.add(this.flower);
    this.sprout.add(this.leafPivot);
    this.sprout.position.set(0, HEAD_DROP + HEAD_PEAK - 0.03, 0);

    // Head hierarchy: pivot at the chin → turn (look) → motion (expression bounce).
    this.headMotion.add(this.head, this.sprout);
    this.headTurn.add(this.headMotion);
    this.headPivot.add(this.headTurn);

    // Body: a small bean, chunky little limbs ending in round nubs.
    this.torso = new Mesh(torsoGeometry(), this.skin);
    // Plenty of rings, packed toward both ends where it flares into the body and the head.
    this.neck = new Tube(this.skin, 44, 32);
    this.neck.spacing = (x) => 0.4 * x + 0.6 * (0.5 - 0.5 * Math.cos(Math.PI * x));
    this.arms = [new Tube(this.skin, 30, 14), new Tube(this.skin, 30, 14)];
    this.legs = [new Tube(this.skin, 8, 16), new Tube(this.skin, 8, 16)];
    const handGeom = new SphereGeometry(0.13, 24, 18);
    this.hands = [new Mesh(handGeom, this.skin), new Mesh(handGeom, this.skin)];
    this.thumb = new Mesh(handGeom, this.skin);
    this.thumb.visible = false;
    const footGeom = new SphereGeometry(1, 24, 18);
    this.feet = [new Mesh(footGeom, this.skin), new Mesh(footGeom, this.skin)];
    this.body.add(this.torso, this.neck.mesh, ...this.arms.map((a) => a.mesh), ...this.legs.map((l) => l.mesh));
    this.body.add(...this.hands, this.thumb, ...this.feet, this.headPivot);
    this.pivot.add(this.body);
    this.pivot.rotation.order = "YXZ";

    this.shadow = new Mesh(
      new CircleGeometry(1, 40),
      new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.85 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.002;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow, this.pivot);
  }

  setColor(name: ColorName) {
    this.skinColor.set(SKIN[name] ?? SKIN.cream);
    this.skin.color.copy(this.skinColor);
    this.headSkin.color.copy(this.skinColor);
  }

  /**
   * Only the head and the two little hands (the island): Marshmori peeks out over an
   * edge and holds on to it, the rest of it out of sight.
   */
  setHeadOnly(on: boolean) {
    this.headOnly = on;
    for (const m of [this.torso, this.neck.mesh, ...this.arms.map((a) => a.mesh), ...this.legs.map((l) => l.mesh), ...this.feet, this.shadow]) {
      m.visible = !on;
    }
  }

  /** The head's origin (its widest line) at rest with the neck tucked in, in root space. */
  static headRest(): Vec3 {
    return v3(0, TORSO_HEIGHT + HEAD_SEAT + HEAD_DROP, 0);
  }

  /** Colour: a washed-out look for errors. */
  private applyTint(c: ModelControls) {
    if (c.tint > 0) {
      const grey = 0.3 * this.skinColor.r + 0.59 * this.skinColor.g + 0.11 * this.skinColor.b;
      this.skin.color.setRGB(
        this.skinColor.r + (grey - this.skinColor.r) * c.tint,
        this.skinColor.g + (grey - this.skinColor.g) * c.tint,
        this.skinColor.b + (grey - this.skinColor.b) * c.tint,
      );
    } else {
      this.skin.color.copy(this.skinColor);
    }
    this.headSkin.color.copy(this.skin.color);
    // The feeling's colour: from the top of the head down toward the cheeks.
    const m = this.moodUniforms;
    m.uMood.value.copy(c.mood.color);
    m.uMoodAmt.value = clamp(c.mood.amount, 0, 1);
    const fill = clamp(c.mood.fill, 0, 1);
    m.uMoodBottom.value = HEAD_PEAK - MOOD_EDGE - fill * (HEAD_PEAK - MOOD_EDGE - MOOD_BOTTOM);
  }

  update(rig: Rig, c: ModelControls) {
    this.applyTint(c);

    const grow = clamp(rig.grow.value, 0, 1);
    const squash = rig.squash.value * c.stretch;
    const bob = rig.bob.value;

    // Lean around the feet; yaw turns the whole body.
    this.pivot.rotation.set(rig.lean.value + c.lean, c.yaw, c.roll);
    this.body.position.set(0, TORSO_HEIGHT + bob, 0);
    const sq = Math.max(0.6, squash);
    this.body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    // Ground shadow: smaller and lighter as Marshmori leaves the ground.
    const lift = clamp(bob / 0.6, 0, 1);
    this.shadow.scale.setScalar((0.6 - 0.16 * lift) * Math.max(0.05, grow));
    (this.shadow.material as MeshBasicMaterial).opacity = (0.85 - 0.45 * lift) * grow;

    if (this.headOnly) {
      // Holding on to the edge under the face: bigger nubs, no arms to see.
      for (const [h, p] of [[this.hands[0], rig.lHand.value], [this.hands[1], rig.rHand.value]] as const) {
        h.visible = this.hangHands;
        h.position.set(p.x, p.y, p.z);
        h.scale.set(HANG_HAND, HANG_HAND * 0.94, HANG_HAND);
      }
    }
    const show = !this.headOnly && grow > 0.02;
    const g = (p: Vec3, at: Vec3) => v3(at.x + (p.x - at.x) * grow, at.y + (p.y - at.y) * grow, at.z + (p.z - at.z) * grow);

    if (show) {
      this.torso.visible = true;
      this.torso.scale.setScalar(0.6 + 0.4 * grow);
      /**
       * A soft limb from `from` to `to`. Pushed shorter, it bows out to the side; pulled
       * longer than `rest`, it stays nearly as thick and goes wavy, a stretched noodle.
       */
      const limb = (tube: Tube, from: Vec3, to: Vec3, rest: number, rA: number, rB: number, side: number, wavy: boolean) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;
        const d = Math.hypot(dx, dy, dz) || 0.001;
        const r = rest * grow;
        // Perpendicular in the picture plane (sideways if the limb points at the viewer).
        let px = dy;
        let py = -dx;
        const pl = Math.hypot(px, py);
        if (pl < 1e-4) {
          px = 1;
          py = 0;
        } else {
          px /= pl;
          py /= pl;
        }
        let c1: Vec3;
        let c2: Vec3;
        let thin: number;
        if (d <= r) {
          // How far a limb pushed shorter bows out. Like a rod, √(r² − d²), but eased in
          // where it is barely shorter: there the rod's curve shoots up from nothing, so
          // the breathing and the springs' small overshoots made arms and legs flicker
          // between straight and bent.
          const c = 1 - d / r;
          const bow = r * 0.55 * (Math.sqrt(c * (2 - c) + 0.0144) - 0.12) * side;
          const cx = (from.x + to.x) / 2 + px * bow;
          const cy = (from.y + to.y) / 2 + py * bow;
          const cz = (from.z + to.z) / 2;
          c1 = v3(from.x + ((cx - from.x) * 2) / 3, from.y + ((cy - from.y) * 2) / 3, from.z + ((cz - from.z) * 2) / 3);
          c2 = v3(to.x + ((cx - to.x) * 2) / 3, to.y + ((cy - to.y) * 2) / 3, to.z + ((cz - to.z) * 2) / 3);
          thin = Math.min(1.1, Math.sqrt(r / Math.max(r * 0.6, d)));
        } else {
          // A soft S that drifts along the noodle while it is stretched out; an arm keeps
          // nearly all of its thickness (it's dough, not elastic).
          const amp = wavy ? Math.min(0.45, (d - r) * 0.2) : 0;
          const w1 = -amp * (0.85 + 0.3 * Math.sin(c.time * 2.3 + side));
          const w2 = amp * (0.85 + 0.3 * Math.sin(c.time * 2.3 + side + 1.9));
          c1 = v3(from.x + dx / 3 + px * w1, from.y + dy / 3 + py * w1, from.z + dz / 3);
          c2 = v3(from.x + (dx * 2) / 3 + px * w2, from.y + (dy * 2) / 3 + py * w2, from.z + (dz * 2) / 3);
          thin = wavy ? Math.max(0.96, Math.sqrt(r / d)) : Math.max(0.8, Math.sqrt(r / d));
        }
        const k = grow * thin;
        tube.update(from, c1, c2, to, (u) => (rA + (rB - rA) * u) * k);
        tube.mesh.visible = true;
      };
      const lFoot = g(rig.lFoot.value, HIP_L);
      const rFoot = g(rig.rFoot.value, HIP_R);
      limb(this.legs[0], HIP_L, lFoot, LEG_REST, LEG_R, LEG_R * 0.96, 1, false);
      limb(this.legs[1], HIP_R, rFoot, LEG_REST, LEG_R, LEG_R * 0.96, -1, false);
      this.feet[0].position.set(lFoot.x, lFoot.y, lFoot.z + 0.035);
      this.feet[1].position.set(rFoot.x, rFoot.y, rFoot.z + 0.035);
      for (const f of this.feet) {
        f.visible = true;
        f.scale.set(0.165 * grow, 0.118 * grow, 0.185 * grow);
      }
      const lHand = g(rig.lHand.value, SHOULDER_L);
      const rHand = g(rig.rHand.value, SHOULDER_R);
      limb(this.arms[0], SHOULDER_L, lHand, ARM_REST, ARM_R * 1.08, ARM_R, -1, true);
      limb(this.arms[1], SHOULDER_R, rHand, ARM_REST, ARM_R * 1.08, ARM_R, 1, true);
      this.hands[0].position.set(lHand.x, lHand.y, lHand.z);
      this.hands[1].position.set(rHand.x, rHand.y, rHand.z);
      for (const h of this.hands) {
        h.visible = true;
        h.scale.set(grow, grow * 1.04, grow * 0.96);
      }
      const neck = rig.neck.value;
      if (neck > 0.03) {
        // From inside the torso up into the flat bottom of the head, like pulled dough:
        // it grows out of the body's shoulders along their own slope (no crease where
        // they meet) and spreads into the bottom of the head with a round fillet.
        // It leaves the body straight up and arrives square to the bottom of the head
        // (which tilts with headTilt), so both fillets sit evenly all the way round; a
        // sideways bend becomes a soft S in between.
        const tilt = rig.headTilt.value;
        const upX = -Math.sin(tilt);
        const upY = Math.cos(tilt);
        const chinX = rig.neckBend.value;
        const chinY = HEAD_SEAT + neck;
        const base = v3(0, NECK_BASE_Y, 0);
        const top = v3(chinX + upX * NECK_INTO_HEAD, chinY + upY * NECK_INTO_HEAD, 0);
        const len = Math.hypot(top.x - base.x, top.y - base.y);
        const reach = len / 3;
        const c1 = v3(base.x, base.y + reach, 0);
        const c2 = v3(top.x - upX * reach, top.y - upY * reach, 0);
        const pinch = Math.min(0.3, Math.max(0, neck - 0.4) * 0.16);
        const shape = neckShape(len);
        this.neck.update(
          base,
          c1,
          c2,
          top,
          (u) => shape.radius(u * len, NECK_R * (1 - pinch * Math.sin(Math.PI * u))),
          (u) => shape.depth(u * len),
        );
        this.neck.mesh.visible = true;
      } else {
        this.neck.mesh.visible = false;
      }
    } else {
      this.torso.visible = false;
      this.neck.mesh.visible = false;
      const parts = [...this.arms.map((a) => a.mesh), ...this.legs.map((l) => l.mesh), ...this.feet];
      if (!this.headOnly) parts.push(...this.hands);
      for (const m of parts) m.visible = false;
    }

    // Head: pivot at the chin, turn to look, then the expression's own motion.
    const chinY = HEAD_SEAT + Math.max(0, rig.neck.value);
    this.headPivot.position.set(rig.neckBend.value, chinY, 0);
    this.headPivot.scale.setScalar(1);
    this.headPivot.rotation.set(0, 0, rig.headTilt.value);
    this.headTurn.position.set(0, 0, 0);
    this.applyHead(c);
  }

  /**
   * Reaching out of the island: only the head and the hands, the neck stretched from
   * the island's edge to wherever the head went. Everything in overlay pixels.
   */
  updateReach(p: ReachPose, c: ModelControls) {
    this.applyTint(c);
    const paw = p.paw ?? null;
    if (!paw) this.thumb.visible = false;
    this.pivot.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.body.scale.set(1, 1, 1);
    for (const m of [this.torso, this.neck.mesh, ...this.arms.map((a) => a.mesh), ...this.legs.map((l) => l.mesh), ...this.feet, this.shadow]) {
      m.visible = false;
    }
    if (!this.reachNeck) {
      this.reachNeck = new Tube(this.skin, 48, 16, 6);
      this.body.add(this.reachNeck.mesh);
    }
    const a = p.anchorScale;
    const s = p.headScale;
    // Screen pixels (y down) to the scene (y up).
    const W = (x: number, y: number, z = 0) => v3(x, -y, z);

    // The hands keep hold of the edge; they squeeze a little when the neck is pulled far.
    // A hand that reaches out (paw) is drawn out there instead, big and round.
    const squeeze = 1 - 0.08 * p.grip;
    for (const [i, side] of [[0, -1], [1, 1]] as const) {
      const hand = this.hands[i];
      hand.visible = this.hangHands;
      if (paw && paw.side === side) {
        const k = HANG_HAND * PAW_SIZE * paw.scale;
        const at = W(paw.at.x, paw.at.y, 0.4 * paw.scale);
        hand.visible = true;
        hand.position.set(at.x, at.y, at.z);
        hand.scale.set(k, k * 0.96, k);
        // The thumb sits on the side, a little back from the way it reaches.
        const dx = paw.at.x - p.c2.x;
        const dy = paw.at.y - p.c2.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const r = HAND_RADIUS * k;
        const thumb = W(paw.at.x - ux * r * 0.3 + -uy * paw.side * r * 0.85, paw.at.y - uy * r * 0.3 + ux * paw.side * r * 0.85, 0.4 * paw.scale + r * 0.2);
        this.thumb.visible = true;
        this.thumb.position.set(thumb.x, thumb.y, thumb.z);
        this.thumb.scale.setScalar(k * 0.48);
        continue;
      }
      const shake = p.grip * 0.012 * a * Math.sin(c.time * 31 + i * 2);
      const at = W(p.anchor.x + side * (HANG_SCREEN.handX * a) + shake, p.anchor.y + (HANG_SCREEN.handY - HANG_SCREEN.lip) * a, 0.5 * a);
      hand.position.set(at.x, at.y, at.z);
      hand.scale.set(HANG_HAND * a * (2 - squeeze), HANG_HAND * a * 0.94 * squeeze, HANG_HAND * a);
    }

    // The head, wherever it went: turned a touch toward the camera so it looks just
    // like it does in the island (seen slightly from above).
    this.headPivot.position.set(p.head.x, -p.head.y, 0);
    this.headPivot.scale.setScalar(s);
    this.headPivot.rotation.set(VIEW_ELEVATION, 0, p.tilt);
    this.headTurn.position.set(0, -HEAD_DROP, 0);

    // The reaching arm: from where that hand held the edge to the hand out there, a soft
    // noodle like the neck but slimmer, a touch thicker at the wrist.
    if (paw) {
      if (!this.reachArm) {
        this.reachArm = new Tube(this.skin, 40, 12, 5);
        this.body.add(this.reachArm.mesh);
      }
      const root = gripPoint(p.anchor, a, paw.side);
      const from = W(root.x, root.y - 0.12 * a, 0.3 * a);
      const to = W(paw.at.x, paw.at.y, 0.4 * paw.scale);
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      const arm = this.reachArm;
      arm.mesh.visible = len > 0.5 * Math.max(a, paw.scale) * HAND_RADIUS * HANG_HAND * PAW_SIZE;
      if (arm.mesh.visible) {
        const r0 = 0.13 * a;
        const r1 = 0.2 * paw.scale;
        const pinch = clamp((len / paw.scale - 6) * 0.02, 0, 0.15);
        arm.update(from, W(p.c1.x, p.c1.y, 0.3 * a), W(p.c2.x, p.c2.y, 0.35 * paw.scale), to, (u) => (r0 + (r1 - r0) * u) * (1 - pinch * Math.sin(Math.PI * u)));
      }
    } else if (this.reachArm) {
      this.reachArm.mesh.visible = false;
    }

    // The neck: from inside the island (behind the hands) to just inside the head's
    // flat bottom, thinner where it's pulled long, flaring into the head like dough.
    const start = W(p.anchor.x, p.anchor.y - 0.22 * a, -0.05 * a);
    const chin = W(p.head.x, p.head.y + (HEAD_DROP - 0.14) * s * Math.cos(VIEW_ELEVATION), 0);
    const c1 = W(p.c1.x, p.c1.y, 0);
    const c2 = W(p.c2.x, p.c2.y, 0);
    const len = Math.hypot(chin.x - start.x, chin.y - start.y);
    const neck = this.reachNeck;
    if (paw || len < 0.35 * Math.max(a, s)) {
      neck.mesh.visible = false;
    } else {
      neck.mesh.visible = true;
      // A chunky noodle (like the Long Neck on the character sheet), a touch thinner
      // back at the island and in the middle when it's pulled very long.
      const r1 = 0.24 * s;
      const r0 = 0.24 * Math.max(a, 0.7 * s);
      const pinch = clamp((len / s - 5) * 0.025, 0, 0.18);
      neck.update(start, c1, c2, chin, (u) => {
        const fromTop = (1 - u) * len;
        const fromBase = u * len;
        return (
          (r0 + (r1 - r0) * u) * (1 - pinch * Math.sin(Math.PI * u)) +
          0.22 * s * Math.exp(-Math.max(0, fromTop - 0.1 * s) / (0.16 * s)) +
          0.06 * a * Math.exp(-fromBase / (0.25 * a))
        );
      });
    }
    this.applyHead(c);
  }

  /** Where the two leaves meet, in world space (Mamori's status bud sits just above). */
  sproutTip(out: Vector3): Vector3 {
    return this.leafPivot.getWorldPosition(out);
  }

  /** The head's own motion (look, expression bounce, poke squish) and the sprout. */
  private applyHead(c: ModelControls) {
    this.headTurn.rotation.order = "YXZ";
    this.headTurn.rotation.set(c.headPitch, c.headYaw, 0);
    const h = c.head;
    this.headMotion.position.set(h.dx, h.dy, 0);
    this.headMotion.rotation.set(0, 0, h.rot);
    this.headMotion.scale.set(h.sx * (2 - c.squish), h.sy * c.squish, h.sx * (2 - c.squish));

    // Sprout.
    const s = c.sprout;
    const L = 0.27;
    const tip = v3(Math.sin(s.lean) * L, Math.cos(s.lean) * L, 0);
    this.stem.quad(v3(0, -0.05, 0), v3(-Math.sin(s.lean) * L * 0.3, L * 0.5, 0), tip, 0.042, 0.032);
    this.leafPivot.position.set(tip.x, tip.y - 0.01, tip.z);
    if (s.spin !== null) {
      // Propeller: the two leaves spin round the stem.
      this.leafPivot.rotation.set(0, s.spin, -s.lean * 0.6);
      this.leaves[0].rotation.set(0, 0, 0.22);
      this.leaves[1].rotation.set(0, Math.PI, 0.22);
    } else {
      this.leafPivot.rotation.set(0, 0, 0);
      this.leaves[0].rotation.set(0, 0, s.right);
      this.leaves[1].rotation.set(0, Math.PI, s.left);
    }
    this.flower.scale.setScalar(s.bloom * 1.1);
    this.flower.position.set(0, 0.05, 0);
  }

  dispose() {
    this.neck.dispose();
    this.reachNeck?.dispose();
    this.reachArm?.dispose();
    for (const t of [...this.arms, ...this.legs]) t.dispose();
    this.stem.dispose();
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
      }
    });
    this.faceTexture.dispose();
    this.headSkin.dispose();
  }
}
