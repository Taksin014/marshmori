// Playground for Mamori's long neck reaching for the mouse pointer, without Tauri:
//   http://127.0.0.1:1420/dev/roam.html            move the mouse, press the buttons
//   http://127.0.0.1:1420/dev/roam.html?capture=1  a scripted scene, stepped by hand
//     (window.__step(dt) advances it; used to record the GIF frame by frame)
//     &scene=approval|done|showcase
//   &reach=head|hand   what Mamori reaches out with (default: head for questions and
//                      problems, a hand that taps for finished work — like the app)

import "../src/roam/roam.css";

import { Spring } from "../src/core/spring";
import type { RoamRequest } from "../src/core/types";
import type { ExpressionName } from "../src/mascot/expressions";
import { Marshmori } from "../src/mascot/marsh";
import { ROAM_UNIT, Roamer } from "../src/roam/roamer";
import { RoamView, type RoamAction } from "../src/roam/view";

const params = new URLSearchParams(location.search);
// &look=dark|light|forest|midnight: the bubble's look (the island's setting).
if (params.has("look")) document.documentElement.dataset.look = params.get("look")!;
const capture = params.has("capture");
const scene = params.get("scene") ?? "approval";

// Same numbers every run, so the recording is reproducible.
if (capture) {
  let seed = 20261003;
  Math.random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  document.body.classList.add("capture");
}

let clock = 0;

const islandEl = document.getElementById("island")!;
const ticker = document.getElementById("ticker")!;
const seatEl = document.getElementById("seat")!;
const cursorEl = document.getElementById("cursor")!;
const ring = document.getElementById("ring")!;
const islandMarsh = new Marshmori(seatEl, { mode: "head", quality: "high", autoStart: !capture, idle: false });
let islandFace: ExpressionName = "working";
islandMarsh.setExpression(islandFace);

// The island's shape and Mamori's seat move on springs with the real island's numbers
// (src/core/spring.ts), stepped in scene time while recording.
const SEAT = 80;
const PILL = { w: 300, h: 38, r: 19, sx: 2, sy: 0, size: 48 };
const CARD = { w: 460, h: 118, r: 30, sx: 24, sy: 14, size: 80 };
type IslandKey = keyof typeof PILL;
const isl = Object.fromEntries(Object.entries(PILL).map(([k, v]) => [k, new Spring(v)])) as Record<IslandKey, Spring>;

function stepIsland(dt: number) {
  for (const sp of Object.values(isl)) sp.step(dt);
  islandEl.style.width = `${isl.w.value}px`;
  islandEl.style.height = `${isl.h.value}px`;
  islandEl.style.borderRadius = `0 0 ${isl.r.value}px ${isl.r.value}px`;
  seatEl.style.transform = `translate(${isl.sx.value}px, ${isl.sy.value}px) scale(${isl.size.value / SEAT})`;
}

/**
 * Where the head of the island's Mamori is going to be (page pixels) and its size
 * relative to full: the island sends where it's headed, as the real one does.
 */
function nest() {
  const head = islandMarsh.headOnScreen();
  const k = isl.size.target / SEAT;
  const left = window.innerWidth / 2 - isl.w.target / 2;
  return { x: left + isl.sx.target + head.x * k, y: isl.sy.target + head.y * k, k: (head.r * k) / ROAM_UNIT };
}

// "showcase": Mamori big, on its own, chasing the pointer around (the run up close).
const showcase = scene === "showcase";
const BIG = 2.4;
if (showcase) document.body.classList.add("showcase");
const box = document.createElement("div");
const roamer = new Roamer(box, "cream", { unit: showcase ? ROAM_UNIT * BIG : ROAM_UNIT });
(window as unknown as { __roamer: Roamer }).__roamer = roamer;
const view = new RoamView(document.getElementById("roam")!, box, roamer, {
  onRects: () => {},
  onAction: (a) => act(a),
});
view.onFrame = () => {
  if (roamer.visible) islandEl.classList.add("away");
};
roamer.onHome = () => {
  view.clear();
  islandEl.classList.remove("away");
  islandFace = "happy";
  islandMarsh.react("happy", 900);
};

