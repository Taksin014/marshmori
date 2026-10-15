// The island at the top of the screen. Mamori (Marshmori) lives here.
//
// Four sizes, moved between by springs so the black shape stretches and settles like
// the Dynamic Island:
//   tuck     a tiny lip when nothing is going on (if auto-hide is on)
//   peek     the notch with Mamori's face, when the pointer comes up to it
//   compact  a pill while agents work: Mamori, what's happening, the other sessions
//   open     a panel with a card: the current session, an approval, "done", a
//            problem, a file drop, the chat, or a task for an agent ("สั่งงาน",
//            ./tasks.ts: Mamori runs the agent in the background)
// Rust makes the rest of this transparent window click-through (hit rects below), and
// when something needs you while the pointer is far away, Mamori keeps hold of the
// island and stretches its neck all the way
// over to it (src/roam, src-tauri/src/roam.rs).

import "./island.css";

import { getCurrentWebview } from "@tauri-apps/api/webview";

import { api, errorText, on, type ChatMessage, type HitRect, type Point } from "../core/ipc";
import { fileSize, h, icon, timeAgo } from "../core/dom";
import { renderMarkdown } from "../core/markdown";
import { useLook } from "../core/look";
import { configureSound, sound } from "../core/sound";
import { feel, Motion, reducedMotion, useMotion, type Feel } from "../core/spring";
import {
  AGENT_COLORS,
  AGENT_SKINS,
  PROVIDER_LABELS,
  STATE_LABELS,
  type Answers,
  type ApprovalView,
  type ChatProviderSetting,
  type FileInfo,
  type HistoryItem,
  type IslandBounce,
  type ProviderStatus,
  type RoamKind,
  type RoamRequest,
  type Session,
  type Settings,
  type Task,
  type OpenRequest,
} from "../core/types";
import type { ColorName, ExpressionName } from "../mascot/expressions";
import { Marshmori } from "../mascot/marsh";
import { answerOf, answersOf, draftFor, keepDrafts, pick } from "./question";
import { createTasks, type Dropped } from "./tasks";

type Level = "tuck" | "peek" | "compact" | "open";
type View = "home" | "approval" | "notice" | "drop" | "file" | "chat" | "task";

const WINDOW_W = 720;
const WINDOW_H = 600;
const OPEN_W = 640;
const SEAT = 96;
const EAR = 14;
/** The pill and the notch: Mamori's head inside, both hands over the bottom edge. */
const PILL_H = 38;
const PEEK_W = 112;
const PEEK_H = 40;
/** Overlay pixels per head unit when Mamori is out at full size (roam/roamer.ts). */
const ROAM_UNIT = 30;

interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  files?: FileInfo[];
  pending?: boolean;
  error?: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const islandEl = $<HTMLDivElement>("island");
const compactEl = $<HTMLDivElement>("compact");
const openEl = $<HTMLDivElement>("open");
const seatEl = $<HTMLButtonElement>("seat");
const toastEl = $<HTMLDivElement>("toast");

const marsh = new Marshmori(seatEl, { mode: "head", quality: "high" });

const state = {
  sessions: [] as Session[],
  approvals: [] as ApprovalView[],
  settings: null as Settings | null,
  history: [] as HistoryItem[],
  level: "tuck" as Level,
  view: "home" as View,
  hover: false,
  /** The pointer is up at the top of the screen, near the island. */
  near: false,
  /** The pointer has just come to the island and is waiting out the delay: it leans in a little. */
  hint: false,
  /** Peeking out to say hello (at start). */
  hello: false,
  pinned: false,
  featured: null as string | null,
  notice: null as { kind: "done" | "error"; key: string; at: number } | null,
  lastActivity: Date.now(),
  lastCursorMove: 0,
  lastWink: 0,
  acked: new Set<number>(),
  seenApprovals: new Set<number>(),
  prevStates: new Map<string, string>(),
  drop: { active: false, files: [] as FileInfo[], paths: [] as string[] },
  /** The task pages are open ("สั่งงาน"). */
  task: { open: false },
  /** Task turns already announced ("<id>:<turns>"). */
  announced: new Set<string>(),
  /** The next chat/task page that opens takes the keyboard (you asked for it). */
  focusNext: false,
  /** The island had the keyboard when an approval card covered the chat/task page. */
  keyboardWasHere: false,
  chat: {
    open: false,
    provider: "auto" as ChatProviderSetting,
    providers: [] as ProviderStatus[],
    providersChecked: false,
    entries: [] as ChatEntry[],
    attachments: [] as FileInfo[],
    streamingId: null as string | null,
    streamingLabel: "",
    gotText: false,
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

function name(): string {
  return state.settings?.mascotName || "Mamori";
}

let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.style.transform = `translate(-50%, ${shape.s.h.goal + 16}px)`;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1900);
}

function dot(color: string, busy = false) {
  return h("span", { class: busy ? "dot busy" : "dot", style: { background: color } });
}

