// Marshmori 3D previews.
//   dev/marsh.html                         a character sheet: shape, stretch, faces, actions
//   dev/marsh.html?view=live&mode=full     one live Marshmori (&expr=… &pose=… &color=…)
//   dev/marsh.html?export=head|full&expr=…&pose=…&size=…&t=…&yaw=…   one still, transparent

import { EXPRESSION_LABELS, EXPRESSIONS, type BadgeKind, type ColorName, type ExpressionName } from "../src/mascot/expressions";
import { Marshmori } from "../src/mascot/marsh";
import { BUDDY_POSES, ELASTIC_POSES, POSE_LABELS, poseTargets, type BuddyPose } from "../src/mascot/buddy";
import { TORSO_HEIGHT } from "../src/mascot/rig";

const params = new URLSearchParams(location.search);
const root = document.getElementById("root")!;
const stage = document.getElementById("stage")!;
const color = (params.get("color") as ColorName) ?? "cream";
if (params.has("light")) document.body.classList.add("light");

function cell(label: string, kind: "head" | "tall" = "head") {
  const c = document.createElement("div");
  c.className = kind === "tall" ? "cell tall" : "cell";
  const canvas = document.createElement("canvas");
  const span = document.createElement("span");
  span.textContent = label;
  c.append(canvas, span);
  return { c, canvas };
}

function copy(from: Marshmori, to: HTMLCanvasElement) {
  to.width = from.gl.width;
  to.height = from.gl.height;
  const ctx = to.getContext("2d")!;
  ctx.drawImage(from.gl, 0, 0);
  if (from.effectsShown) ctx.drawImage(from.fx, 0, 0);
}

/** Frames a full-body still so the whole figure, sprout and long arms included, fits. */
function frameBody(m: Marshmori, w: number, h: number) {
  const head = m.rig.headCenter();
  // Dome and sprout above the head's origin, plus room for the squash-and-stretch.
  const top = (TORSO_HEIGHT + head.y) * Math.max(1, m.rig.squash.value) + 1.55;
  const bottom = -0.2;
  const span = Math.max(3.4, top - bottom);
  const reach = Math.max(Math.abs(m.rig.lHand.value.x), Math.abs(m.rig.rHand.value.x), Math.abs(head.x)) + 0.35;
  const across = Math.max(2.9, reach * 2);
  m.setView({ x: 0, y: (top + bottom) / 2, z: 0 }, Math.min(w / across, h / span));
}

function section(title: string, sub: string) {
  const head = document.createElement("div");
  head.className = "sec";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  const p = document.createElement("p");
  p.textContent = sub;
  head.append(h2, p);
  const grid = document.createElement("div");
  grid.className = "grid";
  root.append(head, grid);
  return grid;
}

