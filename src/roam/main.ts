// The roam overlay: a transparent window over the island's display, where Mamori's
// head comes over to the mouse pointer on its long neck while its hands keep hold of
// the island. Rust shows it only during a reach and makes it click-through everywhere
// except over Mamori's head and its bubble (roam.rs).

import "./roam.css";

import { api, on } from "../core/ipc";
import { useLook } from "../core/look";
import { configureSound, sound } from "../core/sound";
import { reducedMotion } from "../core/spring";
import { Roamer } from "./roamer";
import { RoamView, type RoamAction } from "./view";

const root = document.getElementById("roam")!;
const box = document.createElement("div");
const roamer = new Roamer(box);
roamer.setReducedMotion(reducedMotion());

/** The trip Rust is running; every message back names it so late ones are ignored. */
let trip = 0;
let reportedShown = 0;
let look: import("../core/types").IslandLook = "auto";
const applyLook = useLook(() => look);

const view = new RoamView(root, box, roamer, {
  onRects: (rects) => void api.roamSetHitRects(rects).catch(() => {}),
  onAction: (action) => void act(action),
});

// The first frame of a trip is on the canvas: now Rust can show the window, and the
// island hides its own Mamori at the same moment.
view.onFrame = () => {
  if (reportedShown !== trip) {
    reportedShown = trip;
    void api.roamShown(trip).catch(() => {});
  }
};

roamer.onArrive = () => sound("pop");
roamer.onHome = () => {
  view.clear();
  void api.roamDone(trip).catch(() => {});
};

async function act(action: RoamAction) {
  const req = roamer.request;
  if (!req) return;
  if (action === "open") {
    void api.roamOpen().catch(() => {});
    roamer.home();
    return;
  }
  if (action === "dismiss") {
    roamer.request = null;
    roamer.home();
    return;
  }
  if (req.kind !== "approval" || req.approvalId == null) return;
  const id = req.approvalId;
  if (action === "allow" || action === "always") {
    roamer.celebrate(action === "always" ? "adore" : "love");
  } else {
    roamer.request = null;
    roamer.marsh.setExpression("normal");
    roamer.home();
  }
  try {
    await api.decide(id, action);
  } catch {
    // Already answered somewhere else (the island, a shortcut, the terminal).
  }
}

async function start() {
  await on.roamGo((go) => {
    trip = go.trip;
    look = go.look ?? "auto";
    applyLook();
    roamer.setColor(go.color);
    view.screen = { w: go.screen.x, h: go.screen.y };
    roamer.screen = view.screen;
    configureSound(go.sound, go.volume);
    roamer.go(go.nest, go.nestScale, go.cursor, go.request);
    // Draw the first frame right now: the window is still hidden, and hidden pages get
    // no animation frames. Rust shows the window when it hears about this frame.
    view.step(0);
    view.start();
  });
  await on.cursor((c) => roamer.setCursor(c));
  await on.roamRecall(() => roamer.home());
  await on.roamNest((n) => roamer.setNest(n.nest, n.nestScale));
  await on.roamAbort(() => {
    roamer.abort();
    view.clear();
  });
  // The card Mamori came about was answered (or gave up): nothing left to say.
  await on.approvals((list) => {
    const req = roamer.request;
    if (req?.kind === "approval" && !list.some((a) => a.id === req.approvalId)) roamer.home();
  });
  await api.roamReady();
}

void start();