function busy(s: Session) {
  return s.state === "working" || s.state === "thinking";
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const PRIORITY: Record<Session["state"], number> = { approval: 6, error: 5, working: 4, thinking: 4, waiting: 3, done: 2, idle: 0 };

function weight(s: Session, now = Date.now()): number {
  const age = now - s.stateSince;
  if ((s.state === "error" || s.state === "done") && age > 60_000) return 1;
  return PRIORITY[s.state];
}

function ranked(): Session[] {
  const now = Date.now();
  return [...state.sessions].sort((a, b) => weight(b, now) - weight(a, now) || b.updatedAt - a.updatedAt);
}

function featured(): Session | null {
  const list = ranked();
  return list.find((s) => s.key === state.featured) ?? list[0] ?? null;
}

/** Sessions worth a place in the pill: doing something, or just finished. */
function live(): Session[] {
  const now = Date.now();
  return ranked().filter((s) => s.state !== "idle" || now - s.updatedAt < 120_000);
}

function exprFor(s: Session): ExpressionName {
  switch (s.state) {
    case "working":
      return "working";
    case "thinking":
      return "thinking";
    case "approval":
      return "ask";
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "sleepy";
  }
}

// ── Little Mamoris for the other sessions ───────────────────────────────────────

const avatars = new Map<string, string>();
const wanted = new Set<string>();
let avatarTimer = 0;
/**
 * Drawn once and kept: making these needs a WebGL context of its own, and doing that
 * in the middle of an animation is a visible hitch. (Bump the version when Mamori's
 * look changes.)
 */
const AVATAR_CACHE = "marshmori.avatars.v5";

try {
  // Drawn before Mamori's moods had colours: draw them again.
  for (const old of ["marshmori.avatars.v3", "marshmori.avatars.v4"]) localStorage.removeItem(old);
  const saved = JSON.parse(localStorage.getItem(AVATAR_CACHE) ?? "{}") as Record<string, string>;
  for (const [k, v] of Object.entries(saved)) if (typeof v === "string" && v.startsWith("data:image/")) avatars.set(k, v);
} catch {
  // Nothing saved yet (or storage is off): they get drawn when needed.
}

function avatar(color: ColorName, expr: ExpressionName): string | null {
  const key = `${color}|${expr}`;
  const url = avatars.get(key);
  if (url) return url;
  wanted.add(key);
  clearTimeout(avatarTimer);
  // When the page has a quiet moment, not in the middle of the island moving.
  avatarTimer = window.setTimeout(() => {
    const draw = () => {
      const list = [...wanted].map((k) => {
        const [c, e] = k.split("|");
        return { color: c as ColorName, expr: e as ExpressionName };
      });
      wanted.clear();
      if (!list.length) return;
      try {
        for (const [k, v] of Marshmori.avatars(list, 96)) avatars.set(k, v);
        localStorage.setItem(AVATAR_CACHE, JSON.stringify(Object.fromEntries(avatars)));
      } catch {
        // No WebGL (the dots stay), or no storage (drawn again next time).
      }
      render();
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(draw, { timeout: 1500 });
    else draw();
  }, 250);
  return null;
}

function miniImg(s: Session, size: number): HTMLElement {
  const url = avatar(AGENT_SKINS[s.agent], exprFor(s));
  return url
    ? h("img", { src: url, width: size, height: size, alt: "", draggable: "false" })
    : h("span", { class: "dot", style: { width: `${size * 0.4}px`, height: `${size * 0.4}px`, margin: `${size * 0.3}px`, background: AGENT_COLORS[s.agent] } });
}

// ── Level, view and shape ───────────────────────────────────────────────────────

/** Approval cards the island shows: all of them, or only Mamori's own tasks' when "ask at Mamori" is off. */
function shownApprovals(): ApprovalView[] {
  return state.settings?.approvals === false ? state.approvals.filter((a) => a.background) : state.approvals;
}

function desiredView(): View | null {
  if (state.drop.active) return "drop";
  if (state.drop.files.length) return "file";
  if (shownApprovals().length) return "approval";
  if (state.task.open) return "task";
  if (state.chat.open) return "chat";
  if (state.notice) return "notice";
  if (state.hover || state.pinned) return "home";
  return null;
}

/** Tasks Mamori is running that no session on screen stands for (no hooks reported yet). */
function loneTasks(): Task[] {
  return tasks.running().filter((t) => !t.sessionKey || !state.sessions.some((s) => s.key === t.sessionKey));
}

function desiredLevel(view: View | null): Level {
  if (view) return "open";
  if (live().length || loneTasks().length || state.settings?.autoHide === false) return "compact";
  if (state.near || state.hello) return "peek";
  return "tuck";
}

/** The biggest the island can get inside its window: room for the ears, and for its shadow below. */
const MAX_W = WINDOW_W - EAR * 2;
const MAX_H = WINDOW_H - 16;

/**
 * A bounce that would run out of the window is squeezed smoothly instead of being cut
 * off: a little overshoot passes as it is, a big one eases off before the edge.
 */
function within(v: number, goal: number, max: number): number {
  if (v <= goal) return v;
  const room = max - goal;
  return room > 0 ? goal + room * Math.tanh((v - goal) / room) : Math.min(v, Math.max(goal, max));
}

/** The island's size as drawn this frame. */
const shown = { w: 56, h: 5 };
/**
 * How far the open panel's contents (and Mamori in its card) ride down with the island
 * when it bounces past its height: half the overshoot, like the middle of a jelly, so
 * the bounce moves what's inside instead of leaving a gap under it.
 */
const SAG = 0.5;
let sag = 0;
/** The island is on its way up to a bigger height (a bounce past it is an overshoot). */
let rising = false;

const shape = new Motion({ w: 56, h: 5, r: 4 }, (v) => {
  shown.w = within(v.w, shape.s.w.goal, MAX_W);
  shown.h = within(v.h, shape.s.h.goal, MAX_H);
  islandEl.style.width = `${shown.w}px`;
  islandEl.style.height = `${shown.h}px`;
  islandEl.style.setProperty("--r", `${Math.max(0, v.r)}px`);
  // The open panel stays centred in the island while it stretches and wobbles, so it
  // unfolds from the middle and keeps even margins through the bounce.
  sag = seatCentred && rising ? Math.max(0, shown.h - shape.s.h.goal) * SAG : 0;
  openEl.style.translate = `${(shown.w - OPEN_W) / 2}px ${sag}px`;
  if (seatCentred) seat.redraw();
  reportRects();
});
// The soft shadow sits out the morph (see island.css): repainting it every frame is costly.
shape.onActive = (moving) => {
  if (moving) {
    islandEl.dataset.moving = "1";
  } else {
    delete islandEl.dataset.moving;
    if (enteringDue) openEl.classList.remove("entering");
  }
};

/**
 * Where Mamori's seat is measured from: the island's left edge (the notch and the pill,
 * where it holds on to the edge), or, while the island is open, the open panel, which
 * stays centred whatever the island's width is doing.
 */
let seatCentred = false;

/** The window x that the seat's x is measured from. */
function seatOrigin(): number {
  return seatCentred ? (WINDOW_W - OPEN_W) / 2 : (WINDOW_W - shown.w) / 2;
}

const seat = new Motion({ x: 14, y: -30, k: 28 / SEAT }, (v) => {
  const dx = seatCentred ? (shown.w - OPEN_W) / 2 : 0;
  seatEl.style.transform = `translate(${v.x + dx}px, ${v.y + (seatCentred ? sag : 0)}px) scale(${v.k})`;
  marsh.setDisplayScale(v.k);
});

let lastRects = "";
function reportRects() {
  // Generous while moving: the bigger of where it is and where it's going.
  const w = Math.max(shown.w, shape.s.w.goal);
  const ht = Math.max(shown.h, shape.s.h.goal);
  const ear = state.level === "tuck" ? 6 : EAR;
  // Tucked away it takes no clicks at all: whatever is at the top of the screen under
  // it (a tab, a title bar) stays clickable. The pointer coming up still shows it.
  const rects: HitRect[] = state.level === "tuck" ? [] : [{ x: (WINDOW_W - w) / 2 - ear, y: 0, w: w + ear * 2, h: ht }];
  // Mamori's chin and hands hang a little below the pill and the notch.
  if (state.level === "peek" || state.level === "compact") {
    const v = seat.targets();
    const g = marsh.restOnScreen();
    const r = g.r * v.k;
    const left = (WINDOW_W - shape.s.w.goal) / 2;
    const cx = left + v.x + g.x * v.k;
    rects.push({ x: cx - r * 1.3, y: ht - 2, w: r * 2.6, h: Math.max(0, v.y + g.lip * v.k + r * 0.42 - ht + 2) });
  }
  const key = rects.map((r) => `${Math.round(r.x / 2)}|${Math.round(r.y / 2)}|${Math.round(r.w / 2)}|${Math.round(r.h / 2)}`).join(",");
  if (key === lastRects) return;
  lastRects = key;
  void api.setHitRects(rects).catch(() => {});
}

/**
 * Where the seat goes so that Mamori's head is `width` wide, centred on `cx`, with the
 * edge it holds on to (the bottom of the pill, the notch, or its niche) at `lip`.
 */
function seatAt(cx: number, lip: number, width: number): { x: number; y: number; k: number } {
  const g = marsh.restOnScreen();
  const k = width / (2 * g.r);
  return { x: cx - g.x * k, y: lip - g.lip * k, k };
}

/** Position of `el` inside `root`, ignoring CSS transforms. */
function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * The pill's width: a little wider than the text in steps, and slow to shrink, so it
 * doesn't wobble every time an agent's activity line gets a few letters shorter.
 */
let pillW = 0;
let pillShrinkAt = 0;
let pillShrinkTimer = 0;
function pillWidth(content: number): number {
  const want = Math.max(160, Math.min(560, Math.ceil((content + 4) / 24) * 24));
  const now = performance.now();
  if (want >= pillW || pillW === 0) {
    pillW = want;
    pillShrinkAt = 0;
  } else if (!pillShrinkAt) {
    pillShrinkAt = now + 1400;
    clearTimeout(pillShrinkTimer);
    pillShrinkTimer = window.setTimeout(queueLayout, 1450);
  } else if (now >= pillShrinkAt) {
    pillW = want;
    pillShrinkAt = 0;
  }
  return pillW;
}

/**
 * How the island moves, step by step: soft and bouncy, like a marshmallow.
 *
 * While the pointer waits out the hover delay, the island starts to swell, slowly, as
 * if it were about to open by itself. Then it opens bit by bit: the width stretches
 * out first, the height drops a beat later, and both overshoot and wobble back
 * ("ดึ๋ง ๆ") before they settle, while Mamori glides over to its card and lands with a
 * bob. Peeking out and the pill pop the same way, smaller. Shrinking settles without
 * bouncing back. How much it bounces is a setting (ทั่วไป › การขยาย). A spring keeps its
 * speed when the target changes, so one step flows into the next.
 */
interface Step {
  w: Feel;
  h: Feel;
  seat: Feel;
}

/**
 * Bounce (damping ratio) of the width, the height and Mamori, per setting: lower
 * bounces more. Mamori itself stays calmer than the shape: it rides the island's bounce
 * in its card (SAG) and bobs when it lands, rather than flying past its seat.
 */
const ZETA: Record<IslandBounce, { open: [number, number, number]; pop: [number, number, number] }> = {
  soft: { open: [0.76, 0.68, 0.76], pop: [0.66, 0.62, 0.66] },
  boing: { open: [0.52, 0.42, 0.62], pop: [0.44, 0.4, 0.5] },
  extra: { open: [0.42, 0.3, 0.52], pop: [0.34, 0.3, 0.42] },
};

/** Opening: unhurried (about a third of a second to get most of the way), then the wobble. */
function opening(b: IslandBounce): Step {
  const [w, h, s] = ZETA[b].open;
  return { w: feel(62, w), h: feel(50, h, 0.1), seat: feel(64, s, 0.05) };
}

/** Peeking out and the pill: a quicker, smaller pop. */
function popping(b: IslandBounce): Step {
  const [w, h, s] = ZETA[b].pop;
  return { w: feel(118, w), h: feel(108, h, 0.03), seat: feel(120, s) };
}

const SHRINK: Step = {
  w: { stiffness: 175, damping: 22 },
  h: { stiffness: 175, damping: 22 },
  seat: { stiffness: 170, damping: 20 },
};
const RESIZE: Step = {
  w: { stiffness: 200, damping: 22 },
  h: { stiffness: 200, damping: 22 },
  seat: { stiffness: 190, damping: 21 },
};
/** The swell while the pointer waits: slow and smooth, so it reads as "about to open". */
const HINT: Step = { w: feel(40, 0.83), h: feel(40, 0.83), seat: feel(40, 0.8) };
/** Mamori out on the screen holds on to the island's edge: no wobble, so its hands keep up (roamer.ts). */
const CALM: Step = {
  w: { stiffness: 150, damping: 16 },
  h: { stiffness: 150, damping: 16 },
  seat: { stiffness: 140, damping: 14 },
};
/**
 * Windows' "Animation effects" off (prefers-reduced-motion): no bounce, swell or hop,
 * but no hard jumps either. The island glides to its new size in about a quarter of a
 * second and settles without overshooting, so a card coming up still reads as one
 * calm motion instead of a flash.
 */
const GENTLE: Step = { w: feel(280, 1), h: feel(280, 1), seat: feel(280, 1) };
/** How much wider and taller the island swells while the pointer waits. */
const SWELL_W = 24;
const SWELL_H = 6;

const RANK: Record<Level, number> = { tuck: 0, peek: 1, compact: 2, open: 3 };
let laidLevel: Level = "tuck";
let laidHint = false;
let enteringTimer = 0;
/** The panel's contents have risen in and can drop their layers once the island is still. */
let enteringDue = false;
let landTimer = 0;
/** The step in progress: a layout in the middle of it (content settling in) keeps its feel. */
let stepping: Step = RESIZE;

let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(layout);
}

function layout() {
  layoutQueued = false;
  const level = state.level;
  islandEl.dataset.level = level;
  compactEl.classList.toggle("on", level === "compact");
  openEl.classList.toggle("on", level === "open");
  const growing = RANK[level] > RANK[laidLevel];
  const shrinking = RANK[level] < RANK[laidLevel];
  const gentle = reducedMotion();
  const hint = state.hint && level !== "open" && !gentle;
  const hintChanged = hint !== laidHint;
  if (level === "open" && laidLevel !== "open") {
    // Its contents rise in one after another as it opens (island.css).
    openEl.classList.add("entering");
    enteringDue = false;
    clearTimeout(enteringTimer);
    enteringTimer = window.setTimeout(() => {
      // Their rise is over; wait for the island to stop wobbling, though (shape.onActive).
      enteringDue = true;
      if (!shape.moving) openEl.classList.remove("entering");
    }, 1000);
  }
  // Mamori out on the screen holds the island's edge with its hands: no wobble then.
  const calm = roam.away || roam.starting;
  if (growing && !gentle) {
    if (level === "open" && !calm) {
      // A little hop as it sets off, and a bob when it lands in its card.
      marsh.bump(0.8);
      clearTimeout(landTimer);
      landTimer = window.setTimeout(() => {
        if (state.level === "open") marsh.bump(1.7);
      }, 420);
    } else {
      marsh.bump(level === "open" ? 1.3 : 1.6);
    }
  }
  laidLevel = level;
  laidHint = hint;
  const bounce = state.settings?.islandBounce ?? "boing";
  const step: Step | null = gentle
    ? growing || shrinking
      ? GENTLE
      : null
    : growing
      ? calm
        ? CALM
        : level === "open"
          ? opening(bounce)
          : popping(bounce)
      : shrinking
        ? SHRINK
        : hintChanged
          ? HINT
          : null;
  // A layout in the middle of a step (the panel's content settling in, the pill's text
  // changing) carries on with that step's feel, so it doesn't stiffen the bounce; its
  // delays only hold back the start of a step.
  const now = step ?? (shape.moving ? stepping : gentle ? GENTLE : RESIZE);
  if (step) stepping = step;
  const motion = (f: Feel) => ({ stiffness: f.stiffness, damping: f.damping, delay: step ? f.delay : 0 });

  let w = 56;
  let ht = 5;
  let r = 4;
  // Tucked away: up behind the top of the screen.
  let seatTo = seatAt(w / 2, -8, 26);
  switch (level) {
    case "tuck":
      break;
    case "peek":
      w = PEEK_W;
      ht = PEEK_H;
      r = 20;
      seatTo = seatAt(PEEK_W / 2, PEEK_H - 1, 40);
      break;
    case "compact":
      w = pillWidth(compactEl.offsetWidth);
      ht = PILL_H;
      r = PILL_H / 2;
      seatTo = seatAt(26, PILL_H - 1, 36);
      break;
    case "open": {
      w = OPEN_W;
      ht = Math.ceil(openEl.scrollHeight);
      r = 30;
      const slot = openEl.querySelector<HTMLElement>(".slot");
      if (slot) {
        const o = offsetIn(slot, openEl);
        // A card's niche: leaning out over its lower lip. The chat's little one: just the face.
        seatTo = o.h >= 60 ? seatAt(o.x + o.w / 2, o.y + o.h - 4, o.w * 0.7) : seatAt(o.x + o.w / 2, o.y + o.h - 1, o.w * 0.92);
      }
      break;
    }
  }
  // Waiting out the hover delay: the island slowly starts to swell and Mamori leans
  // out, so you can see it coming (and it simply relaxes if you move on).
  if (hint) {
    if (level === "tuck") {
      w = 84;
      ht = 10;
      r = 7;
      seatTo = seatAt(w / 2, 3, 26);
    } else {
      w += SWELL_W;
      ht += SWELL_H;
      r = Math.min(r + 3, ht / 2);
      // In the notch Mamori stays in the middle; in the pill it holds the left end.
      seatTo = { ...seatTo, x: seatTo.x + (level === "peek" ? SWELL_W / 2 : 0), y: seatTo.y + 4 };
    }
  }
  // Open, Mamori's seat is measured from the centred panel instead of the island's edge:
  // carry its motion over to the other measure, so it doesn't jump.
  const centred = level === "open";
  if (centred !== seatCentred) {
    const dx = (shown.w - OPEN_W) / 2;
    seat.s.x.shift(centred ? -dx : dx);
    // Leaving mid-bounce: keep the bit it was riding down with the panel.
    if (!centred) seat.s.y.shift(sag);
    sag = 0;
    seatCentred = centred;
  }
  // A new step (or a resize once it has settled) says whether this is a climb; a layout
  // in the middle of a step keeps the answer, so the panel doesn't jump mid-bounce.
  if (step || !shape.moving) rising = ht > shown.h + 0.5;
  shape.to({ w }, motion(now.w));
  shape.to({ h: ht, r }, motion(now.h));
  seat.to(seatTo, motion(now.seat));
  marsh.setHover(state.hover && level === "open");

  // Out of sight: no need to keep drawing Mamori.
  if (level === "tuck" || roam.away) marsh.stop();
  else marsh.start();

  // Mamori's seat moves while its head is out on the screen: tell the overlay where the
  // edge it holds on to is going, right away, so its hands glide along with the island
  // (both springs move alike). Layout changes in the same moment fold into one message.
  if (roam.away || roam.starting) {
    clearTimeout(roam.nestTimer);
    roam.nestTimer = window.setTimeout(() => {
      const n = nest();
      void api.roamNest(n.nest, n.scale).catch(() => {});
    }, 16);
  }
}

new ResizeObserver(queueLayout).observe(openEl);
new ResizeObserver(queueLayout).observe(compactEl);

/**
 * Asks for a render on the next frame. Agents can send several events a second; they
 * all fold into one render, and the DOM is only touched when what it shows changed
 * (rebuilding a card under the pointer would eat clicks and make it flicker).
 */
let renderQueued = 0;
function render() {
  if (renderQueued) return;
  renderQueued = requestAnimationFrame(() => {
    renderQueued = 0;
    renderNow();
  });
}

let lastCompactHtml = "";
let lastOpenHtml = "";

/**
 * Puts `nodes` into `el` unless the very same markup is already there. A field you are
 * typing in (marked `data-keep`) keeps the keyboard and its caret when it is rebuilt.
 */
function patch(el: HTMLElement, nodes: Node[], last: string): string {
  const tmp = document.createElement("div");
  tmp.append(...nodes);
  const html = tmp.innerHTML;
  if (html !== last || el.childNodes.length === 0) {
    const active = document.activeElement;
    const keep = active instanceof HTMLInputElement && el.contains(active) ? active.dataset.keep : undefined;
    const caret = keep && active instanceof HTMLInputElement ? [active.selectionStart ?? 0, active.selectionEnd ?? 0] : null;
    el.replaceChildren(...tmp.childNodes);
    armTimers(el);
    const again = keep ? el.querySelector<HTMLInputElement>(`input[data-keep="${keep}"]`) : null;
    if (again) {
      again.focus({ preventScroll: true });
      if (caret) again.setSelectionRange(caret[0], caret[1]);
    }
  }
  return html;
}

/** Starts the approval countdown bars that were just put on screen. */
function armTimers(root: HTMLElement) {
  for (const bar of root.querySelectorAll<HTMLElement>(".timer i[data-expires]")) {
    if (bar.dataset.armed) continue;
    bar.dataset.armed = "1";
    const expires = Number(bar.dataset.expires);
    const created = Number(bar.dataset.created);
    const remaining = Math.max(0, expires - Date.now());
    const total = Math.max(1, expires - created);
    bar.style.transitionDuration = "0s";
    bar.style.width = `${(remaining / total) * 100}%`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bar.style.transitionDuration = `${remaining}ms`;
        bar.style.width = "0%";
      }),
    );
  }
}

