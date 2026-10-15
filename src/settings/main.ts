// The settings window: the island, Mamori, approvals, connecting the agents, the
// keyless chat (through the agents' own signed-in CLIs), and about.

import "./settings.css";

import { api, errorText, on } from "../core/ipc";
import { h, icon } from "../core/dom";
import { configureSound, sound } from "../core/sound";
import {
  AGENT_COLORS,
  ISLAND_BOUNCE_LABELS,
  ISLAND_LOOK_LABELS,
  ISLAND_LOOKS,
  PROVIDER_LABELS,
  REACH_WITH_LABELS,
  type AppInfo,
  type ChatProviderSetting,
  type ColorName,
  type HookStatus,
  type IslandBounce,
  type IslandLook,
  type ProviderStatus,
  type ReachWith,
  type Settings,
} from "../core/types";
import { Buddy } from "../mascot/buddy";
import { BADGE_COLORS, BADGE_LABELS, COLOR_LABELS, COLOR_NAMES, SKIN, type BadgeKind, type ExpressionName } from "../mascot/expressions";
import { Marshmori } from "../mascot/marsh";

type Tab = "welcome" | "general" | "mamori" | "approvals" | "agents" | "chat" | "about";

const TABS: { id: Tab; label: string; icon: string; color: string }[] = [
  { id: "welcome", label: "เริ่มต้นใช้งาน", icon: "spark", color: "#ff7a59" },
  { id: "general", label: "ทั่วไป", icon: "settings", color: "#8e8e93" },
  { id: "mamori", label: "Mamori", icon: "spark", color: "#8ca662" },
  { id: "approvals", label: "การอนุมัติ", icon: "check", color: "#ff9500" },
  { id: "agents", label: "เชื่อมต่อ agent", icon: "agent", color: "#007aff" },
  { id: "chat", label: "แชท", icon: "chat", color: "#34c759" },
  { id: "about", label: "เกี่ยวกับ", icon: "alert", color: "#8e8e93" },
];

const tabsEl = document.getElementById("tabs")!;
const content = document.getElementById("content")!;
const brand = new Marshmori(document.getElementById("brand-mascot")!, { mode: "head", quality: "high" });

const state = {
  tab: "general" as Tab,
  settings: null as Settings | null,
  hooks: [] as HookStatus[],
  providers: [] as ProviderStatus[],
  providersLoading: false,
  info: null as AppInfo | null,
  messages: {} as Record<string, { text: string; kind: "ok" | "bad" | "warn" }>,
  /** "เชื่อมต่อทั้งหมด" is running. */
  connecting: false,
};

/** Mamori's preview stays alive between renders (it's a WebGL scene). */
const previewEl = h("div", { class: "stage-mascot" });
let preview: Buddy | null = null;

function mascot(): string {
  return state.settings?.mascotName || "Mamori";
}

// ── Saving ─────────────────────────────────────────────────────────────────────

let saveTimer = 0;
function update(patch: Partial<Settings>, delay = 0) {
  if (!state.settings) return;
  state.settings = { ...state.settings, ...patch };
  applyLocal(state.settings);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      state.settings = await api.saveSettings(state.settings!);
    } catch (err) {
      flash("save", errorText(err), "bad");
    }
  }, delay);
}

function applyLocal(s: Settings) {
  brand.setColor(s.color);
  preview?.setColor(s.color);
  configureSound(s.sound, s.volume);
}

function flash(key: string, text: string, kind: "ok" | "bad" | "warn") {
  state.messages[key] = { text, kind };
  render();
}

function message(key: string) {
  const m = state.messages[key];
  return m ? h("div", { class: `msg ${m.kind}` }, m.text) : null;
}

// ── Small builders ─────────────────────────────────────────────────────────────

let uid = 0;

function row(label: string, sub: string | null, control: Node | null, extra: Record<string, unknown> = {}) {
  return h("div", { class: "row", ...extra }, h("div", { class: "label" }, h("div", null, label), sub ? h("div", { class: "sub" }, sub) : null), control);
}

function toggleRow(label: string, sub: string | null, checked: boolean, onChange: (v: boolean) => void) {
  const id = `t${++uid}`;
  const input = h("input", { type: "checkbox", class: "switch", id, role: "switch", "aria-label": label }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("div", { class: "row" }, h("label", { class: "label", for: id }, h("div", null, label), sub ? h("div", { class: "sub" }, sub) : null), input);
}

function segmented<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void): HTMLElement {
  const seg = h("div", { class: "seg", role: "group", "aria-label": label });
  for (const [v, text] of options) {
    seg.append(
      h(
        "button",
        {
          "aria-pressed": v === value ? "true" : "false",
          onclick: () => {
            onChange(v);
            render();
          },
        },
        text,
      ),
    );
  }
  return seg;
}