/** Runs `fn` after `sec` seconds of scene time (real time outside capture mode). */
const queue: { at: number; fn: () => void }[] = [];
function later(sec: number, fn: () => void) {
  if (capture) queue.push({ at: clock + sec, fn });
  else window.setTimeout(fn, sec * 1000);
}

const APPROVAL: RoamRequest = {
  kind: "approval",
  title: "shop · Claude Code ขออนุมัติ",
  text: "npm install zod",
  code: true,
  agent: "claude",
  approvalId: 1,
  createdAt: Date.now(),
  expiresAt: Date.now() + 110_000,
};
const DONE: RoamRequest = {
  kind: "done",
  title: "shop-api · Codex ทำเสร็จแล้ว",
  text: "เพิ่ม test 6 ตัว ผ่านหมด",
  agent: "codex",
};
const ERROR: RoamRequest = {
  kind: "error",
  title: "landing-page · Antigravity เจอปัญหา",
  text: "build ไม่ผ่าน: ไม่พบโมดูล ./Hero",
  agent: "antigravity",
};

let pointer = showcase ? { x: window.innerWidth * 0.8, y: window.innerHeight * 0.32 } : { x: window.innerWidth * 0.7, y: window.innerHeight * 0.62 };

function setIsland(big: boolean, text?: string) {
  islandEl.classList.toggle("big", big);
  if (text) ticker.innerHTML = text;
  const to = big ? CARD : PILL;
  for (const k of Object.keys(to) as IslandKey[]) isl[k].target = to[k];
  // Right away: the hands glide along with the island's edge.
  const n = nest();
  roamer.setNest(n, n.k);
}

const reachParam = params.get("reach");

function send(request: RoamRequest) {
  const req: RoamRequest = { ...request, reach: reachParam === "head" || reachParam === "hand" ? reachParam : request.kind === "done" ? "hand" : "head" };
  if (req.kind === "approval") {
    setIsland(true, "<b>shop</b> · ขออนุมัติ");
    islandFace = "ask";
  } else {
    islandFace = req.kind === "done" ? "done" : "error";
  }
  islandMarsh.setExpression(islandFace);
  // Like the island: wait for it to finish growing, then reach out.
  later(0.46, () => {
    const n = nest();
    roamer.go(n, n.k, pointer, req);
    view.step(0);
    if (!capture) view.start();
  });
}

function act(action: RoamAction) {
  if (action === "open" || action === "dismiss") {
    roamer.request = null;
    roamer.home();
    return;
  }
  if (action === "allow") {
    roamer.celebrate("love");
  } else {
    roamer.request = null;
    roamer.home();
  }
  setIsland(false, "<b>shop</b> · ติดตั้ง zod");
  islandFace = "working";
  islandMarsh.setExpression(islandFace);
}

if (!capture) {
  let last = -1;
  const loop = (ms: number) => {
    stepIsland(last < 0 ? 1 / 60 : Math.min(0.05, (ms - last) / 1000));
    last = ms;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener("mousemove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    roamer.setCursor(pointer);
  });
  document.getElementById("b-approval")!.onclick = () => send(APPROVAL);
  document.getElementById("b-done")!.onclick = () => send(DONE);
  document.getElementById("b-error")!.onclick = () => send(ERROR);
  document.getElementById("b-home")!.onclick = () => roamer.home();
}

// ── The scripted scene ──────────────────────────────────────────────────────────

interface Move {
  at: number;
  dur: number;
  to: () => { x: number; y: number };
  from?: { x: number; y: number };
  target?: { x: number; y: number };
}

const W = window.innerWidth;
const H = window.innerHeight;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function okButton() {
  const b = document.querySelector(".bubble .b-btn.primary")?.getBoundingClientRect();
  return b ? { x: b.left + b.width * 0.45, y: b.top + b.height * 0.55 } : { x: W * 0.5, y: H * 0.5 };
}