function typingView(level: Level, view: View): View | null {
  // Typing your own answer to a question ("อื่น ๆ") needs the keyboard too.
  if (level === "open" && view === "approval") return frontQuestionTyping() ? "approval" : null;
  return level === "open" && (view === "chat" || view === "task") ? view : null;
}

/** The front card is a question and its "อื่น ๆ" box is open. */
function frontQuestionTyping(): boolean {
  const a = shownApprovals()[0];
  return !!a?.questions && draftFor(a).typing !== null;
}

/** The card on screen last time (id and question), so a new one can slide in softly. */
let lastCardKey = "";

/**
 * A new card taking the place of another while the panel is already open (the next
 * approval, the next question of a card) fades and rises in, instead of popping in
 * all at once. Opening the panel has its own entrance (island.css, "entering").
 */
function easeInNewCard(wasOpen: boolean) {
  const card = state.view === "approval" ? openEl.querySelector<HTMLElement>(".card[data-card]") : null;
  const key = card?.dataset.card ?? "";
  if (card && key !== lastCardKey && wasOpen && lastCardKey !== "" && !openEl.classList.contains("entering")) {
    const stepOnly = key.split(":")[0] === lastCardKey.split(":")[0];
    // With reduced motion it only fades.
    const still = reducedMotion();
    const from = still ? "none" : stepOnly ? "translateX(14px)" : "translateY(8px) scale(0.985)";
    for (const el of stepOnly ? card.querySelectorAll<HTMLElement>(".q-move") : [card]) {
      el.animate(
        [
          { opacity: 0, transform: from },
          { opacity: 1, transform: "none" },
        ],
        { duration: stepOnly ? 240 : 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }
  lastCardKey = key;
}

/** What took the keyboard at the last render (a question's draft changes under it, so it can't be worked out again). */
let lastTyping: View | null = null;

function renderNow() {
  const view = desiredView();
  const level = desiredLevel(view);
  const wasTyping = lastTyping;
  const wasOpen = state.level === "open";
  state.level = level;
  if (view) state.view = view;
  const typing = typingView(level, state.view);
  lastTyping = typing;

  lastCompactHtml = patch(compactEl, renderCompact(), lastCompactHtml);
  if (level === "open") {
    if (state.view === "chat" || state.view === "task") {
      const page = state.view === "chat" ? chat.root : tasks.root;
      if (openEl.firstElementChild !== page) {
        openEl.replaceChildren(page);
        lastOpenHtml = "";
      }
      if (state.view === "chat") chat.update();
      else tasks.update();
    } else {
      lastOpenHtml = patch(openEl, [renderHead(), renderBody()], lastOpenHtml);
    }
  }
  easeInNewCard(wasOpen && level === "open");
  if (typing !== wasTyping) {
    // A page you opened takes the keyboard. One that comes back by itself (an approval
    // card was in front of it) only does if the island had it when the card came.
    if (wasTyping && !typing) state.keyboardWasHere = document.hasFocus();
    const focus = typing !== null && (state.focusNext || state.keyboardWasHere || state.hover);
    state.focusNext = false;
    void api.setInteractive(typing !== null, focus).then(() => {
      if (!focus) return;
      if (typing === "chat") chat.focus();
      else if (typing === "task") tasks.focus();
      else if (typing === "approval") openEl.querySelector<HTMLInputElement>("input[data-keep]")?.focus({ preventScroll: true });
    });
  }
  if (level === "open" && state.view === "approval") ackApprovals();
  updateMood();
  queueLayout();
}

// ── Pill ────────────────────────────────────────────────────────────────────────

function renderCompact(): Node[] {
  const list = live();
  const top = list[0];
  const out: Node[] = [];
  const lone = loneTasks()[0];
  if (state.approvals.length) {
    const a = state.approvals[0];
    out.push(h("span", { class: "ticker" }, h("b", null, a.agentLabel), ` ${a.questions ? "ถามคุณ" : "ขออนุมัติ"} · ${a.project}`));
    out.push(h("span", { class: "count" }, String(state.approvals.length)));
    return out;
  }
  if (top) {
    // No tooltip: the pill opens into the panel right under the pointer anyway.
    out.push(h("span", { class: "ticker" }, h("b", null, top.project), ` · ${top.activity}`));
  } else if (lone) {
    out.push(h("span", { class: "ticker" }, h("b", null, lone.project), ` · ${lone.agentLabel}: ${lone.activity || "กำลังทำ…"}`));
  } else {
    out.push(h("span", { class: "ticker" }, h("b", null, name()), " · ว่างอยู่"));
  }
  const others = list.slice(1, 5);
  if (others.length) out.push(h("span", { class: "minis" }, ...others.map((s) => miniImg(s, 22))));
  return out;
}

// ── Open panel: header ──────────────────────────────────────────────────────────

function renderHead(): HTMLElement {
  const working = state.sessions.filter(busy).length;
  const asks = state.approvals.filter((a) => a.questions).length;
  const status = state.approvals.length
    ? [asks && `${asks} คำถามรอคุณตอบ`, state.approvals.length - asks && `${state.approvals.length - asks} คำขอรออนุมัติ`].filter(Boolean).join(" · ")
    : working
      ? `${working} กำลังทำงาน`
      : state.sessions.length
        ? `${state.sessions.length} session`
        : "";
  const soundOn = state.settings?.sound !== false;
  return h(
    "div",
    { class: "head" },
    h(
      "button",
      { class: `icon-btn ${state.view === "home" ? "on" : ""}`, title: "หน้าหลัก", "aria-label": "หน้าหลัก", onclick: () => goHome() },
      icon("home", 17),
    ),
    h("button", { class: "icon-btn", title: `แชทกับ ${name()}`, "aria-label": `แชทกับ ${name()}`, onclick: () => openChat() }, icon("chat", 17)),
    h("button", { class: "icon-btn", title: "แชทใหม่", "aria-label": "แชทใหม่", onclick: () => openChat(true) }, icon("new", 18)),
    h(
      "button",
      { class: "chip-btn task-btn", title: `ให้ ${name()} สั่ง agent ทำงานให้`, onclick: () => openTasks() },
      icon("task", 15),
      "สั่งงาน",
      tasks.running().length ? h("span", { class: "count" }, String(tasks.running().length)) : null,
    ),
    h("span", { class: "grow" }),
    status ? h("span", { class: "status" }, status) : null,
    h(
      "button",
      {
        class: "icon-btn",
        title: soundOn ? "ปิดเสียง" : "เปิดเสียง",
        "aria-label": soundOn ? "ปิดเสียง" : "เปิดเสียง",
        onclick: () => {
          if (!state.settings) return;
          const next = { ...state.settings, sound: !soundOn };
          applySettings(next);
          void api.saveSettings(next).catch(() => {});
          render();
        },
      },
      icon(soundOn ? "speaker" : "mute", 17),
    ),
    h("button", { class: "icon-btn", title: "ตั้งค่า", "aria-label": "ตั้งค่า", onclick: () => void api.openSettings() }, icon("settings", 17)),
  );
}

function renderBody(): HTMLElement {
  switch (state.view) {
    case "approval": {
      const a = shownApprovals()[0];
      return h("div", { class: "body" }, a.questions ? renderQuestion(a) : renderApproval(a), renderSide());
    }
    case "notice":
      return h("div", { class: "body" }, renderNotice(), renderSide());
    case "drop":
      return h("div", { class: "body" }, renderDrop());
    case "file":
      return h("div", { class: "body" }, renderFiles());
    default:
      return h("div", { class: "body" }, renderHome(), renderSide());
  }
}

function slot(): HTMLElement {
  return h("div", { class: "slot", "aria-hidden": "true" });
}

function metaLine(color: string, title: string, sub: string, pulse = false): HTMLElement {
  return h("div", { class: "meta" }, dot(color, pulse), h("b", { title }, title), h("span", { class: "sub" }, sub));
}

// ── Cards ───────────────────────────────────────────────────────────────────────

const STEP_ICONS: Record<HistoryItem["kind"], string> = {
  prompt: "user",
  tool: "terminal",
  approval: "alert",
  done: "check",
  error: "alert",
  info: "spark",
};

function stepsFor(s: Session): HTMLElement | null {
  const items = state.history.filter((x) => x.agent === s.agent && x.project === s.project).slice(0, 3);
  if (!items.length) return null;
  return h(
    "div",
    { class: "steps" },
    ...items.map((x) => h("div", null, icon(STEP_ICONS[x.kind] ?? "spark", 14), h("span", { title: x.text }, x.text))),
  );
}

function renderHome(): HTMLElement {
  const s = featured();
  if (!s) {
    return h(
      "div",
      { class: "card" },
      slot(),
      h("div", { class: "headline" }, "ยังไม่มี agent ทำงานอยู่"),
      h("div", { class: "text" }, `เปิด Claude Code, Codex หรือ Antigravity แล้ว ${name()} จะคอยบอกว่าแต่ละตัวทำอะไรอยู่ หรือจะสั่งงานผ่าน ${name()} เลยก็ได้`),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => openTasks() }, icon("task", 15), "สั่งงาน"),
        h("button", { class: "btn", onclick: () => void api.demo() }, icon("play", 14), "ดูตัวอย่าง"),
        h("button", { class: "btn", onclick: () => void api.openSettings("agents") }, "เชื่อมต่อ agent"),
      ),
    );
  }
  const since = busy(s) || s.state === "approval" ? ` · ${timeAgo(s.stateSince)}` : "";
  const kind = s.state === "done" ? "done" : s.state === "error" ? "error" : s.state === "approval" ? "ask" : "";
  const finished = s.state === "done" || s.state === "error" || s.state === "idle";
  const task = taskOf(s);
  const byMamori = task ? ` · ${name()} สั่ง` : "";
  return h(
    "div",
    { class: `card ${kind}` },
    slot(),
    metaLine(AGENT_COLORS[s.agent], s.project, `${s.agentLabel}${byMamori} · ${STATE_LABELS[s.state]}${since}`, busy(s)),
    h("div", { class: "headline", title: s.detail ?? s.activity }, s.activity),
    stepsFor(s),
    s.allowAll
      ? h(
          "div",
          { class: "round-chip", title: "ทุกอย่างที่ขอในรอบนี้ผ่านอัตโนมัติ สั่งงานครั้งถัดไปจะกลับมาถามตามปกติ" },
          icon("check", 13),
          h("span", null, "อนุญาตทั้งรอบนี้"),
          h(
            "button",
            {
              class: "link",
              onclick: () => {
                void api.allowAllOff(s.key).catch(() => {});
                toast("กลับมาถามทุกครั้งแล้ว");
              },
            },
            "ยกเลิก",
          ),
        )
      : null,
    task && !finished
      ? h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => openTasks(task.id) }, icon("task", 15), "ดูงานนี้"))
      : null,
    finished
      ? h(
          "div",
          { class: "actions" },
          task ? h("button", { class: "btn primary", onclick: () => openTasks(task.id) }, icon("task", 15), "ดูผลลัพธ์") : null,
          h("button", { class: "btn", onclick: () => void api.openFolder(s.cwd).catch((e) => toast(errorText(e))) }, icon("folder", 15), "เปิดโฟลเดอร์"),
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                void api.dismissSession(s.key);
                state.featured = null;
              },
            },
            "เอาออก",
          ),
        )
      : null,
  );
}