function group(title: string | null, rows: (Node | null)[], foot?: string | Node | null): Node[] {
  return [
    title ? h("div", { class: "group-title" }, title) : null,
    h("div", { class: "group" }, ...rows),
    foot ? h("div", { class: "group-foot" }, foot) : null,
  ].filter(Boolean) as Node[];
}

function page(title: string, lead: string | null, ...children: (Node | Node[] | null)[]): HTMLElement {
  return h("div", { class: "page" }, h("h1", null, title), lead ? h("p", { class: "lead" }, lead) : null, ...children);
}

// ── The island's look: little pictures, like the Appearance picker on a Mac ──────

/** A small still of Mamori for the pictures (made once per colour). */
const lookFaces = new Map<string, string>();
function lookFace(color: ColorName): string {
  let url = lookFaces.get(color);
  if (url === undefined) {
    try {
      url = Marshmori.avatars([{ color, expr: "normal" }], 64).get(`${color}|normal`) ?? "";
    } catch {
      url = "";
    }
    lookFaces.set(color, url);
  }
  return url;
}

function lookPicker(s: Settings): HTMLElement {
  const face = lookFace(s.color);
  const picture = (look: IslandLook) =>
    h(
      "span",
      { class: `look-pic look-${look}`, "aria-hidden": "true" },
      h(
        "span",
        { class: "look-island" },
        face ? h("img", { src: face, alt: "", draggable: "false" }) : h("b", null),
        h("i", null),
        h("i", { class: "short" }),
      ),
      h("span", { class: "look-card" }, h("span", { class: "look-niche" }), h("i", null), h("i", { class: "short" })),
    );
  return h(
    "div",
    { class: "looks", role: "radiogroup", "aria-label": "หน้าตาแถบด้านบน" },
    ...ISLAND_LOOKS.map((look) =>
      h(
        "button",
        {
          class: "look",
          role: "radio",
          "aria-checked": s.islandLook === look ? "true" : "false",
          onclick: () => {
            update({ islandLook: look });
            render();
          },
        },
        picture(look),
        h("span", { class: "look-name" }, ISLAND_LOOK_LABELS[look]),
      ),
    ),
  );
}

// ── Pages ──────────────────────────────────────────────────────────────────────

function seconds(ms: number): string {
  return ms === 0 ? "ทันที" : `${(ms / 1000).toFixed(1)} วินาที`;
}

function generalPage(s: Settings): HTMLElement {
  const delayLabel = h("span", { class: "value" }, seconds(s.hoverDelay));
  const delay = h("input", { type: "range", min: 0, max: 3000, step: 100, "aria-label": "หน่วงก่อนแสดง" }) as HTMLInputElement;
  delay.value = String(s.hoverDelay);
  delay.addEventListener("input", () => {
    delayLabel.textContent = seconds(Number(delay.value));
    update({ hoverDelay: Number(delay.value) }, 250);
  });
  const vol = h("input", { type: "range", min: 0, max: 1, step: 0.05, "aria-label": "ความดัง" }) as HTMLInputElement;
  vol.value = String(s.volume);
  vol.addEventListener("input", () => update({ volume: Number(vol.value) }, 250));
  vol.addEventListener("change", () => sound("pop"));
  return page(
    "ทั่วไป",
    null,
    group(
      "หน้าตาแถบด้านบน",
      [lookPicker(s)],
      `ตามระบบ: สว่างหรือมืดตามโหมดของ Windows · เข้ม: ${mascot()} เด่นที่สุด · ป่ากับมิดไนท์: ธีมสีเข้มโทนเขียวและน้ำเงิน`,
    ),
    group(
      "แถบด้านบนจอ",
      [
        toggleRow("ซ่อนเมื่อไม่มีอะไรเกิดขึ้น", `เลื่อนเมาส์ขึ้นไปที่ขอบบนกลางจอ แล้ว ${mascot()} จะโผล่มาทักทาย`, s.autoHide, (v) => update({ autoHide: v })),
        row(
          "หน่วงก่อนแสดง",
          `ต้องวางเมาส์ค้างไว้นานเท่านี้ ${mascot()} ถึงจะโผล่หรือแถบถึงจะขยาย — เลื่อนเมาส์ผ่านเร็ว ๆ จะได้กดของที่อยู่ใต้แถบได้`,
          h("div", { class: "range-row" }, delay, delayLabel),
        ),
        row(
          "การขยาย",
          "ตอนแถบค่อย ๆ ขยายออก: นุ่ม ๆ = แทบไม่เด้ง · ดึ๋ง = เด้งแล้วกระเพื่อมกลับนิดหนึ่ง · ดึ๋งมาก = เด้งดึ๋ง ๆ หลายที",
          segmented<IslandBounce>(
            "การขยาย",
            s.islandBounce ?? "boing",
            (["soft", "boing", "extra"] as IslandBounce[]).map((k) => [k, ISLAND_BOUNCE_LABELS[k]]),
            (v) => update({ islandBounce: v }),
          ),
        ),
        row(
          "หน้าจอ",
          "ใช้กับตอนเปิด Marshmori",
          segmented("หน้าจอ", s.screen, [
            ["primary", "จอหลัก"],
            ["cursor", "จอที่เมาส์อยู่"],
          ], (v) => update({ screen: v })),
        ),
        toggleRow("หลบตอนเปิดแอปเต็มจอ", "เช่นเกม วิดีโอ หรือสไลด์", s.hideInFullscreen, (v) => update({ hideInFullscreen: v })),
      ],
    ),
    group("เสียง", [
      toggleRow("เสียงเล็ก ๆ ของ " + mascot(), "ตอนขออนุมัติ งานเสร็จ และเวลาทักทาย", s.sound, (v) => update({ sound: v })),
      row("ความดัง", null, vol),
    ]),
    group("ระบบ", [
      toggleRow("เปิดพร้อม Windows", null, s.autostart, (v) => update({ autostart: v })),
      toggleRow(
        `เมนู “สั่งงาน ${mascot()} ที่นี่” ในโฟลเดอร์`,
        "คลิกขวาที่โฟลเดอร์ (หรือที่ว่างในโฟลเดอร์) ใน Explorer แล้วสั่งงานในโฟลเดอร์นั้นได้เลย — บน Windows 11 อยู่ใน “Show more options”",
        s.folderMenu ?? true,
        (v) => update({ folderMenu: v }),
      ),
      toggleRow("แจ้งเตือนของ Windows", `ใช้ตอนมองไม่เห็น ${mascot()} เช่นตอนเปิดเกมเต็มจอ`, s.toasts, (v) => update({ toasts: v })),
    ]),
    message("save"),
  );
}

