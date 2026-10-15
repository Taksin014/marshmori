// Puts a Roamer on screen: the canvas over the whole overlay (the head, the long
// neck and the hands on the island's edge), the speech bubble next to the head, and
// the click-through rectangles for Rust (only the head and the bubble take clicks).
//
// The bubble pops out of Mamori's head a beat after it lands (once its bump and taps
// are over), grows from its tail, and then follows the head on a soft lag: the head
// keeps tapping and swaying, and a bubble glued to it would shake along.

import { h } from "../core/dom";
import { AGENT_COLORS, type Question } from "../core/types";
import { Roamer, type Box } from "./roamer";

export type RoamAction = "allow" | "always" | "deny" | "open" | "dismiss" | "answer";

export interface ViewHooks {
  onRects: (rects: Box[]) => void;
  /** `answer` is the chosen label, for "answer". */
  onAction: (action: RoamAction, answer?: string) => void;
}

/** Seconds between Mamori landing at the pointer and the bubble popping out. */
const BUBBLE_DELAY = 0.16;
/** How quickly the bubble catches up with the head (1/s): low enough to soak up the taps. */
const FOLLOW = 8;

export class RoamView {
  private readonly bubble: HTMLDivElement;
  private bubbleShown = false;
  private bubbleKey = "";
  private lastRects = "";
  private timerBar: HTMLElement | null = null;
  private away = 1;
  /** Where the bubble is drawn (top left), easing after where it should be. */
  private at: { x: number; y: number } | null = null;
  private lastT = 0;
  /** When Mamori landed at the pointer this time (scene seconds), -1 while it isn't there. */
  private landedAt = -1;
  /** The overlay's size, when the page can't trust its own yet (still hidden). */
  screen: { w: number; h: number } | null = null;
  /** Called after every placed frame (the first one tells Rust it can show the window). */
  onFrame: () => void = () => {};

  constructor(
    root: HTMLElement,
    private readonly box: HTMLElement,
    private readonly roamer: Roamer,
    private readonly hooks: ViewHooks,
  ) {
    box.classList.add("roam-box");
    this.bubble = h("div", { class: "bubble", role: "dialog", "aria-live": "polite" }) as HTMLDivElement;
    root.append(box, this.bubble);
    // The canvas covers everything, so a click is Mamori's only when it lands on the head.
    box.addEventListener("click", (e) => {
      const b = this.roamer.bounds();
      if (e.clientX < b.x || e.clientX > b.x + b.w || e.clientY < b.y || e.clientY > b.y + b.h) return;
      this.roamer.marsh.poke();
      this.hooks.onAction("open");
    });
    roamer.onMoved = () => this.place();
    roamer.onTap = (at) => this.ripple(at.x, at.y);
    window.addEventListener("resize", () => (this.roamer.screen = this.screenSize()));
  }

  private screenSize() {
    return this.screen ?? { w: window.innerWidth, h: window.innerHeight };
  }

  /** The canvas is as big as the overlay (a hidden window may not know its own size yet). */
  private fit() {
    const { w, h } = this.screenSize();
    this.roamer.screen = { w, h };
    const width = `${Math.round(w)}px`;
    const height = `${Math.round(h)}px`;
    if (this.box.style.width !== width || this.box.style.height !== height) {
      this.box.style.width = width;
      this.box.style.height = height;
      this.roamer.marsh.resize();
    }
  }

  /** Starts Mamori's own animation loop (after the first frame is up). */
  start() {
    this.fit();
    this.roamer.marsh.start();
  }

  /** One frame by hand: the first one while the window is still hidden, and captures. */
  step(dt: number) {
    this.fit();
    this.roamer.marsh.frame(dt);
  }

  /** A tap landed here: a soft ring spreads out (the "สะกิด" you feel). */
  private ripple(x: number, y: number) {
    const ring = h("i", { class: "ripple", "aria-hidden": "true" });
    ring.style.left = `${Math.round(x)}px`;
    ring.style.top = `${Math.round(y)}px`;
    this.box.parentElement?.append(ring);
    window.setTimeout(() => ring.remove(), 700);
  }