/** A plan waiting for your OK (Claude Code's ExitPlanMode). */
function isPlan(a: ApprovalView): boolean {
  return a.tool === "ExitPlanMode";
}

function renderDetail(a: ApprovalView): HTMLElement | null {
  const text = a.detail ?? a.target;
  if (!text) return null;
  // A plan gets a taller box you can scroll through; a command or a diff its first lines.
  const plan = isPlan(a);
  const pre = h("div", { class: plan ? "cmd plan" : "cmd" });
  for (const line of text.split("\n").slice(0, plan ? 40 : 5)) {
    const cls = a.toolKind === "edit" ? (line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "") : "";
    pre.append(cls ? h("span", { class: cls }, line) : line, "\n");
  }
  return pre;
}

function renderApproval(a: ApprovalView): HTMLElement {
  // The countdown starts once the bar is on screen (armTimers).
  const bar = h("i", { "data-created": String(a.createdAt), "data-expires": String(a.expiresAt) });
  const keys = state.settings?.shortcuts ?? true;
  const more = state.approvals.length > 1 ? ` · 1/${state.approvals.length}` : "";
  const elsewhere = a.background ? null : a.elsewhere ?? (a.agent === "antigravity" ? "ให้ Antigravity ถามเอง" : "ตอบใน terminal แทน");
  const plan = isPlan(a);
  return h(
    "div",
    { class: "card ask", "data-card": String(a.id) },
    slot(),
    metaLine(AGENT_COLORS[a.agent], a.project, `${a.agentLabel}${a.background ? ` (งานที่ ${name()} สั่ง)` : ""} ขออนุมัติ${more}`),
    h("div", { class: "headline" }, plan ? "วางแผนเสร็จแล้ว — เริ่มทำตามแผนนี้เลยไหม?" : a.toolKind === "command" && a.target ? "ขอรันคำสั่งนี้" : a.title),
    renderDetail(a),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", onclick: () => decide(a, "deny") }, plan ? "ยังไม่เริ่ม" : "ไม่อนุญาต", keys ? h("kbd", null, "N") : null),
      h("button", { class: "btn", onclick: () => decide(a, "always"), title: a.alwaysLabel }, "อนุญาตทั้งรอบนี้"),
      h("button", { class: "btn primary", onclick: () => decide(a, "allow") }, plan ? "เริ่มตามแผน" : "อนุญาต", keys ? h("kbd", null, "Y") : null),
      elsewhere ? h("button", { class: "link", onclick: () => decide(a, "terminal") }, elsewhere) : null,
    ),
    h("div", { class: "timer" }, bar),
  );
}

/**
 * A question from the agent, laid out the way Claude Code asks it: the question, its
 * choices numbered 1, 2, 3 (each with what it means underneath), and "อื่น ๆ" for your
 * own words. A single choice is sent (or moves on to the next question) the moment you
 * pick it; several choices wait for "ถัดไป" / "ส่งคำตอบ".
 */
function renderQuestion(a: ApprovalView): HTMLElement {
  const qs = a.questions!;
  const d = draftFor(a);
  const step = Math.min(d.step, qs.length - 1);
  const q = qs[step];
  const last = step === qs.length - 1;
  const bar = h("i", { "data-created": String(a.createdAt), "data-expires": String(a.expiresAt) });
  const more = state.approvals.length > 1 ? ` · 1/${state.approvals.length}` : "";
  const progress = qs.length > 1 ? ` · ข้อ ${step + 1}/${qs.length}` : "";
  const typing = d.typing === step;
  const own = d.other[step] ?? "";
  const options = q.options.map((o, i) => {
    const on = d.picked[step].includes(o.label);
    return h(
      "button",
      {
        class: `q-opt${on ? " on" : ""}`,
        role: q.multiSelect ? "checkbox" : "radio",
        "aria-checked": on ? "true" : "false",
        title: o.description || o.label,
        onclick: () => choose(a, o.label),
      },
      h("span", { class: "q-num" }, q.multiSelect && on ? icon("check", 13) : String(i + 1)),
      h("span", { class: "q-label" }, h("b", null, o.label), o.description ? h("small", null, o.description) : null),
    );
  });
  const ownRow = typing
    ? h(
        "label",
        { class: "q-opt q-own q-typing" },
        h("span", { class: "q-num" }, icon("edit", 13)),
        h("input", {
          type: "text",
          class: "q-input",
          "data-keep": `q-${a.id}-${step}`,
          value: own,
          maxlength: "500",
          placeholder: q.multiSelect ? "พิมพ์เพิ่มเติม แล้วกด Enter" : "พิมพ์คำตอบของคุณ แล้วกด Enter",
          "aria-label": "คำตอบของคุณ",
          oninput: (e: Event) => {
            d.other[step] = (e.target as HTMLInputElement).value;
            const send = openEl.querySelector<HTMLButtonElement>(".q-actions .primary");
            if (send) send.disabled = !answerOf(q, d, step);
          },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              next(a);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              d.typing = null;
              render();
            }
          },
        }),
      )
    : h(
        "button",
        { class: `q-opt q-own${own.trim() && (q.multiSelect || !d.picked[step].length) ? " on" : ""}`, onclick: () => typeOwn(a) },
        h("span", { class: "q-num" }, String(q.options.length + 1)),
        h(
          "span",
          { class: "q-label" },
          h("b", null, own.trim() || "อื่น ๆ"),
          h("small", null, own.trim() ? "คำตอบที่พิมพ์เอง · กดเพื่อแก้" : "พิมพ์คำตอบเอง"),
        ),
      );
  // A single choice goes the moment you pick it; the button is for several, or your own words.
  const button = q.multiSelect || typing;
  return h(
    "div",
    { class: "card ask question", "data-card": `${a.id}:${step}` },
    slot(),
    metaLine(AGENT_COLORS[a.agent], a.project, `${a.agentLabel}${a.background ? ` (งานที่ ${name()} สั่ง)` : ""} ถามคุณ${progress}${more}`),
    h(
      "div",
      { class: "q-move q-ask" },
      q.header || q.multiSelect
        ? h("div", { class: "q-tags" }, q.header ? h("span", { class: "q-chip" }, q.header) : null, q.multiSelect ? h("span", { class: "q-hint" }, "เลือกได้หลายข้อ") : null)
        : null,
      h("div", { class: "q-text" }, q.question),
    ),
    h("div", { class: "q-move q-opts", role: q.multiSelect ? "group" : "radiogroup", "aria-label": q.question }, ...options, ownRow),
    h(
      "div",
      { class: "actions q-actions" },
      step > 0 ? h("button", { class: "btn", onclick: () => back(a) }, icon("back", 15), "ย้อนกลับ") : null,
      button ? h("button", { class: "btn primary", disabled: !answerOf(q, d, step), onclick: () => next(a) }, last ? "ส่งคำตอบ" : "ถัดไป") : null,
      h(
        "span",
        { class: "q-links" },
        a.elsewhere ? h("button", { class: "link", onclick: () => decide(a, "terminal") }, a.elsewhere) : null,
        h("button", { class: "link", title: `ให้ ${a.agentLabel} ตัดสินใจเองแล้วทำงานต่อ`, onclick: () => decide(a, "deny") }, "ข้ามคำถามนี้"),
      ),
    ),
    h("div", { class: "timer" }, bar),
  );
}