function ensurePreview(s: Settings) {
  if (!preview) {
    preview = new Buddy(previewEl, { color: s.color, idle: true });
    preview.setExpression("happy");
  }
}

// ── Welcome: the first thing after installing ──────────────────────────────────

async function connectAll() {
  state.connecting = true;
  render();
  try {
    const results = await api.installAllHooks();
    const bad = results.filter(([, r]) => r.Err);
    if (!results.length) flash("welcome", "agent ที่พบในเครื่องเชื่อมต่อไว้ครบแล้ว", "ok");
    else if (bad.length) flash("welcome", bad.map(([a, r]) => `${a}: ${r.Err}`).join(" · "), "warn");
    else flash("welcome", `เชื่อมต่อแล้ว ${results.length} ตัว — เปิด session ใหม่ของแต่ละตัวเพื่อเริ่มใช้`, "ok");
    preview?.marsh.react("excited", 1400);
    sound("done");
  } catch (err) {
    flash("welcome", errorText(err), "bad");
  }
  state.connecting = false;
  await refreshHooks();
}

function welcomePage(s: Settings): HTMLElement {
  ensurePreview(s);
  const found = state.hooks.filter((h) => h.detected || h.installed);
  const pending = found.filter((h) => !(h.installed && h.upToDate));
  const agentRows = state.hooks.map((st) => {
    const badge =
      st.installed && st.upToDate
        ? h("span", { class: "badge ok" }, "เชื่อมต่อแล้ว")
        : st.installed
          ? h("span", { class: "badge warn" }, "ต้องอัปเดต")
          : st.detected
            ? h("span", { class: "badge off" }, "พร้อมเชื่อมต่อ")
            : h("span", { class: "badge off" }, "ไม่พบในเครื่อง");
    return h(
      "div",
      { class: "row" },
      h("span", { class: "dot", style: { background: AGENT_COLORS[st.agent] } }),
      h("div", { class: "label" }, h("div", null, h("b", null, st.label)), h("div", { class: "sub" }, st.installed ? st.note : st.detected ? "กดเชื่อมต่อด้านล่าง" : "ติดตั้งโปรแกรมนี้ก่อน แล้วกลับมากดเชื่อมต่อ")),
      badge,
    );
  });
  const connect = h(
    "button",
    { class: "btn filled big", disabled: state.connecting || (!pending.length && found.length > 0), onclick: () => void connectAll() },
    state.connecting ? "กำลังเชื่อมต่อ…" : pending.length ? `เชื่อมต่อทั้งหมด (${pending.length})` : found.length ? "เชื่อมต่อครบแล้ว" : "ยังไม่พบ agent",
  );
  const hero = h(
    "div",
    { class: "welcome-hero" },
    previewEl,
    h(
      "div",
      { class: "welcome-text" },
      h("h1", null, `สวัสดี! ${mascot()} พร้อมแล้ว`),
      h(
        "p",
        { class: "lead" },
        `${mascot()} จะนั่งอยู่ที่ขอบบนกลางจอ คอยบอกว่า Claude Code, Codex และ Antigravity ทำอะไรอยู่ ยืดคอมาสะกิดเมื่อมีเรื่องให้ตัดสินใจ และรับงานไปสั่ง agent ทำให้เบื้องหลังได้ด้วย`,
      ),
    ),
  );
  return h(
    "div",
    { class: "page welcome" },
    hero,
    ...group("1 · เชื่อมต่อ agent", [...agentRows, h("div", { class: "row center" }, connect)], "Marshmori เพิ่มแค่ hooks ของตัวเองลงในไฟล์ตั้งค่าของแต่ละโปรแกรม สำรองไฟล์เดิมไว้ทุกครั้ง และถอดออกให้เองเมื่อถอนการติดตั้ง"),
    message("welcome"),
    ...group("2 · ให้พร้อมทุกครั้งที่เปิดเครื่อง", [
      toggleRow("เปิดพร้อม Windows", `${mascot()} จะรออยู่ที่ขอบจอทุกครั้งที่เข้าเครื่อง`, s.autostart, (v) => update({ autostart: v })),
      toggleRow(
        `เมนู “สั่งงาน ${mascot()} ที่นี่” ในโฟลเดอร์`,
        "คลิกขวาที่โฟลเดอร์ใน Explorer แล้วสั่งงานในโฟลเดอร์นั้นได้ทันที",
        s.folderMenu ?? true,
        (v) => update({ folderMenu: v }),
      ),
      toggleRow(`กดอนุมัติจาก ${mascot()}`, "ใช้ได้ทั้งใน terminal และในแผงของ VS Code", s.approvals, (v) => update({ approvals: v })),
    ]),
    ...group("3 · ลองเลย", [
      row(`ดู ${mascot()} ทำงาน`, "จำลอง agent สามตัวและการ์ดขออนุมัติหนึ่งใบ ไม่มีอะไรรันจริง", h("button", { class: "btn", onclick: () => void api.demo() }, "ดูตัวอย่าง")),
      row(`ให้ ${mascot()} มาสะกิด`, "เลื่อนเมาส์ออกห่างจากขอบบนก่อนกด", h("button", { class: "btn", onclick: () => void api.roamTest().catch(() => {}) }, "ลองให้มาสะกิด")),
      row("สั่งงานแรก", `กด “สั่งงาน” บนแถบด้านบน หรือลากโฟลเดอร์มาวางที่ ${mascot()}`, null),
    ]),
    h(
      "div",
      { class: "welcome-done" },
      h(
        "button",
        {
          class: "btn filled big",
          onclick: () => {
            sound("pop");
            void api.closeSettings().catch(() => window.close());
          },
        },
        "เริ่มใช้งาน",
      ),
    ),
  );
}