  /** Hides everything at once (home, or an aborted trip). */
  clear() {
    this.roamer.marsh.stop();
    this.box.style.visibility = "hidden";
    this.showBubble(false);
    this.bubbleKey = "";
    this.at = null;
    this.landedAt = -1;
    this.reportRects([]);
  }

  private place() {
    if (!this.roamer.visible) return;
    this.box.style.visibility = "visible";

    // Only while there's something to say (an answered card hides at once), and a beat
    // after landing, so the bubble comes out of the head once it has settled.
    const t = this.roamer.now;
    if (!this.roamer.arrived) this.landedAt = -1;
    else if (this.landedAt < 0) this.landedAt = t;
    const delay = this.roamer.reducedMotion ? 0 : BUBBLE_DELAY;
    this.showBubble(this.roamer.arrived && this.roamer.request !== null && t - this.landedAt >= delay, t);
    const body = this.roamer.bounds();
    const rects: Box[] = [body];
    const zones: Box[] = [grow(body, 30)];
    if (this.bubbleShown) {
      const r = this.bubble.getBoundingClientRect();
      const b = { x: r.left, y: r.top, w: r.width, h: r.height };
      rects.push(b);
      zones.push(grow(b, 24));
    }
    this.roamer.zones = zones;
    this.reportRects(rects);
    this.updateTimer();
    this.onFrame();
  }

  private reportRects(rects: Box[]) {
    const key = rects.map((r) => `${Math.round(r.x / 4)},${Math.round(r.y / 4)},${Math.round(r.w / 4)},${Math.round(r.h / 4)}`).join("|");
    if (key === this.lastRects) return;
    this.lastRects = key;
    this.hooks.onRects(rects.map((r) => grow(r, 4)));
  }

  private fillBubble() {
    const req = this.roamer.request;
    if (!req) return;
    const key = `${req.kind}|${req.approvalId ?? ""}|${req.title}|${req.text}|${req.code ? 1 : 0}|${req.questions?.length ?? 0}`;
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    const color = req.agent && req.agent in AGENT_COLORS ? AGENT_COLORS[req.agent] : "#30d158";
    const questions = req.kind === "approval" ? req.questions ?? null : null;
    const buttons =
      req.kind === "approval"
        ? [
            h("button", { class: "b-btn", onclick: () => this.hooks.onAction("deny") }, "ไม่อนุญาต"),
            h("button", { class: "b-btn", title: "อนุญาตทุกอย่างที่ขอในรอบนี้ สั่งงานครั้งถัดไปจะถามใหม่", onclick: () => this.hooks.onAction("always") }, "ทั้งรอบ"),
            h("button", { class: "b-btn primary", onclick: () => this.hooks.onAction("allow") }, "อนุญาต"),
            h("button", { class: "b-link", onclick: () => this.hooks.onAction("open") }, "ดูรายละเอียด"),
          ]
        : [
            h("button", { class: "b-btn primary", onclick: () => this.hooks.onAction("open") }, "เปิดดู"),
            h("button", { class: "b-btn", onclick: () => this.hooks.onAction("dismiss") }, req.kind === "error" ? "รับทราบ" : "โอเค"),
          ];
    const actions = questions ? this.questionActions(questions) : [h("div", { class: "b-actions" }, ...buttons)];
    this.timerBar = req.kind === "approval" && req.expiresAt ? h("i") : null;
    this.bubble.className = `bubble kind-${req.kind}${questions ? " question" : ""}${this.bubbleShown ? " show" : ""}`;
    const parts: HTMLElement[] = [h("div", { class: "b-title" }, h("span", { class: "b-dot", style: { background: color } }), req.title)];
    if (req.text) parts.push(h("div", { class: req.code ? "b-text mono" : questions ? "b-text b-question" : "b-text" }, req.text));
    parts.push(...actions);
    if (this.timerBar) parts.push(h("div", { class: "b-timer" }, this.timerBar));
    this.bubble.replaceChildren(...parts);
  }