const scenes: Record<string, { moves: Move[]; events: { at: number; run: () => void }[]; end: number }> = {
  approval: {
    moves: [
      { at: 3.8, dur: 0.75, to: () => ({ x: W * 0.36, y: H * 0.7 }) },
      { at: 6.6, dur: 0.8, to: okButton },
    ],
    events: [
      { at: 0.4, run: () => send(APPROVAL) },
      { at: 7.7, run: () => click() },
      { at: 7.75, run: () => act("allow") },
    ],
    end: 10.6,
  },
  done: {
    moves: [{ at: 4.0, dur: 0.6, to: () => ({ x: W * 0.3, y: H * 0.74 }) }],
    events: [{ at: 0.4, run: () => send(DONE) }],
    end: 13,
  },
  showcase: {
    moves: [
      { at: 3.3, dur: 0.45, to: () => ({ x: W * 0.2, y: H * 0.34 }) },
      { at: 6.0, dur: 0.45, to: () => ({ x: W * 0.64, y: H * 0.4 }) },
      { at: 8.7, dur: 0.45, to: () => ({ x: W * 0.3, y: H * 0.46 }) },
    ],
    events: [
      {
        at: 0.2,
        run: () => {
          roamer.go({ x: W * 0.5, y: -80 }, 0.5, pointer, { ...APPROVAL, approvalId: 9 });
          view.step(0);
          if (!capture) view.start();
        },
      },
    ],
    end: 11.6,
  },
};

const plan = scenes[scene] ?? scenes.approval;
let ringAt = -10;
let ringPos = { x: 0, y: 0 };
let finishedAt = Infinity;

function click() {
  ringAt = clock;
  ringPos = { ...pointer };
}

function updateCursor() {
  for (const m of plan.moves) {
    if (clock < m.at) continue;
    if (!m.from) {
      m.from = { ...pointer };
      m.target = m.to();
    }
    const u = Math.min(1, (clock - m.at) / m.dur);
    const k = ease(u);
    const bend = Math.sin(Math.PI * u) * 40;
    const dx = m.target!.x - m.from.x;
    const dy = m.target!.y - m.from.y;
    const len = Math.hypot(dx, dy) || 1;
    if (u < 1 || clock - m.at < m.dur + 0.05) {
      pointer = { x: m.from.x + dx * k + (-dy / len) * bend, y: m.from.y + dy * k + (dx / len) * bend };
    }
  }
  roamer.setCursor(pointer);
  cursorEl.style.transform = `translate(${pointer.x - 2}px, ${pointer.y - 2}px)`;
  const r = clock - ringAt;
  if (r >= 0 && r < 0.45) {
    ring.style.opacity = String(1 - r / 0.45);
    ring.style.transform = `translate(${ringPos.x}px, ${ringPos.y}px) scale(${0.6 + r * 1.6})`;
  } else {
    ring.style.opacity = "0";
  }
}

const fired = new Set<number>();
function stepScene(dt: number) {
  clock += dt;
  plan.events.forEach((e, i) => {
    if (clock >= e.at && !fired.has(i)) {
      fired.add(i);
      e.run();
    }
  });
  const due = queue.filter((q) => clock >= q.at);
  for (const q of due) queue.splice(queue.indexOf(q), 1);
  for (const q of due) q.fn();
  updateCursor();
  stepIsland(dt);
  if (roamer.visible) view.step(dt);
  islandMarsh.frame(dt);
  if (!roamer.visible && clock > 2 && finishedAt === Infinity) finishedAt = clock;
}

declare global {
  interface Window {
    __step: (dt: number) => void;
    __state: () => { clock: number; visible: boolean; arrived: boolean; finished: boolean };
  }
}

if (capture) {
  updateCursor();
  stepIsland(0);
  islandMarsh.frame(0);
  window.__step = (dt: number) => stepScene(dt);
  window.__state = () => ({
    clock,
    visible: roamer.visible,
    arrived: roamer.arrived,
    finished: clock >= plan.end || clock > finishedAt + 1.0,
  });
  document.body.dataset.ready = "1";
}