function mamoriPage(s: Settings): HTMLElement {
  ensurePreview(s);
  const nameInput = h("input", { type: "text", maxlength: 24, spellcheck: "false", "aria-label": "ชื่อเรียก" }) as HTMLInputElement;
  nameInput.value = s.mascotName;
  nameInput.addEventListener("change", () => {
    update({ mascotName: nameInput.value.trim() || "Mamori" });
    render();
  });
  const swatches = h(
    "div",
    { class: "swatches", role: "radiogroup", "aria-label": "สี" },
    ...COLOR_NAMES.map((c: ColorName) =>
      h("button", {
        class: "swatch",
        role: "radio",
        title: COLOR_LABELS[c],
        "aria-label": COLOR_LABELS[c],
        "aria-checked": s.color === c ? "true" : "false",
        style: { background: SKIN[c] },
        onclick: () => {
          update({ color: c });
          preview?.marsh.react("happy", 900);
          render();
        },
      }),
    ),
  );
  const tryRun = h(
    "button",
    {
      class: "btn filled",
      onclick: async () => {
        try {
          await api.roamTest();
          flash("roam", s.reachWith === "head" ? `${mascot()} กำลังยืดคอไปสะกิดที่เมาส์ของคุณ` : `${mascot()} กำลังยื่นมือไปสะกิดที่เมาส์ของคุณ`, "ok");
        } catch (err) {
          flash("roam", errorText(err), "warn");
        }
      },
    },
    "ลองให้มาสะกิด",
  );
  const stage = h(
    "div",
    { class: "stage" },
    h("div", { class: "stage-name" }, h("b", null, mascot()), "Marshmori · มาร์ชแมลโลว์จากผืนป่า"),
    previewEl,
    h(
      "div",
      { class: "stage-actions" },
      h("button", { class: "btn", onclick: () => preview?.setPose("wave") }, "โบกมือ"),
      h("button", { class: "btn", onclick: () => preview?.setPose("hop") }, "ดีใจ"),
      h("button", { class: "btn", onclick: () => preview?.setPose("long") }, "ยืดคอ"),
      h("button", { class: "btn", onclick: () => preview?.setPose("arms") }, "แขนยาว"),
      h(
        "button",
        {
          class: "btn",
          onclick: () => {
            preview?.poke();
            sound("pop");
          },
        },
        "จิ้ม",
      ),
    ),
  );
  // A pose from the buttons plays for a moment, then back to standing.
  stage.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".btn")) {
      clearTimeout(poseTimer);
      poseTimer = window.setTimeout(() => preview?.setPose("stand"), 2600);
    }
  });
  // Each state's face and the bud on its sprout (the same ones the island shows).
  const moods: { label: string; expr: ExpressionName; badge?: BadgeKind }[] = [
    { label: BADGE_LABELS.thinking, expr: "thinking", badge: "thinking" },
    { label: BADGE_LABELS.working, expr: "working", badge: "working" },
    { label: BADGE_LABELS.ask, expr: "ask", badge: "ask" },
    { label: BADGE_LABELS.waiting, expr: "waiting", badge: "waiting" },
    { label: BADGE_LABELS.done, expr: "done", badge: "done" },
    { label: BADGE_LABELS.error, expr: "error", badge: "error" },
    { label: "หลงรัก", expr: "adore" },
    { label: "ง่วง", expr: "sleepy" },
  ];
  const moodStrip = h(
    "div",
    { class: "mood-strip", role: "group", "aria-label": "อารมณ์และป้ายสถานะ" },
    ...moods.map((m) =>
      h(
        "button",
        {
          class: "mood-chip",
          onclick: () => {
            preview?.setExpression(m.expr);
            clearTimeout(moodTimer);
            moodTimer = window.setTimeout(() => preview?.setExpression("happy"), 3600);
          },
        },
        m.badge
          ? h("span", { class: "bud", style: { background: BADGE_COLORS[m.badge] } })
          : m.expr === "adore"
            ? h("span", { class: "bud heart" })
            : h("span", { class: "bud sleep" }, "z"),
        m.label,
      ),
    ),
  );
  return page(
    "Mamori",
    `ชื่อเต็ม Marshmori — มาร์ชแมลโลว์ (marsh) กับป่า (森 mori) เรียกสั้น ๆ ว่า Mamori`,
    stage,
    group(
      "อารมณ์และป้ายสถานะ",
      [moodStrip],
      `ดอกตูมสีเล็ก ๆ บนยอดต้นกล้าบอกว่าตอนนี้เป็นยังไง — คิดอยู่ ทำงาน รอคุณ เสร็จแล้ว หรือมีปัญหา ขอบตัว ${mascot()} ก็เรืองแสงเป็นสีเดียวกัน วาดสด ๆ ด้วยโค้ดทั้งหมด ไม่มีภาพหรือวิดีโอ`,
    ),
    group("ตัวละคร", [row("ชื่อเรียก", "ใช้ในแถบด้านบนจอ แชท และหน้านี้", nameInput), row("สี", null, swatches)]),
    group(
      "มาสะกิดบอก",
      [
        row(
          "เมื่อไหร่",
          null,
          segmented("เมื่อไหร่", s.roam, [
            ["all", "ทุกเรื่อง"],
            ["approvals", "เฉพาะขออนุมัติ"],
            ["off", "ปิด"],
          ], (v) => update({ roam: v })),
        ),
        row(
          "สะกิดด้วย",
          "ตามเรื่อง: ยื่นหัวมาถามเมื่อต้องตัดสินใจหรือมีปัญหา ยื่นมือมาแตะเมื่องานเสร็จ",
          segmented<ReachWith>("สะกิดด้วย", s.reachWith ?? "auto", (["auto", "head", "hand"] as ReachWith[]).map((k) => [k, REACH_WITH_LABELS[k]]), (v) => update({ reachWith: v })),
        ),
        row(`ลองให้ ${mascot()} มาสะกิด`, "เลื่อนเมาส์ออกห่างจากแถบด้านบนก่อนกด", tryRun),
        toggleRow("ตามองตามเมาส์", null, s.eyesFollow, (v) => update({ eyesFollow: v })),
      ],
      `เวลา agent ขออนุมัติ ทำงานเสร็จ หรือเจอปัญหา แล้วเมาส์อยู่ไกลจากแถบด้านบน ${mascot()} จะเกาะขอบแถบไว้แล้วยืดคอหรือยื่นมือยาว ๆ มาสะกิดถึงข้างเมาส์ ตอบได้จากตรงนั้นเลย`,
    ),
    message("roam"),
  );
}
let poseTimer = 0;
let moodTimer = 0;