function renderNotice(): HTMLElement {
  const n = state.notice!;
  const s = state.sessions.find((x) => x.key === n.key);
  const done = n.kind === "done";
  const close = () => {
    state.notice = null;
    render();
  };
  // A task Mamori ran (with or without a session from its hooks).
  const task = n.key.startsWith("task:") ? tasks.byId(n.key.slice(5)) : s ? taskOf(s) : null;
  if (task && !s) {
    const turn = task.turns[task.turns.length - 1];
    const text = turn?.error ?? turn?.result ?? "";
    return h(
      "div",
      { class: `card ${done ? "done" : "error"}` },
      slot(),
      metaLine(taskColor(task), task.project, `${task.agentLabel} ${done ? "ทำงานที่สั่งเสร็จแล้ว" : "เจอปัญหา"}`),
      h("div", { class: "headline", title: text }, clip(text.replace(/[#*_`>]/g, ""), 120) || (done ? "เสร็จแล้ว" : "มีปัญหา")),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: () => {
              state.notice = null;
              openTasks(task.id);
            },
          },
          icon("task", 15),
          "ดูผลลัพธ์",
        ),
        h("button", { class: "btn", onclick: close }, done ? "โอเค" : "รับทราบ"),
      ),
    );
  }
  return h(
    "div",
    { class: `card ${done ? "done" : "error"}` },
    slot(),
    s ? metaLine(AGENT_COLORS[s.agent], s.project, `${s.agentLabel} ${done ? "ทำเสร็จแล้ว" : "เจอปัญหา"}`) : null,
    h("div", { class: "headline" }, s ? s.detail || s.activity : done ? "เสร็จแล้ว" : "มีปัญหา"),
    h(
      "div",
      { class: "actions" },
      task
        ? h(
            "button",
            {
              class: "btn primary",
              onclick: () => {
                state.notice = null;
                openTasks(task.id);
              },
            },
            icon("task", 15),
            "ดูผลลัพธ์",
          )
        : null,
      s && !task
        ? h(
            "button",
            {
              class: "btn primary",
              onclick: () => {
                void api.openFolder(s.cwd).catch((e) => toast(errorText(e)));
                close();
              },
            },
            icon("folder", 15),
            "เปิดโฟลเดอร์",
          )
        : null,
      h("button", { class: "btn", onclick: close }, done ? "โอเค" : "รับทราบ"),
    ),
  );
}

function renderDrop(): HTMLElement {
  return h(
    "div",
    { class: "card drop" },
    slot(),
    h("div", { class: "headline" }, `วางไฟล์ให้ ${name()} ได้เลย`),
    h("div", { class: "chips" }, ...["รูป", "PDF", "โค้ด", "ข้อความ"].map((t) => h("span", { class: "chip" }, t))),
  );
}

function renderFiles(): HTMLElement {
  const files = state.drop.files;
  const usable = files.filter((f) => f.supported);
  const folder = files.find((f) => f.kind === "folder");
  const others = files.filter((f) => f !== folder);
  const dropped = splitDrop(state.drop.paths.length ? state.drop.paths : files.map((f) => f.path), files);
  const title = folder
    ? `โฟลเดอร์ ${folder.name}`
    : files.length === 1
      ? `${files[0].name} พร้อมแล้ว`
      : `${usable.length} ไฟล์พร้อมแล้ว`;
  const provider = providerLabel();
  const clear = () => {
    state.drop.files = [];
    state.drop.paths = [];
    render();
  };
  return h(
    "div",
    { class: "card" },
    slot(),
    h("div", { class: "headline", title: files.map((f) => f.path).join("\n") }, folder || usable.length ? title : "ใช้ไฟล์นี้ไม่ได้"),
    folder
      ? h("div", { class: "text" }, others.length ? `สั่งงานในโฟลเดอร์นี้ พร้อมไฟล์อีก ${others.length} ไฟล์` : `ให้ ${name()} สั่ง agent ทำงานในโฟลเดอร์นี้ได้เลย`)
      : files.length > 1 || !usable.length
        ? h(
            "div",
            { class: "files" },
            ...files.map((f) =>
              h(
                "div",
                { class: f.supported ? "" : "bad" },
                icon(f.kind === "image" ? "image" : "file", 15),
                h("span", { class: "name" }, f.name),
                f.supported ? h("span", { class: "sub" }, fileSize(f.size)) : h("span", { class: "why" }, f.reason ?? "ใช้ไม่ได้"),
              ),
            ),
          )
        : h("div", { class: "text" }, "อยากให้ช่วยอะไรกับไฟล์นี้?"),
    h(
      "div",
      { class: "actions" },
      folder
        ? h("button", { class: "btn primary", onclick: () => openTasksWith(dropped) }, icon("task", 15), "สั่งงานในโฟลเดอร์นี้")
        : h("button", { class: "btn primary", disabled: !usable.length, onclick: () => askAbout() }, `ถาม${provider ? ` ${provider}` : ""}`),
      folder ? null : h("button", { class: "btn", onclick: () => openTasksWith(dropped) }, icon("task", 15), "สั่งงานกับไฟล์นี้"),
      h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(files.map((f) => f.path).join("\n"));
              toast("คัดลอก path แล้ว");
            } catch {
              toast("คัดลอกไม่ได้");
            }
          },
        },
        icon("copy", 14),
        "คัดลอก path",
      ),
      h("button", { class: "btn", onclick: clear }, "ยกเลิก"),
    ),
  );
}

function renderSide(): HTMLElement | null {
  const shownKey =
    state.view === "home" ? featured()?.key : state.view === "notice" ? state.notice?.key : state.view === "approval" ? state.approvals[0]?.sessionKey : null;
  const others = ranked().filter((s) => s.key !== shownKey);
  if (!others.length) return null;
  const shown = others.slice(0, 3);
  return h(
    "div",
    { class: "side" },
    ...shown.map((s) =>
      h(
        "button",
        {
          class: "mini",
          title: `${s.project} · ${s.agentLabel} · ${STATE_LABELS[s.state]}`,
          "aria-label": `${s.project} ${s.agentLabel} ${STATE_LABELS[s.state]}`,
          onclick: () => {
            state.featured = s.key;
            state.notice = null;
            state.pinned = true;
            goHome();
          },
        },
        miniImg(s, 46),
        dot(AGENT_COLORS[s.agent], busy(s)),
      ),
    ),
    others.length > shown.length ? h("span", { class: "more" }, `+${others.length - shown.length}`) : null,
  );
}

function goHome() {
  state.chat.open = false;
  state.notice = null;
  state.pinned = true;
  render();
}

// ── Approvals ───────────────────────────────────────────────────────────────────

function ackApprovals() {
  requestAnimationFrame(() => {
    for (const a of state.approvals) {
      if (!state.acked.has(a.id)) {
        state.acked.add(a.id);
        void api.ackApproval(a.id).catch(() => {});
      }
    }
  });
}

async function decide(a: ApprovalView, decision: "allow" | "always" | "deny" | "terminal") {
  state.approvals = state.approvals.filter((x) => x.id !== a.id);
  keepDrafts(state.approvals);
  if (decision === "allow" || decision === "always") {
    marsh.react(decision === "always" ? "adore" : "love", decision === "always" ? 1700 : 1100);
    marsh.bump(2.6);
    if (decision === "always") toast(`อนุญาตทั้งรอบนี้แล้ว — สั่งงานครั้งถัดไป ${a.agentLabel} จะถามใหม่`);
  } else if (decision === "deny" && a.questions) {
    // A skipped question: the agent goes on with its own pick, nothing to frown about.
    toast(`ข้ามแล้ว — ${a.agentLabel} จะเลือกเองแล้วทำงานต่อ`);
  } else if (decision === "deny") {
    marsh.react("annoyed", 700);
  }
  render();
  recallIfAnswered();
  try {
    await api.decide(a.id, decision);
  } catch (err) {
    toast(errorText(err));
  }
}

// ── Questions ───────────────────────────────────────────────────────────────────

/** Picks a choice of the front question. A single choice moves on (or sends) right away. */
function choose(a: ApprovalView, label: string) {
  const d = draftFor(a);
  const q = a.questions![d.step];
  pick(q, d, label);
  if (!q.multiSelect) return next(a);
  marsh.bump(1.2);
  render();
}

/** Opens the "อื่น ๆ" box: your own words instead of (or, for several, as well as) a choice. */
function typeOwn(a: ApprovalView) {
  const d = draftFor(a);
  if (!a.questions![d.step].multiSelect) d.picked[d.step] = [];
  d.typing = d.step;
  state.focusNext = true;
  render();
}

function back(a: ApprovalView) {
  const d = draftFor(a);
  d.step = Math.max(0, d.step - 1);
  d.typing = null;
  render();
}

/** On to the next question once this one has an answer; after the last, send them all. */
function next(a: ApprovalView) {
  const d = draftFor(a);
  const qs = a.questions!;
  if (!answerOf(qs[d.step], d, d.step)) return;
  d.typing = null;
  if (d.step < qs.length - 1) {
    d.step++;
    marsh.bump(1.4);
    render();
    return;
  }
  const answers = answersOf(a, d);
  if (answers) void sendAnswers(a, answers);
}