if (params.has("export")) {
  document.body.classList.add("export");
  const mode = params.get("export") === "full" ? "full" : "head";
  const size = Number(params.get("size") ?? 360);
  const box = document.createElement("div");
  box.id = "shot";
  const w = size;
  const h = mode === "full" ? Math.round(size * 1.3) : size;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  root.appendChild(box);
  const m = new Marshmori(box, { mode, color, quality: "high", autoStart: false, idle: false, effects: !params.has("noeffects") });
  // &hands=0: just the head (the app icon).
  if (params.get("hands") === "0" && m.model) m.model.hangHands = false;
  const pose = params.get("pose") as BuddyPose | null;
  if (pose) {
    m.poseFor = (t) => poseTargets(pose, t);
    m.rig.snap(poseTargets(pose, 0));
  }
  if (params.has("yaw")) m.yaw.snap(Number(params.get("yaw")));
  if (params.has("look")) {
    const [x, y] = params.get("look")!.split(",").map(Number);
    m.lookAt([x, y]);
  }
  const t = Number(params.get("t") ?? 1.4);
  const expr = (params.get("expr") as ExpressionName) ?? "normal";
  m.renderAt(t, expr);
  if (mode === "full" && params.has("fit")) {
    frameBody(m, w, h);
    m.renderAt(t, expr);
  }
  // &icon: the head and its sprout filling the square, nothing cut off (the app icon).
  if (mode === "head" && params.has("icon")) {
    // &sprout=0.8: a smaller sprout, so the face can be bigger in a small square.
    const k = Number(params.get("sprout") ?? 1);
    if (m.model && k !== 1) m.model.sprout.scale.setScalar(k);
    m.setView({ x: 0, y: 2.22, z: 0 }, (w * 0.86) / 2.3);
    m.renderAt(t, expr);
  }
  // Head only: where the island's edge goes (the hands hang over it).
  (window as unknown as { __lip: number | null }).__lip = mode === "head" ? m.lipOnScreen() : null;
  document.body.dataset.ready = "1";
} else if (params.get("anim") === "moods") {
  // Mamori's moods one after another, with the status bud on its sprout (recordings):
  // window.__step(dt) moves on and draws; body[data-ready] when set up.
  document.body.classList.add("export");
  const size = Number(params.get("size") ?? 320);
  const box = document.createElement("div");
  box.id = "shot";
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  root.appendChild(box);
  const m = new Marshmori(box, { mode: "head", color, quality: "high", autoStart: false, idle: true });
  type Beat = { at: number; expr: ExpressionName; badge?: BadgeKind | null; look?: [number, number] | null };
  const show: Beat[] = [
    { at: 0, expr: "normal", badge: "online", look: [0, 0] },
    { at: 0.8, expr: "normal", badge: "online", look: [-0.85, -0.05] },
    { at: 1.5, expr: "normal", badge: "online", look: [0.85, -0.05] },
    { at: 2.2, expr: "thinking", badge: undefined, look: null },
    { at: 3.9, expr: "working", badge: undefined, look: null },
    { at: 5.6, expr: "ask", badge: undefined, look: [0, 0] },
    { at: 7.4, expr: "done", badge: undefined, look: null },
    { at: 9.0, expr: "adore", badge: null, look: null },
    { at: 10.8, expr: "error", badge: undefined, look: null },
    { at: 12.3, expr: "happy", badge: "online", look: [0, 0] },
  ];
  let clock = 0;
  let beat = -1;
  (window as unknown as { __step: (dt: number) => void }).__step = (dt: number) => {
    clock += dt;
    let next = beat;
    while (next + 1 < show.length && clock >= show[next + 1].at) next++;
    if (next !== beat) {
      beat = next;
      const b = show[beat];
      m.setExpression(b.expr);
      m.setBadge(b.badge);
      if (b.look !== undefined) m.lookAt(b.look);
    }
    m.frame(dt);
  };
  document.body.dataset.ready = "1";
} else if (params.has("anim")) {
  // A scripted little show, stepped frame by frame from outside (recordings):
  // window.__step(dt) moves on and draws; body[data-ready] when set up.
  document.body.classList.add("export");
  const size = Number(params.get("size") ?? 360);
  const box = document.createElement("div");
  box.id = "shot";
  const w = Math.round(size * 1.5);
  const hgt = Math.round(size * 1.6);
  box.style.width = `${w}px`;
  box.style.height = `${hgt}px`;
  root.appendChild(box);
  const m = new Marshmori(box, { mode: "full", color, quality: "high", autoStart: false, idle: false });
  // Room for the Long Neck above and the Long Arms either side.
  m.setView({ x: 0, y: 2.55, z: 0 }, Math.min(w / 6, hgt / 5.9));
  type Beat = { at: number; pose: BuddyPose; expr: ExpressionName; look?: [number, number] | null; yaw?: number };
  const show: Beat[] = [
    { at: 0, pose: "stand", expr: "normal", look: [0, 0] },
    { at: 0.9, pose: "stand", expr: "normal", look: [-0.8, -0.1], yaw: -0.4 },
    { at: 1.8, pose: "stand", expr: "normal", look: [0.8, -0.1], yaw: 0.4 },
    { at: 2.7, pose: "wave", expr: "happy", look: [0, 0], yaw: 0 },
    { at: 4.1, pose: "long", expr: "excited", look: [0, -0.4] },
    { at: 5.3, pose: "superlong", expr: "happy", look: [0.3, -0.2] },
    { at: 6.7, pose: "arms", expr: "happy", look: [0, 0] },
    { at: 8.4, pose: "cheer", expr: "excited", look: null },
    { at: 9.5, pose: "hop", expr: "done", look: null },
    { at: 10.9, pose: "sit", expr: "relaxed", look: null },
    { at: 12.2, pose: "stand", expr: "love", look: [0, 0] },
  ];
  let clock = 0;
  let beat = -1;
  m.poseFor = (t) => poseTargets(show[Math.max(0, beat)].pose, t);
  (window as unknown as { __step: (dt: number) => void }).__step = (dt: number) => {
    clock += dt;
    let next = beat;
    while (next + 1 < show.length && clock >= show[next + 1].at) next++;
    if (next !== beat) {
      beat = next;
      const b = show[beat];
      m.setExpression(b.expr);
      if (b.look !== undefined) m.lookAt(b.look);
      if (b.yaw !== undefined) m.yaw.target = b.yaw;
    }
    m.frame(dt);
  };
  document.body.dataset.ready = "1";
} else if (params.get("view") === "live") {
  const mode = params.get("mode") === "head" ? "head" : "full";
  const box = document.createElement("div");
  box.id = "live";
  root.appendChild(box);
  const m = new Marshmori(box, { mode, color, quality: "high" });
  const pose = params.get("pose") as BuddyPose | null;
  if (pose) m.poseFor = (t) => poseTargets(pose, t);
  m.setExpression((params.get("expr") as ExpressionName) ?? "normal");
  window.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect();
    m.lookAt([((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1]);
  });
  box.addEventListener("click", () => m.poke());
  (window as unknown as { marsh: Marshmori }).marsh = m;
} else {
  const title = document.createElement("header");
  title.innerHTML = "<h1>Marshmori</h1><p>เรียกสั้น ๆ ว่า <b>Mamori</b> — มาร์ชแมลโลว์ตัวน้อยจากผืนป่า (森)</p>";
  root.appendChild(title);
  const shape = section("Core Shape", "รูปทรงหลัก — หน้า ข้าง หลัง");
  const elastic = section("Elastic Body", "ยืดหยุ่นได้ทั้งคอ แขน และขา");
  const faces = section("Expressions", "อารมณ์ต่าง ๆ");
  const actions = section("Actions", "ท่าทาง");

  const W = 150;
  const H = 210;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  void (async () => {
    const bodyBox = document.createElement("div");
    bodyBox.style.cssText = `width:${W}px;height:${H}px`;
    stage.appendChild(bodyBox);
    const body = new Marshmori(bodyBox, { mode: "full", color, quality: "high", autoStart: false, idle: false });
    const still = (grid: HTMLElement, label: string, pose: BuddyPose, expr: ExpressionName, yaw = 0) => {
      const { c, canvas } = cell(label, "tall");
      grid.appendChild(c);
      body.poseFor = (t) => poseTargets(pose, t);
      body.rig.snap(poseTargets(pose, 0));
      body.yaw.snap(yaw);
      body.renderAt(1.4, expr);
      frameBody(body, W, H);
      body.renderAt(1.4, expr);
      copy(body, canvas);
    };
    for (const [label, yaw] of [["Front", 0], ["Side", 0.8], ["Back", Math.PI]] as const) {
      still(shape, label, "stand", "normal", yaw);
      await tick();
    }
    for (const p of ELASTIC_POSES) {
      still(elastic, POSE_LABELS[p], p, p === "superlong" ? "happy" : "normal");
      await tick();
    }

    const headBox = document.createElement("div");
    headBox.style.cssText = "width:150px;height:150px";
    stage.appendChild(headBox);
    const head = new Marshmori(headBox, { mode: "head", color, quality: "high", autoStart: false, idle: false });
    for (const e of EXPRESSIONS) {
      const { c, canvas } = cell(EXPRESSION_LABELS[e]);
      faces.appendChild(c);
      head.renderAt(1.4, e);
      copy(head, canvas);
      await tick();
    }

    for (const p of BUDDY_POSES) {
      const expr: ExpressionName = p === "run" ? "happy" : p === "point" ? "ask" : p === "sit" ? "waiting" : p === "jump" || p === "hop" ? "excited" : p === "wave" ? "happy" : "normal";
      still(actions, POSE_LABELS[p], p, expr, p === "run" ? 1.05 : 0);
      await tick();
    }
    document.body.dataset.ready = "1";
  })();
}