function approvalsPage(s: Settings): HTMLElement {
  const label = h("span", { class: "value" }, `${s.approvalTimeout} วินาที`);
  const range = h("input", { type: "range", min: 20, max: 590, step: 10, "aria-label": "เวลารอ" }) as HTMLInputElement;
  range.value = String(s.approvalTimeout);
  range.addEventListener("input", () => {
    label.textContent = `${range.value} วินาที`;
    update({ approvalTimeout: Number(range.value) }, 300);
  });
  return page(
    "การอนุมัติ",
    `เมื่อ agent ขอรันคำสั่งหรือแก้ไฟล์ ${mascot()} จะเปิดการ์ดให้กดอนุมัติจากด้านบนจอ ใช้ได้กับ Claude Code (ทั้งใน terminal และในแผงของ VS Code / Cursor), Codex และ Antigravity`,
    group("การ์ดขออนุมัติ", [
      toggleRow(`ถามอนุมัติที่ ${mascot()}`, `ปิดไว้ = agent ถามในหน้าจอของมันเองตามปกติ และ ${mascot()} แค่แจ้งเตือน`, s.approvals, (v) => update({ approvals: v })),
      row("รอคำตอบนานสุด", "ถ้าไม่ตอบในเวลานี้ agent จะกลับไปถามในหน้าจอของมันเอง", h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, range, label)),
      toggleRow("คีย์ลัด Ctrl+Alt+Y / Ctrl+Alt+N", "ตอบการ์ดใบหน้าสุดได้จากทุกที่ ใช้ได้เฉพาะตอนมีการ์ดรออยู่", s.shortcuts, (v) => update({ shortcuts: v })),
      toggleRow(
        "ถามก่อน Antigravity รันคำสั่ง",
        "Antigravity มีหน้าถามของมันเองอยู่แล้ว เปิดไว้ถ้าอยากกดอนุญาตจากด้านบนจอแทน",
        s.antigravityApprovals,
        (v) => update({ antigravityApprovals: v }),
      ),
    ]),
    group(
      "อนุญาตทั้งรอบนี้",
      [
        row(
          "กดครั้งเดียว ผ่านทั้งรอบ",
          `agent ตัวนั้นจะทำต่อได้ทุกอย่างที่ขอในงานรอบนี้โดยไม่ต้องถามอีก พอคุณสั่งงานครั้งถัดไปก็จะกลับมาถามตามปกติ ยกเลิกก่อนจบรอบได้ที่การ์ดของ session นั้น`,
          null,
        ),
      ],
    ),
  );
}