async function sendAnswers(a: ApprovalView, answers: Answers) {
  state.approvals = state.approvals.filter((x) => x.id !== a.id);
  keepDrafts(state.approvals);
  marsh.react("happy", 1100);
  marsh.bump(2.4);
  render();
  recallIfAnswered();
  try {
    if (!(await api.answer(a.id, answers))) toast(`คำถามนี้หมดเวลาแล้ว — ไปตอบที่หน้าจอของ ${a.agentLabel} แทนนะ`);
  } catch (err) {
    toast(errorText(err));
  }
}

function setApprovals(list: ApprovalView[]) {
  const fresh = list.filter((a) => !state.seenApprovals.has(a.id));
  for (const a of fresh) state.seenApprovals.add(a.id);
  if (fresh.length) {
    sound("ask");
    marsh.bump(2.2);
  }
  state.approvals = list;
  keepDrafts(list);
  state.lastActivity = Date.now();
  render();
  // The card at the front is the one Mamori reaches out with.
  const first = list[0];
  if (first && fresh.some((a) => a.id === first.id)) sendRoam(approvalRequest(first));
}

// ── Chat ────────────────────────────────────────────────────────────────────────

function installed(): ProviderStatus[] {
  return state.chat.providers.filter((p) => p.installed);
}

/** The provider the next message goes to, as a label ("" when unknown yet). */
function providerLabel(): string {
  const pick = state.chat.provider;
  if (pick !== "auto") return PROVIDER_LABELS[pick];
  const first = installed()[0];
  return first ? first.label : "";
}

async function loadProviders(refresh = false) {
  try {
    state.chat.providers = await api.chatProviders(refresh);
  } catch {
    state.chat.providers = [];
  }
  state.chat.providersChecked = true;
  const pick = state.chat.provider;
  if (pick !== "auto" && !installed().some((p) => p.id === pick)) state.chat.provider = "auto";
  if (state.level === "open" && state.view === "chat") chat.update();
  else render();
}

const chat = (() => {
  const back = h("button", { class: "icon-btn", title: "กลับ", "aria-label": "กลับหน้าหลัก", onclick: () => goHome() }, icon("back", 18));
  const title = h("span", { class: "title" }, "");
  const pickBtn = h("button", { class: "chip-btn", title: "เปลี่ยนผู้ตอบ" }) as HTMLButtonElement;
  const fresh = h("button", { class: "icon-btn", title: "แชทใหม่", "aria-label": "แชทใหม่", onclick: () => reset() }, icon("new", 18));
  const close = h("button", { class: "icon-btn", title: "ปิด (Esc)", "aria-label": "ปิดแชท", onclick: () => closeChat() }, icon("close", 17));
  const headRow = h("div", { class: "chat-head" }, back, h("span", { class: "slot", "aria-hidden": "true" }), title, h("span", { class: "grow" }), pickBtn, fresh, close);
  const msgs = h("div", { class: "msgs", role: "log", "aria-live": "polite" });
  const notice = h("div", { class: "notice" });
  const atts = h("div", { class: "atts" });
  const textarea = h("textarea", { rows: 1, placeholder: "", "aria-label": "ข้อความ" }) as HTMLTextAreaElement;
  const send = h("button", { class: "send", type: "button", "aria-label": "ส่ง" }) as HTMLButtonElement;
  const compose = h("div", { class: "compose" }, textarea, send);
  const root = h("div", { class: "chat" }, headRow, msgs, notice, atts, compose);
  const bubbles: HTMLElement[] = [];

  pickBtn.addEventListener("click", () => {
    // Cycle: auto → each installed tool → auto.
    const options: ChatProviderSetting[] = ["auto", ...installed().map((p) => p.id)];
    const i = options.indexOf(state.chat.provider);
    state.chat.provider = options[(i + 1) % options.length] ?? "auto";
    update();
  });

  const grow = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(110, textarea.scrollHeight)}px`;
  };
  textarea.addEventListener("input", grow);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat();
    } else if (e.key === "Escape") {
      closeChat();
    }
  });
  send.addEventListener("click", () => {
    if (state.chat.streamingId) void api.chatCancel(state.chat.streamingId);
    else void sendChat();
  });

  function fill(el: HTMLElement, entry: ChatEntry) {
    el.className = `bubble ${entry.role}${entry.error ? " error" : ""}`;
    if (entry.role === "assistant" && entry.pending && !entry.text) {
      el.replaceChildren(
        h("span", { class: "typing", "aria-label": "กำลังพิมพ์" }, h("i"), h("i"), h("i")),
        h("span", { class: "typing-label" }, state.chat.streamingLabel ? `กำลังถาม ${state.chat.streamingLabel}…` : ""),
      );
    } else if (entry.role === "assistant" && !entry.error) {
      el.innerHTML = renderMarkdown(entry.text);
    } else {
      el.textContent = entry.text;
      if (entry.files?.length) el.append(h("span", { class: "files-note" }, `ไฟล์: ${entry.files.map((f) => f.name).join(", ")}`));
    }
  }

  function update() {
    title.textContent = `แชทกับ ${name()}`;
    const label = providerLabel();
    pickBtn.replaceChildren(state.chat.provider === "auto" ? `อัตโนมัติ${label ? ` · ${label}` : ""}` : label, icon("chevron", 14));
    pickBtn.style.display = installed().length ? "" : "none";

    const entries = state.chat.entries;
    if (!entries.length) {
      bubbles.length = 0;
      msgs.replaceChildren(
        h(
          "div",
          { class: "hint" },
          h("b", null, `ถาม ${name()} ได้เลย`),
          h("br"),
          `ตอบผ่าน ${label || "CLI ที่ล็อกอินไว้"} ของคุณ ไม่ต้องใช้ API key`,
          h("br"),
          "ลากไฟล์มาวางที่แถบนี้เพื่อถามเรื่องไฟล์ก็ได้",
        ),
      );
    } else {
      if (!bubbles.length) msgs.replaceChildren();
      entries.forEach((entry, i) => {
        if (!bubbles[i]) {
          bubbles[i] = h("div");
          msgs.append(bubbles[i]);
        }
        fill(bubbles[i], entry);
      });
      msgs.scrollTop = msgs.scrollHeight;
    }

    if (state.chat.providersChecked && !installed().length) {
      notice.style.display = "flex";
      notice.replaceChildren(
        icon("alert", 16),
        h("span", null, "ยังไม่พบ Claude Code, Codex, Antigravity หรือ Gemini CLI ในเครื่อง"),
        h("button", { class: "btn", onclick: () => void api.openSettings("chat") }, "ดูวิธีตั้งค่า"),
      );
    } else {
      notice.style.display = "none";
    }

    atts.replaceChildren(
      ...state.chat.attachments.map((f) =>
        h(
          "div",
          { class: "att", title: f.path },
          icon(f.kind === "image" ? "image" : "file", 14),
          h("span", null, f.name),
          h(
            "button",
            {
              class: "icon-btn",
              "aria-label": `เอา ${f.name} ออก`,
              onclick: () => {
                state.chat.attachments = state.chat.attachments.filter((x) => x.path !== f.path);
                update();
              },
            },
            icon("close", 12),
          ),
        ),
      ),
    );
    atts.style.display = state.chat.attachments.length ? "flex" : "none";
    textarea.placeholder = state.chat.attachments.length ? "อยากให้ช่วยอะไรกับไฟล์นี้?" : `พิมพ์ถาม ${name()}…`;
    send.replaceChildren(icon(state.chat.streamingId ? "stop" : "up", 17));
    send.setAttribute("aria-label", state.chat.streamingId ? "หยุด" : "ส่ง");
    send.title = state.chat.streamingId ? "หยุด" : "ส่ง (Enter)";
    queueLayout();
  }

  function reset() {
    if (state.chat.streamingId) void api.chatCancel(state.chat.streamingId);
    state.chat.entries = [];
    state.chat.attachments = [];
    state.chat.streamingId = null;
    bubbles.length = 0;
    update();
    textarea.focus();
  }

  return {
    root,
    update,
    reset,
    focus: () => textarea.focus(),
    takeText: () => {
      const t = textarea.value.trim();
      textarea.value = "";
      grow();
      return t;
    },
  };
})();

function openChat(fresh = false) {
  state.focusNext = true;
  state.chat.open = true;
  state.task.open = false;
  state.notice = null;
  if (fresh) chat.reset();
  render();
  if (!state.chat.providersChecked) void loadProviders();
}

function closeChat() {
  state.chat.open = false;
  state.hover = false;
  state.pinned = false;
  render();
}

// ── Tasks Mamori runs ("สั่งงาน") ──────────────────────────────────────────────

const tasks = createTasks({
  name,
  providers: () => state.chat.providers,
  providersChecked: () => state.chat.providersChecked,
  loadProviders: (refresh) => void loadProviders(refresh),
  sessions: () => state.sessions,
  render,
  layout: queueLayout,
  toast,
  back: () => {
    state.task.open = false;
    goHome();
  },
  close: () => closeTasks(),
  react: (expr, ms) => marsh.react(expr, ms),
  bump: (amount) => marsh.bump(amount),
  sound: (n) => sound(n),
  finished: (t) => taskFinished(t),
});

function openTasks(id: string | null = null) {
  state.focusNext = true;
  state.task.open = true;
  state.chat.open = false;
  state.notice = null;
  tasks.open(id);
  render();
  if (!state.chat.providersChecked) void loadProviders();
}

function closeTasks() {
  state.task.open = false;
  state.hover = false;
  state.pinned = false;
  render();
}

/** Opens the task form with a folder (and files) already in, like opening a project. */
function openTasksWith(d: Dropped) {
  state.drop.files = [];
  state.drop.paths = [];
  openTasks(null);
  tasks.prefill(d);
  void api.showIsland().catch(() => {});
}

/** What was dropped, split the way tasks want it: one folder to work in, the rest as files. */
function splitDrop(paths: string[], infos: FileInfo[]): Dropped {
  const folder = infos.find((f) => f.kind === "folder")?.path ?? null;
  return { folder, files: paths.filter((p) => p !== folder) };
}

/** The task a session belongs to, when Mamori started it. */
function taskOf(s: Session): Task | null {
  return (s.task ? tasks.byId(s.task) : null) ?? tasks.tasks().find((t) => t.sessionKey === s.key) ?? null;
}

function taskColor(t: Task): string {
  return t.agent === "gemini" ? "#4f8df7" : AGENT_COLORS[t.agent];
}

/**
 * A task finished. When its hooks reported in, the session's own "done" already brought
 * the news (card, sound, Mamori reaching out); otherwise it is said here.
 */
function taskFinished(t: Task) {
  const s = t.sessionKey ? state.sessions.find((x) => x.key === t.sessionKey) : null;
  if (t.status === "stopped") return;
  // Once per turn, whichever way the news came in.
  const turnKey = `${t.id}:${t.turns.length}`;
  if (state.announced.has(turnKey)) return;
  state.announced.add(turnKey);
  const ok = t.status === "done";
  if (state.task.open && tasks.current === t.id) {
    // You are looking right at it.
    sound(ok ? "done" : "error");
    marsh.react(ok ? "done" : "sad", 1600);
    marsh.bump(2.2);
    return;
  }
  if (s && (s.state === "done" || s.state === "error") && Date.now() - s.stateSince < 20_000) return;
  sound(ok ? "done" : "error");
  state.notice = { kind: ok ? "done" : "error", key: `task:${t.id}`, at: Date.now() };
  const turn = t.turns[t.turns.length - 1];
  const text = (turn?.error ?? turn?.result ?? "").replace(/[#*_`>]/g, "");
  sendRoam(
    {
      kind: ok ? "done" : "error",
      title: ok ? `${t.project} · ${t.agentLabel} ทำงานที่สั่งเสร็จแล้ว` : `${t.project} · ${t.agentLabel} เจอปัญหา`,
      text: clip(text, 120),
      agent: t.agent === "gemini" ? null : t.agent,
    },
    false,
    t.id,
  );
  render();
}