  /**
   * A question: one with a single choice is answered right here, by its numbered
   * choices (like in Claude Code). Several questions, several choices or your own
   * words need the card at the island.
   */
  private questionActions(questions: Question[]): HTMLElement[] {
    const q = questions[0];
    const open = (label: string) => h("button", { class: "b-link", onclick: () => this.hooks.onAction("open") }, label);
    if (questions.length > 1 || q.multiSelect || !q.options.length) {
      const what = questions.length > 1 ? `ตอบคำถาม (${questions.length} ข้อ)` : q.multiSelect ? "เลือกคำตอบ (ได้หลายข้อ)" : "ตอบคำถาม";
      return [h("div", { class: "b-actions" }, h("button", { class: "b-btn primary", onclick: () => this.hooks.onAction("open") }, what))];
    }
    const shown = q.options.slice(0, 4);
    return [
      h(
        "div",
        { class: "b-opts", role: "radiogroup", "aria-label": q.question },
        ...shown.map((o, i) =>
          h(
            "button",
            { class: "b-opt", role: "radio", "aria-checked": "false", title: o.description || o.label, onclick: () => this.hooks.onAction("answer", o.label) },
            h("span", { class: "b-num" }, String(i + 1)),
            h("span", { class: "b-label" }, o.label),
          ),
        ),
      ),
      h("div", { class: "b-actions end" }, open(q.options.length > shown.length ? "ดูตัวเลือกทั้งหมด" : "พิมพ์คำตอบเอง…")),
    ];
  }

  /** The thin line under an approval: how long before the agent asks in its own window. */
  private updateTimer() {
    const req = this.roamer.request;
    if (!this.timerBar || !req?.expiresAt) return;
    const left = Math.max(0, req.expiresAt - Date.now());
    const total = Math.max(1, req.expiresAt - (req.createdAt ?? req.expiresAt - 110_000));
    this.timerBar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  }

  private showBubble(show: boolean, t = 0) {
    if (show) this.fillBubble();
    const opening = show && !this.bubbleShown;
    if (show !== this.bubbleShown) {
      this.bubbleShown = show;
      // Opens away from the pointer, so it never covers what you were looking at.
      // Decided once per stop: it must not jump while you reach for it.
      if (show) this.away = this.roamer.headCenter().x >= this.roamer.pointer.x ? 1 : -1;
      // Placed first, shown after: the pop starts where the bubble will be, from its tail.
      if (!show) this.bubble.classList.remove("show");
    }
    if (!show) return;
    const anchor = this.roamer.bubbleAnchor();
    const bw = this.bubble.offsetWidth;
    const bh = this.bubble.offsetHeight;
    const { w: W, h: H } = this.screenSize();
    let left = this.away > 0 ? anchor.x - 40 : anchor.x + 40 - bw;
    left = Math.max(8, Math.min(W - bw - 8, left));
    let top = anchor.y - bh - 16;
    let below = false;
    if (top < 8) {
      below = true;
      const b = this.roamer.bounds();
      top = Math.min(H - bh - 8, b.y + b.h + 10);
    }
    // Eases after the head instead of being glued to it: its taps and its sway don't
    // shake the bubble, and a bubble that grows or flips below slides over smoothly.
    const dt = Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (opening || !this.at || this.roamer.reducedMotion) {
      this.at = { x: left, y: top };
    } else {
      const k = 1 - Math.exp(-dt * FOLLOW);
      this.at.x += (left - this.at.x) * k;
      this.at.y += (top - this.at.y) * k;
    }
    const tail = Math.max(22, Math.min(bw - 22, anchor.x - this.at.x));
    this.bubble.classList.toggle("below", below);
    this.bubble.style.transform = `translate3d(${this.at.x.toFixed(1)}px, ${this.at.y.toFixed(1)}px, 0)`;
    this.bubble.style.setProperty("--tail", `${tail.toFixed(1)}px`);
    // It grows out of its tail, the spot next to Mamori's head.
    this.bubble.style.transformOrigin = `${tail.toFixed(1)}px ${below ? 0 : bh}px`;
    if (opening) this.bubble.classList.add("show");
  }
}

function grow(b: Box, m: number): Box {
  return { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
}