function agentGroup(st: HookStatus): Node[] {
  const badge =
    !st.detected && !st.installed
      ? h("span", { class: "badge off" }, "ไม่พบในเครื่อง")
      : st.installed && st.upToDate
        ? h("span", { class: "badge ok" }, "เชื่อมต่อแล้ว")
        : st.installed
          ? h("span", { class: "badge warn" }, "ต้องอัปเดต")
          : h("span", { class: "badge off" }, "ยังไม่ได้เชื่อมต่อ");
  const act = async (fn: () => Promise<string>) => {
    try {
      flash(st.agent, await fn(), "ok");
    } catch (err) {
      flash(st.agent, errorText(err), "bad");
    }
    await refreshHooks();
  };
  const buttons = h(
    "div",
    { style: { display: "flex", gap: "8px" } },
    h(
      "button",
      { class: "btn filled", disabled: !st.relayReady, onclick: () => act(() => api.installHooks(st.agent)) },
      st.installed ? (st.upToDate ? "ติดตั้งซ้ำ" : "อัปเดต") : "เชื่อมต่อ",
    ),
    st.installed ? h("button", { class: "btn danger", onclick: () => act(() => api.uninstallHooks(st.agent)) }, "ถอด") : null,
  );
  const rows: (Node | null)[] = [
    h("div", { class: "row" }, h("span", { class: "dot", style: { background: AGENT_COLORS[st.agent] } }), h("div", { class: "label" }, h("div", null, h("b", null, st.label))), badge),
    row(st.note, null, null),
    h("div", { class: "row" }, h("div", { class: "label" }, h("div", { class: "mono" }, st.configPath)), buttons),
  ];
  const out = group(null, rows);
  if (st.error) out.push(h("div", { class: "msg bad" }, st.error));
  const m = message(st.agent);
  if (m) out.push(m);
  out.push(h("div", { style: { height: "14px" } }));
  return out;
}