function askAbout() {
  state.chat.attachments = state.drop.files.filter((f) => f.supported);
  state.drop.files = [];
  state.drop.paths = [];
  openChat();
}

async function sendChat() {
  if (state.chat.streamingId) return;
  const text = chat.takeText();
  const files = state.chat.attachments;
  if (!text && !files.length) return;
  state.chat.entries.push({ role: "user", text: text || "ช่วยดูไฟล์นี้หน่อย", files });
  const reply: ChatEntry = { role: "assistant", text: "", pending: true };
  const history: ChatMessage[] = state.chat.entries
    .filter((e) => !e.error && !e.pending && (e.text || e.files?.length))
    .map((e) => ({ role: e.role, text: e.text, files: (e.files ?? []).map((f) => f.path) }));
  state.chat.entries.push(reply);
  state.chat.attachments = [];
  state.chat.gotText = false;
  state.chat.streamingLabel = providerLabel();
  chat.update();
  updateMood();
  try {
    state.chat.streamingId = await api.chatSend(state.chat.provider, history);
  } catch (err) {
    reply.pending = false;
    reply.error = true;
    reply.text = errorText(err);
    marsh.react("sad", 1600);
  }
  chat.update();
  updateMood();
}

let chatFrame = 0;
function onChatEvent(id: string, kind: string, text: string) {
  if (id !== state.chat.streamingId) return;
  const reply = state.chat.entries[state.chat.entries.length - 1];
  if (!reply || reply.role !== "assistant") return;
  if (kind === "start") {
    state.chat.streamingLabel = text;
    chat.update();
    return;
  }
  if (kind === "delta") {
    reply.text += text;
    state.chat.gotText = true;
    if (!chatFrame) {
      chatFrame = requestAnimationFrame(() => {
        chatFrame = 0;
        chat.update();
        updateMood();
      });
    }
    return;
  }
  reply.pending = false;
  state.chat.streamingId = null;
  if (kind === "error") {
    reply.error = !reply.text;
    reply.text = reply.text ? `${reply.text}\n\n— ${text}` : text;
    marsh.react("sad", 1600);
  } else if (kind === "done") {
    sound("pop");
    marsh.bump(1.6);
  } else if (kind === "cancelled" && !reply.text) {
    reply.text = "(หยุดแล้ว)";
  }
  chat.update();
  updateMood();
}

// ── Mamori's mood ───────────────────────────────────────────────────────────────

function updateMood() {
  const now = Date.now();
  let expr: ExpressionName = "normal";
  if (state.drop.active) expr = "eat";
  else if (state.approvals.length) expr = "ask";
  else if (state.chat.streamingId) expr = state.chat.gotText ? "happy" : "thinking";
  else if (state.notice) expr = state.notice.kind === "done" ? "done" : "error";
  else if (state.drop.files.length) expr = "happy";
  else if (state.task.open && tasks.current && tasks.byId(tasks.current)?.status === "running") expr = "working";
  else {
    const top = state.level === "open" && state.view === "home" ? featured() : live()[0];
    if (top) {
      const age = now - top.stateSince;
      expr = exprFor(top);
      if (top.state === "error" && age > 20_000) expr = age < 60_000 ? "sad" : "normal";
      if (top.state === "done" && age > 8_000) expr = age < 60_000 ? "happy" : "normal";
      if (top.state === "idle") expr = "normal";
    }
    if (expr === "normal" && loneTasks().length) expr = "working";
    if (expr === "normal" && now - state.lastActivity > 10 * 60_000) expr = "sleepy";
  }
  marsh.setExpression(expr);
  // Nothing going on, but agents are around: a small green "here" bud on the sprout.
  marsh.setBadge(expr === "normal" && state.sessions.length > 0 ? "online" : undefined);
}

function noticeTransitions(next: Session[]) {
  for (const s of next) {
    const prev = state.prevStates.get(s.key);
    // A task Mamori ran says it's done itself, with what it did (taskFinished).
    const ownTask = s.task ? tasks.byId(s.task) : null;
    if (prev && prev !== s.state && !ownTask) {
      if (s.state === "done" && (prev === "working" || prev === "thinking")) {
        sound("done");
        state.notice = { kind: "done", key: s.key, at: Date.now() };
        sendRoam(sessionRequest(s, "done"), false, s.task);
      }
      if (s.state === "error") {
        sound("error");
        state.notice = { kind: "error", key: s.key, at: Date.now() };
        sendRoam(sessionRequest(s, "error"), false, s.task);
      }
    }
  }
  state.prevStates = new Map(next.map((s) => [s.key, s.state]));
}

// ── Mamori's trips to the pointer ───────────────────────────────────────────────

/** Closer than this to the island and you can already see Mamori: no trip. */
const ROAM_MIN_DISTANCE = 280;
/** At most one "done"/"problem" trip this often (approvals always go). */
const ROAM_SPACING = 25_000;

const roam = {
  away: false,
  starting: false,
  kind: null as RoamKind | null,
  approvalId: null as number | null,
  lastAt: 0,
  /** The last trip with news (done or a problem): those are spaced out. */
  lastNewsAt: 0,
  /** News that came while Mamori was still out with an approval: told once it's back. */
  pending: null as { req: RoamRequest; task: string | null; at: number } | null,
  pointer: { x: 0, y: 0, at: 0 },
  timer: 0,
  nestTimer: 0,
  startTimer: 0,
  /** The task the current trip is about (a click opens it). */
  task: null as string | null,
};

/** Where Mamori's head is right now (its widest line, window CSS px) and how big. */
function nest(): { nest: Point; scale: number } {
  const v = seat.targets();
  const head = marsh.headOnScreen();
  const left = seatCentred ? (WINDOW_W - OPEN_W) / 2 : (WINDOW_W - shape.s.w.goal) / 2;
  return {
    nest: { x: left + v.x + head.x * v.k, y: v.y + head.y * v.k },
    scale: (head.r * v.k) / ROAM_UNIT,
  };
}