function agentsPage(): HTMLElement {
  const relayMissing = state.hooks.length > 0 && !state.hooks[0].relayReady;
  return page(
    "เชื่อมต่อ agent",
    `Marshmori เชื่อมต่อ Claude Code, Codex และ Antigravity ที่เจอในเครื่องให้เองตอนเปิด เพื่อให้บอกสถานะกับ ${mascot()} และกดอนุมัติจาก ${mascot()} ได้ (ตัวที่คุณกดถอดเองจะไม่ถูกเชื่อมกลับ) — เพิ่มแค่ hooks ของตัวเองลงในไฟล์ตั้งค่าของแต่ละโปรแกรม และสำรองไฟล์เดิมไว้ทุกครั้ง งานที่ยังไม่มี hooks (เช่นใน Antigravity IDE) ${mascot()} ก็ยังเห็นจากบันทึกการทำงานของ agent แต่กดอนุมัติแทนไม่ได้`,
    relayMissing ? h("div", { class: "msg warn" }, "ไม่พบตัวส่งต่อ marshmori-hook — ถ้ารันจากซอร์สโค้ด ให้รัน npm run hook ก่อน แล้วเปิด Marshmori ใหม่") : null,
    ...state.hooks.map(agentGroup),
    group("ลองดู", [
      row(`ดู ${mascot()} ทำงาน`, "จำลอง session ของทั้งสาม agent และการ์ดขออนุมัติหนึ่งใบ ไม่มีอะไรรันจริง", h("button", { class: "btn", onclick: () => void api.demo() }, "เริ่มเดโม")),
    ]),
  );
}

function providerRow(p: ProviderStatus | null, value: ChatProviderSetting, s: Settings): HTMLElement {
  const selected = s.chatProvider === value;
  const ready = value === "auto" || (p?.installed ?? false);
  let sub: string;
  let badge: HTMLElement | null = null;
  if (value === "auto") {
    const first = state.providers.find((x) => x.installed);
    sub = first ? `ตอนนี้จะใช้ ${first.label}` : state.providersLoading ? "กำลังตรวจ…" : "ยังไม่พบ CLI ที่ใช้ได้";
  } else if (!p) {
    sub = state.providersLoading ? "กำลังตรวจ…" : "";
  } else {
    sub = p.detail;
    if (!p.installed) badge = h("span", { class: "badge off" }, "ไม่พบ");
    else if (p.signedIn === false) badge = h("span", { class: "badge warn" }, "ยังไม่ล็อกอิน");
    else if (p.billed) badge = h("span", { class: "badge warn" }, "API key");
    else if (p.signedIn) badge = h("span", { class: "badge ok" }, "พร้อม");
    else badge = h("span", { class: "badge ok" }, "ติดตั้งแล้ว");
  }
  return h(
    "button",
    {
      class: "row choice",
      role: "radio",
      "aria-checked": selected ? "true" : "false",
      disabled: !ready,
      onclick: () => {
        update({ chatProvider: value });
        render();
      },
    },
    h("span", { class: "check" }, selected ? icon("check", 18) : null),
    h("div", { class: "label" }, h("div", null, value === "auto" ? "อัตโนมัติ" : PROVIDER_LABELS[value]), sub ? h("div", { class: "sub" }, sub) : null),
    badge,
  );
}

function chatPage(s: Settings): HTMLElement {
  const byId = new Map(state.providers.map((p) => [p.id, p] as const));
  const rows = [
    providerRow(null, "auto", s),
    ...(["claude", "codex", "antigravity", "gemini"] as const).map((id) => providerRow(byId.get(id) ?? null, id, s)),
  ];
  const refresh = h(
    "button",
    { class: "btn", disabled: state.providersLoading, onclick: () => void loadProviders(true) },
    state.providersLoading ? "กำลังตรวจ…" : "ตรวจใหม่",
  );
  return page(
    "แชท",
    `${mascot()} ตอบผ่าน CLI ของ agent ที่คุณล็อกอินไว้แล้ว — ไม่ต้องใส่ API key และไม่เสียเครดิต API เพิ่ม ข้อความนับรวมในโควตาแพ็กเกจเดิมของตัวนั้น (เหมือนพิมพ์ในหน้าต่างของมันเอง)`,
    h("div", { role: "radiogroup", "aria-label": "ผู้ตอบ" }, ...group("ผู้ตอบ", rows, h("span", null, "ตัวที่มีป้าย “API key” ล็อกอินด้วย API key อยู่ — ข้อความจะถูกคิดเงินตามการใช้งาน ถ้าไม่อยากเสียเงินเพิ่ม ให้ล็อกอินด้วยบัญชีแพ็กเกจแทน"))),
    group(
      "ติดตั้งและล็อกอิน",
      [
        row("Claude Code", "ติดตั้งแล้วพิมพ์ claude ใน terminal เพื่อล็อกอินด้วยบัญชี Claude", null),
        row("Codex", "ติดตั้งแล้วพิมพ์ codex login เพื่อล็อกอินด้วยบัญชี ChatGPT", null),
        row("Antigravity / Gemini CLI", "ติดตั้งแล้วเปิด agy หรือ gemini หนึ่งครั้งเพื่อล็อกอินด้วยบัญชี Google", null),
        row("ตรวจหาอีกครั้ง", "หลังติดตั้งหรือล็อกอินใหม่", refresh),
      ],
      `ระหว่างแชท ${mascot()} อ่านได้แค่ไฟล์ที่คุณลากมาวาง ไม่แก้ไฟล์ และไม่รันคำสั่งใด ๆ`,
    ),
  );
}