function approvalRequest(a: ApprovalView): RoamRequest {
  if (a.questions) {
    return {
      kind: "approval",
      title: `${a.project} · ${a.agentLabel} ถามคุณ`,
      text: clip(a.questions[0].question, 160),
      agent: a.agent,
      approvalId: a.id,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      questions: a.questions,
    };
  }
  const command = a.toolKind === "command" && !!a.target;
  return {
    kind: "approval",
    title: `${a.project} · ${a.agentLabel} ขออนุมัติ`,
    text: command ? clip(a.target!, 140) : clip(a.title, 120),
    code: command,
    agent: a.agent,
    approvalId: a.id,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

function sessionRequest(s: Session, kind: "done" | "error"): RoamRequest {
  return {
    kind,
    title: kind === "done" ? `${s.project} · ${s.agentLabel} ทำเสร็จแล้ว` : `${s.project} · ${s.agentLabel} เจอปัญหา`,
    text: clip(s.detail || s.activity, 120),
    agent: s.agent,
  };
}

/** Why Mamori stays home this time, or null when it can go. */
function roamBlocked(kind: RoamKind, test: boolean): string | null {
  const s = state.settings;
  if (!s) return "no settings yet";
  if ((roam.away || roam.starting) && roam.kind === "approval" && kind !== "approval") return "busy with an approval";
  if (test) return null;
  if (s.roam === "off" || (s.roam === "approvals" && kind !== "approval")) return "turned off in the settings";
  if (reducedMotion()) return "reduced motion";
  if (state.hover || state.chat.open || state.task.open || state.drop.active || state.drop.files.length) return "the island is in use";
  const n = nest();
  if (Math.hypot(roam.pointer.x - n.nest.x, roam.pointer.y - n.nest.y) < ROAM_MIN_DISTANCE) return "the pointer is near the island";
  if (kind !== "approval") {
    if (Date.now() - roam.lastNewsAt < ROAM_SPACING) return "reached out a moment ago";
    if (Date.now() - roam.pointer.at > 5 * 60_000) return "nobody at the mouse";
  }
  return null;
}

function roamAllowed(kind: RoamKind, test: boolean): boolean {
  const why = roamBlocked(kind, test);
  if (why) api.log(`roam: stays home for ${kind} (${why})`);
  return why === null;
}

/**
 * What Mamori nudges you with: in "ตามเรื่อง" its head for a question or a problem (you
 * see its face, it talks to you), a tap of the hand for finished work.
 */
function reachFor(kind: RoamKind): "head" | "hand" {
  const pick = state.settings?.reachWith ?? "auto";
  if (pick === "head" || pick === "hand") return pick;
  return kind === "done" ? "hand" : "head";
}

/** Sends Mamori out with `req`, once the island has settled into its new shape. */
function sendRoam(request: RoamRequest, test = false, task: string | null = null) {
  const req: RoamRequest = { ...request, reach: request.reach ?? reachFor(request.kind) };
  if ((roam.away || roam.starting) && roam.kind === "approval" && req.kind !== "approval") {
    // Still out with a question (or on the way back): this one waits its turn.
    roam.pending = { req, task, at: Date.now() };
    return;
  }
  if (!roamAllowed(req.kind, test)) return;
  clearTimeout(roam.timer);
  roam.timer = window.setTimeout(
    async () => {
      if (!roamAllowed(req.kind, test)) return;
      if (req.kind === "approval" && !state.approvals.some((a) => a.id === req.approvalId)) return;
      const n = nest();
      roam.starting = true;
      roam.kind = req.kind;
      roam.approvalId = req.approvalId ?? null;
      roam.task = task;
      roam.lastAt = Date.now();
      if (req.kind !== "approval") roam.lastNewsAt = roam.lastAt;
      try {
        const ok = await api.roamStart(req, n.nest, n.scale);
        if (!ok) {
          roam.starting = false;
          return;
        }
        api.log(`roam: out with ${req.kind}`);
        clearTimeout(roam.startTimer);
        roam.startTimer = window.setTimeout(() => (roam.starting = false), 6000);
      } catch (err) {
        roam.starting = false;
        api.log(`roam: failed: ${errorText(err)}`);
      }
    },
    test ? 120 : 520,
  );
}

function setAway(away: boolean) {
  roam.away = away;
  seatEl.classList.toggle("away", away);
  if (!away) {
    roam.kind = null;
    roam.approvalId = null;
    // Back in its seat with a little bounce.
    marsh.react("happy", 900);
    marsh.bump(2.4);
    // News that came in meanwhile goes out now (if it's still fresh).
    const next = roam.pending;
    roam.pending = null;
    if (next && Date.now() - next.at < 15_000) window.setTimeout(() => sendRoam(next.req, false, next.task), 400);
  }
  queueLayout();
}

function recallIfAnswered() {
  if (!(roam.away || roam.starting) || roam.kind !== "approval") return;
  if (!state.approvals.some((a) => a.id === roam.approvalId)) void api.roamRecall().catch(() => {});
}

// Clicking Mamori: in the pill or the notch it opens the island; in a card it is a poke.
seatEl.addEventListener("click", () => {
  if (state.level === "open") {
    marsh.poke();
    sound("pop");
    return;
  }
  marsh.react("wink", 900);
  state.pinned = true;
  render();
});

// ── Pointer: peek, hover, eyes ──────────────────────────────────────────────────

let hoverTimer = 0;
let peekTimer = 0;
/** What the pending timers will switch to (null: nothing pending). */
let peekPending: boolean | null = null;
let hoverPending: boolean | null = null;

/**
 * How long the pointer has to stay before Mamori peeks out or the island opens
 * (settings: "หน่วงก่อนแสดง"). Passing by on the way to a tab or a title bar at the
 * top of the screen never pops it open over what you meant to click.
 */
function showDelay(): number {
  return Math.max(0, state.settings?.hoverDelay ?? 600);
}

function setHint() {
  const hint = peekPending === true || hoverPending === true;
  if (hint !== state.hint) {
    state.hint = hint;
    queueLayout();
  }
}

function onCursor(x: number, y: number, inside: boolean) {
  state.lastCursorMove = Date.now();
  roam.pointer = { x, y, at: Date.now() };
  if (inside && roam.away && roam.kind !== "approval") void api.roamRecall().catch(() => {});

  // Coming up to the top of the screen near the island: Mamori peeks out, once the
  // pointer has stayed there a moment (moving about inside doesn't restart the wait).
  const near = Math.abs(x - WINDOW_W / 2) < 150 && y < 46;
  if (near !== state.near) {
    if (peekPending !== near) {
      peekPending = near;
      clearTimeout(peekTimer);
      peekTimer = window.setTimeout(
        () => {
          peekPending = null;
          setHint();
          if (state.near === near) return;
          state.near = near;
          if (near && state.level === "tuck") {
            marsh.react("happy", 900);
            marsh.bump(1.8);
          }
          render();
        },
        near ? showDelay() : 700,
      );
    }
  } else if (peekPending !== null) {
    clearTimeout(peekTimer);
    peekPending = null;
  }
  setHint();

  if (state.settings?.eyesFollow !== false && state.level !== "tuck") {
    const v = seat.values();
    const head = marsh.headOnScreen();
    const cx = seatOrigin() + v.x + head.x * v.k;
    const cy = v.y + head.y * v.k;
    marsh.lookAt([Math.max(-1, Math.min(1, (x - cx) / 260)), Math.max(-1, Math.min(1, (y - cy) / 180))]);
  }

  if (inside !== state.hover) {
    if (hoverPending !== inside) {
      hoverPending = inside;
      clearTimeout(hoverTimer);
      // Already peeking at you: opening the rest of the way takes half the wait.
      const wait = inside ? (state.level === "peek" ? showDelay() * 0.5 : showDelay()) : 520;
      hoverTimer = window.setTimeout(() => {
        hoverPending = null;
        setHint();
        if (state.hover === inside) return;
        state.hover = inside;
        if (inside && Date.now() - state.lastWink > 6000 && marsh.expression === "normal") {
          state.lastWink = Date.now();
          marsh.react("wink", 900);
        }
        if (!inside) {
          state.pinned = false;
          state.featured = null;
        }
        render();
      }, wait);
    }
  } else if (hoverPending !== null) {
    clearTimeout(hoverTimer);
    hoverPending = null;
  }
  setHint();
}

async function setupDrops() {
  try {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        if (!state.drop.active) {
          state.drop.active = true;
          render();
        }
      } else if (p.type === "leave") {
        state.drop.active = false;
        render();
      } else if (p.type === "drop") {
        state.drop.active = false;
        sound("gulp");
        marsh.react("happy", 1200);
        marsh.bump(2.4);
        const infos = await api.inspectFiles(p.paths).catch(() => [] as FileInfo[]);
        // The task pages take files and a folder the way an IDE's chat does.
        if (state.task.open) {
          tasks.drop(splitDrop(p.paths, infos));
          render();
          return;
        }
        state.drop.files = infos;
        state.drop.paths = p.paths;
        if (state.chat.open && state.drop.files.some((f) => f.supported)) {
          state.chat.attachments = [...state.chat.attachments, ...state.drop.files.filter((f) => f.supported)].slice(0, 5);
          state.drop.files = [];
          state.drop.paths = [];
        }
        render();
      }
    });
  } catch {
    // Not inside Tauri (a preview page): no drops.
  }
}

document.addEventListener("keydown", (e) => {
  // A question at the front: 1–9 picks a choice (the last number is "อื่น ๆ"), Enter
  // sends what is picked, like answering in Claude Code itself.
  const a = state.level === "open" && state.view === "approval" ? shownApprovals()[0] : undefined;
  const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (a?.questions && !field && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const q = a.questions[draftFor(a).step];
    const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    if (n && n <= q.options.length) {
      e.preventDefault();
      return choose(a, q.options[n - 1].label);
    }
    if (n === q.options.length + 1) {
      e.preventDefault();
      return typeOwn(a);
    }
    if (e.key === "Enter") return next(a);
  }
  if (e.key !== "Escape") return;
  if (state.chat.open) closeChat();
  else if (state.task.open) closeTasks();
  else if (state.pinned) {
    state.pinned = false;
    render();
  }
});

// ── Start ───────────────────────────────────────────────────────────────────────

const applyLook = useLook(() => state.settings?.islandLook);
// The island itself still glides with reduced motion (GENTLE); Mamori just keeps still.
const applyMotion = useMotion(() => state.settings?.motion, (reduced) => marsh.setReducedMotion(reduced));

function applySettings(s: Settings) {
  state.settings = s;
  applyLook();
  applyMotion();
  seatEl.setAttribute("aria-label", s.mascotName || "Mamori");
  marsh.setColor(s.color);
  configureSound(s.sound, s.volume);
  if (!s.eyesFollow) marsh.lookAt(null);
  if (state.chat.provider === "auto" || !state.chat.entries.length) state.chat.provider = s.chatProvider;
}

async function start() {
  try {
    const snap = await api.snapshot();
    applySettings(snap.settings);
    state.sessions = snap.sessions;
    state.prevStates = new Map(snap.sessions.map((s) => [s.key, s.state]));
    for (const a of snap.approvals) state.seenApprovals.add(a.id);
    state.approvals = snap.approvals;
  } catch (err) {
    console.warn("snapshot failed", err);
  }
  state.history = await api.history().catch(() => []);
  // Say hello: peek out once at start.
  state.hello = true;
  render();
  marsh.react("wink", 1100);
  window.setTimeout(() => sound("hello"), 250);
  window.setTimeout(() => {
    state.hello = false;
    render();
  }, 2600);

  await on.sessions((list) => {
    noticeTransitions(list);
    state.sessions = list;
    state.lastActivity = Date.now();
    render();
  });
  await on.approvals((list) => {
    setApprovals(list);
    recallIfAnswered();
  });
  await on.roamAway(() => {
    clearTimeout(roam.startTimer);
    roam.starting = false;
    setAway(true);
  });
  await on.roamHome(() => {
    clearTimeout(roam.startTimer);
    roam.starting = false;
    setAway(false);
  });
  await on.roamOpen(() => {
    // About a task: straight to what it did. Otherwise the island opens.
    if (roam.task && tasks.byId(roam.task)) {
      openTasks(roam.task);
      return;
    }
    state.pinned = true;
    state.hover = true;
    render();
  });
  await on.roamTest(() =>
    sendRoam(
      {
        kind: "done",
        title: `สวัสดี! ${name()} มาแล้ว`,
        text: "เวลามีงานเสร็จ มีปัญหา หรือ agent ขออนุมัติ จะยืดคอมาบอกตรงนี้",
      },
      true,
    ),
  );
  await on.history((item) => {
    state.history = [item, ...state.history.filter((x) => x.id !== item.id)].slice(0, 300);
    if (state.level === "open" && state.view === "home") render();
  });
  await on.cursor((c) => onCursor(c.x, c.y, c.inside));
  await on.settings((s) => {
    applySettings(s);
    render();
  });
  await on.chat((c) => onChatEvent(c.id, c.kind, c.text));
  await on.task((t) => tasks.apply(t));
  await on.taskRemoved((id) => tasks.remove(id));
  try {
    tasks.setSnapshot(await api.taskList());
  } catch {
    // Not inside Tauri (a preview page).
  }
  // A folder from Explorer's "สั่งงาน Mamori ที่นี่", or files dropped on the app's icon.
  const opened = (req: OpenRequest) => {
    void api.takeOpen().catch(() => null);
    sound("pop");
    marsh.react("excited", 1200);
    openTasksWith({ folder: req.folder, files: req.files });
  };
  await on.openTask(opened);
  const waiting = await api.takeOpen().catch(() => null);
  if (waiting) opened(waiting);
  await on.visible((v) => {
    if (!v && state.chat.open) closeChat();
    if (!v && state.task.open) closeTasks();
    if (v) render();
  });
  await setupDrops();
  // Which CLI the chat will use (for "ถาม Claude Code" on a dropped file); a bit later,
  // so start-up stays light.
  window.setTimeout(() => void loadProviders(), 4000);

  window.setInterval(() => {
    const now = Date.now();
    // A finished/problem card steps aside after a while (unless you're looking at it).
    if (state.notice && !state.hover) {
      const stay = state.notice.kind === "done" ? 7000 : 12_000;
      if (now - state.notice.at > stay) {
        state.notice = null;
        render();
      }
    }
    if (now - state.lastCursorMove > 8000) marsh.lookAt(null);
    if (state.level === "open" && state.view === "home") {
      // Keep "· 2 นาที" fresh without rebuilding everything every second.
      const s = featured();
      const sub = openEl.querySelector(".card .meta .sub");
      if (s && sub && (busy(s) || s.state === "approval")) sub.textContent = `${s.agentLabel} · ${STATE_LABELS[s.state]} · ${timeAgo(s.stateSince)}`;
    }
    updateMood();
  }, 1000);
}

void start();