function aboutPage(): HTMLElement {
  const info = state.info;
  return page(
    "เกี่ยวกับ",
    null,
    group(null, [
      row("Marshmori", info ? `เวอร์ชัน ${info.version}` : "", null),
      row("Mamori", "ชื่อเรียกสั้น ๆ ของ Marshmori — มาร์ชแมลโลว์ตัวน้อยจากผืนป่า (森 mori)", null),
    ]),
    info
      ? group("ไฟล์", [
          row("ข้อมูลและการตั้งค่า", null, null, {}),
          h("div", { class: "row" }, h("div", { class: "label" }, h("div", { class: "mono" }, info.dataDir))),
          row("Log", null, null),
          h("div", { class: "row" }, h("div", { class: "label" }, h("div", { class: "mono" }, info.logFile))),
          row("ตัวส่งต่อ (hook relay)", info.port ? `ฟังที่ 127.0.0.1:${info.port}` : null, null),
          h("div", { class: "row" }, h("div", { class: "label" }, h("div", { class: "mono" }, info.relayPath))),
        ])
      : [],
  );
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderTabs() {
  tabsEl.replaceChildren(
    ...TABS.map((t) =>
      h(
        "button",
        {
          class: "tab",
          role: "tab",
          "aria-selected": state.tab === t.id ? "true" : "false",
          onclick: () => {
            state.tab = t.id;
            if (t.id === "chat" && !state.providers.length) void loadProviders();
            render();
          },
        },
        h("span", { class: "tab-icon", style: { background: t.color } }, icon(t.icon, 15)),
        t.id === "mamori" ? mascot() : t.label,
      ),
    ),
  );
}

function render() {
  renderTabs();
  const s = state.settings;
  if (!s) return;
  let el: HTMLElement;
  switch (state.tab) {
    case "welcome":
      el = welcomePage(s);
      break;
    case "mamori":
      el = mamoriPage(s);
      break;
    case "approvals":
      el = approvalsPage(s);
      break;
    case "agents":
      el = agentsPage();
      break;
    case "chat":
      el = chatPage(s);
      break;
    case "about":
      el = aboutPage();
      break;
    default:
      el = generalPage(s);
  }
  const same = content.firstElementChild?.getAttribute("data-tab") === state.tab;
  el.dataset.tab = state.tab;
  if (same) el.style.animation = "none";
  const scroll = content.scrollTop;
  content.replaceChildren(el);
  if (same) content.scrollTop = scroll;
  document.getElementById("brand-sub")!.textContent = `${mascot()} · เพื่อนบนจอ`;
}

async function refreshHooks() {
  try {
    state.hooks = await api.hooksStatus();
  } catch {
    state.hooks = [];
  }
  render();
}

async function loadProviders(refresh = false) {
  state.providersLoading = true;
  render();
  try {
    state.providers = await api.chatProviders(refresh);
  } catch {
    state.providers = [];
  }
  state.providersLoading = false;
  render();
}

async function start() {
  const hash = location.hash.slice(1);
  if (TABS.some((t) => t.id === hash)) state.tab = hash as Tab;
  else if (hash === "moji") state.tab = "mamori";
  try {
    state.settings = await api.getSettings();
    applyLocal(state.settings);
  } catch (err) {
    content.replaceChildren(h("div", { class: "msg bad" }, errorText(err)));
    return;
  }
  render();
  brand.react("wink", 1100);
  void refreshHooks();
  void api.appInfo().then((info) => {
    state.info = info;
    if (state.tab === "about") render();
  });
  if (state.tab === "chat") void loadProviders();
  await on.settings((s) => {
    state.settings = s;
    applyLocal(s);
    render();
  });
  await on.hooks((list) => {
    state.hooks = list;
    render();
  });
  await on.settingsTab((tab) => {
    state.tab = (TABS.some((t) => t.id === tab) ? tab : tab === "moji" ? "mamori" : "general") as Tab;
    if (state.tab === "chat") void loadProviders();
    render();
  });
}

void start();
