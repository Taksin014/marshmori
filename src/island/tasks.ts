// "สั่งงาน": you tell Mamori what to do, and it has a coding agent do it in the
// background (src-tauri/src/tasks.rs runs the agent's own CLI in the folder you pick).
//
// Two pages in the island's open panel, built once and kept (like the chat), so typing
// is never lost to a re-render:
//   the form    which agent, which folder, how much it may do on its own, the task;
//               below it, the latest tasks
//   a task      what you asked and what came back, turn by turn, what it is doing right
//               now, and a box to send it more
//
// Like an IDE's chat: files dragged onto the island while these pages are open go in
// with the next message (the agent gets their paths), and a folder dragged in (or
// right-clicked in Explorer: "สั่งงาน Mamori ที่นี่") becomes the folder to work in.
// "ต่อจากงานล่าสุด" picks up the conversation you had going there in a terminal or
// an IDE instead of starting from nothing.

import { api, errorText } from "../core/ipc";
import { h, icon, timeAgo } from "../core/dom";
import { renderMarkdown } from "../core/markdown";
import {
  AGENT_COLORS,
  TASK_MODE_LABELS,
  TASK_MODES,
  type ProviderId,
  type ProviderStatus,
  type Session,
  type Task,
  type TaskMode,
  type TaskSnapshot,
} from "../core/types";
import type { ExpressionName } from "../mascot/expressions";

export interface TaskHost {
  name(): string;
  /** The agent CLIs installed on this computer. */
  providers(): ProviderStatus[];
  providersChecked(): boolean;
  loadProviders(refresh?: boolean): void;
  sessions(): Session[];
  /** Redraw the whole island (the pill, Mamori's mood…). */
  render(): void;
  layout(): void;
  toast(text: string): void;
  /** Leave the task pages for the island's home. */
  back(): void;
  /** Close the panel. */
  close(): void;
  react(expr: ExpressionName, ms: number): void;
  bump(amount: number): void;
  sound(name: "pop" | "done" | "error" | "ask"): void;
  /** A task just finished (or failed, or was stopped). */
  finished(task: Task): void;
}

const DOT: Record<string, string> = {
  claude: AGENT_COLORS.claude,
  codex: AGENT_COLORS.codex,
  antigravity: AGENT_COLORS.antigravity,
  gemini: "#4f8df7",
};

const STATUS_LABELS: Record<Task["status"], string> = {
  running: "กำลังทำ",
  done: "เสร็จแล้ว",
  error: "มีปัญหา",
  stopped: "หยุดแล้ว",
};

/** Files (or folders) that go with one message. Must match MAX_FILES in tasks.rs. */
const MAX_FILES = 10;

/** The agents that can pick up "the latest conversation in this folder". */
const CAN_CONTINUE: ProviderId[] = ["claude", "codex", "gemini"];

/** What each permission level means for each agent, in one line. */
export function modeHint(agent: ProviderId | "", mode: TaskMode): string {
  if (mode === "plan") return "ดูโค้ดแล้วเขียนแผนให้อ่านก่อน ไม่แก้ไฟล์อะไร";
  switch (agent) {
    case "codex":
      return "Codex ไม่ถามระหว่างทาง: แก้ไฟล์ได้เฉพาะในโฟลเดอร์นี้ และไม่ออกอินเทอร์เน็ต";
    case "gemini":
      return mode === "ask" ? "อ่านไฟล์ได้อย่างเดียว ไม่แก้และไม่รันคำสั่ง" : "แก้ไฟล์ในโฟลเดอร์ได้ แต่ไม่รันคำสั่ง";
    case "antigravity":
      return "ถามก่อนรันคำสั่งทุกครั้ง (เมื่อเชื่อม hooks ของ Antigravity ไว้) ส่วนอื่นตามที่ตั้งไว้ใน Antigravity";
    default:
      if (mode === "ask") return "อ่านไฟล์เองได้ จะแก้ไฟล์หรือรันคำสั่งต้องขออนุมัติก่อน (การ์ดขึ้นที่แถบนี้)";
      if (mode === "edits") return "แก้ไฟล์ในโฟลเดอร์ได้เลย ส่วนการรันคำสั่งต้องขออนุมัติก่อน";
      return "ให้ Claude ตัดสินใจเอง โดยมีตัวตรวจความปลอดภัยของ Claude คอยดูทุกขั้น";
  }
}

export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** What was dragged in: a folder to work in, files to go with the message. */
export interface Dropped {
  folder?: string | null;
  files?: string[];
}

export function createTasks(host: TaskHost) {
  const ts = {
    tasks: [] as Task[],
    folders: [] as string[],
    agent: "" as ProviderId | "",
    mode: "ask" as TaskMode,
    folder: "",
    /** Files that go with the next message (the form's or the follow-up's). */
    files: [] as string[],
    /** The next new task picks up the agent's latest conversation in the folder. */
    continueLast: false,
    /** The task on screen; null: the form. */
    current: null as string | null,
    sending: false,
  };

  // ── Header ──
  const back = h("button", { class: "icon-btn", title: "กลับ", "aria-label": "กลับ", onclick: () => goBack() }, icon("back", 18));
  const title = h("span", { class: "title" }, "");
  const badge = h("span", { class: "status-chip" });
  const stopBtn = h("button", { class: "chip-btn danger", onclick: () => stop() }, icon("stop", 13), "หยุดงาน") as HTMLButtonElement;
  const close = h("button", { class: "icon-btn", title: "ปิด (Esc)", "aria-label": "ปิด", onclick: () => host.close() }, icon("close", 17));
  const headRow = h("div", { class: "chat-head" }, back, h("span", { class: "slot", "aria-hidden": "true" }), title, badge, h("span", { class: "grow" }), stopBtn, close);

  // ── The form ──
  const agentChoice = h("div", { class: "choice", role: "radiogroup", "aria-label": "ให้ใครทำ" });
  const folderSelect = h("select", { class: "folder-select", "aria-label": "โฟลเดอร์" }) as HTMLSelectElement;
  const pick = h("button", { class: "chip-btn", type: "button", onclick: () => void pickFolder() }, icon("folder", 14), "เลือก…");
  const taskInput = h("textarea", { rows: 2, "aria-label": "งานที่อยากให้ทำ" }) as HTMLTextAreaElement;
  const attachBtn = h(
    "button",
    { class: "icon-btn attach-btn", type: "button", title: "แนบไฟล์ (หรือลากไฟล์มาวางที่แถบนี้)", "aria-label": "แนบไฟล์", onclick: () => void pickFiles() },
    icon("attach", 17),
  );
  const sendTask = h("button", { class: "send", type: "button", "aria-label": "ส่งงาน", title: "ส่งงาน (Enter)" }, icon("up", 17)) as HTMLButtonElement;
  const formFiles = h("div", { class: "atts" });
  const continueBtn = h("button", { class: "toggle-chip", type: "button", role: "switch", onclick: () => toggleContinue() }) as HTMLButtonElement;
  const modeChoice = h("div", { class: "choice small", role: "radiogroup", "aria-label": "ให้ทำเองได้แค่ไหน" });
  const hint = h("div", { class: "task-hint" });
  const empty = h("div", { class: "notice" });
  const recent = h("div", { class: "task-list" });
  const form = h(
    "div",
    { class: "task-form" },
    h("div", { class: "field" }, h("span", { class: "label" }, "ให้ใครทำ"), agentChoice),
    h("div", { class: "field" }, h("span", { class: "label" }, "ที่โฟลเดอร์"), h("span", { class: "select-wrap" }, folderSelect, icon("chevron", 14)), pick),
    empty,
    formFiles,
    h("div", { class: "compose" }, taskInput, attachBtn, sendTask),
    h("div", { class: "field" }, h("span", { class: "label" }, "ทำเองได้แค่ไหน"), modeChoice),
    hint,
    h("div", { class: "field continue-field" }, h("span", { class: "label" }), continueBtn),
    recent,
  );

  // ── One task ──
  const msgs = h("div", { class: "msgs", role: "log", "aria-live": "polite" });
  // The "working on it" bubble stays the same element, so its dots keep bouncing while
  // the line under them changes.
  const workingLabel = h("span", { class: "typing-label" });
  const working = h("div", { class: "bubble assistant working" }, h("span", { class: "typing", "aria-hidden": "true" }, h("i"), h("i"), h("i")), workingLabel);
  let drawnKey = "";
  let listKey = "";
  let agentKey = "";
  let folderKey = "";
  let modeKey = "";
  let footerKey = "";
  const followInput = h("textarea", { rows: 1, "aria-label": "สั่งต่อ" }) as HTMLTextAreaElement;
  const followAttach = h(
    "button",
    { class: "icon-btn attach-btn", type: "button", title: "แนบไฟล์", "aria-label": "แนบไฟล์", onclick: () => void pickFiles() },
    icon("attach", 17),
  ) as HTMLButtonElement;
  const sendFollow = h("button", { class: "send", type: "button" }) as HTMLButtonElement;
  const followFiles = h("div", { class: "atts" });
  const followBox = h("div", { class: "compose" }, followInput, followAttach, sendFollow);
  const footer = h("div", { class: "task-actions" });
  const detail = h("div", { class: "task-detail" }, msgs, followFiles, followBox, footer);

  const root = h("div", { class: "chat task" }, headRow, form, detail);

  // ── Wiring ──
  const grow = (el: HTMLTextAreaElement, max: number) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  };
  taskInput.addEventListener("input", () => {
    grow(taskInput, 130);
    sendTask.disabled = !taskInput.value.trim();
    host.layout();
  });
  followInput.addEventListener("input", () => {
    grow(followInput, 110);
    host.layout();
  });
  const enterSends = (el: HTMLTextAreaElement, send: () => void) =>
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        host.close();
      }
    });
  enterSends(taskInput, () => void startTask());
  enterSends(followInput, () => void follow());
  sendTask.addEventListener("click", () => void startTask());
  sendFollow.addEventListener("click", () => {
    const t = currentTask();
    if (t?.status === "running") stop();
    else void follow();
  });
  folderSelect.addEventListener("change", () => {
    ts.folder = folderSelect.value;
    update();
  });

  // ── Data ──

  function byId(id: string | null): Task | null {
    return id ? ts.tasks.find((t) => t.id === id) ?? null : null;
  }

  function currentTask(): Task | null {
    return byId(ts.current);
  }

  function installed(): ProviderStatus[] {
    return host.providers().filter((p) => p.installed);
  }

  /** Recent task folders first, then the folders of sessions on screen. */
  function folders(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of [...ts.folders, ...host.sessions().map((s) => s.cwd)]) {
      if (f && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    return out.slice(0, 10);
  }

  function setSnapshot(snap: TaskSnapshot) {
    ts.tasks = snap.tasks;
    ts.folders = snap.folders;
    if (!ts.agent && snap.agent) ts.agent = snap.agent as ProviderId;
    ts.mode = snap.mode ?? "ask";
    if (!ts.folder) ts.folder = snap.folders[0] ?? "";
    update();
  }

  /** A task changed (from Rust). */
  function apply(task: Task) {
    const i = ts.tasks.findIndex((t) => t.id === task.id);
    const before = i >= 0 ? ts.tasks[i] : null;
    if (i >= 0) ts.tasks[i] = task;
    else ts.tasks.unshift(task);
    if (!ts.folders.includes(task.cwd)) ts.folders.unshift(task.cwd);
    if (before?.status === "running" && task.status !== "running") host.finished(task);
    update();
    host.render();
  }

  function remove(id: string) {
    ts.tasks = ts.tasks.filter((t) => t.id !== id);
    if (ts.current === id) ts.current = null;
    update();
    host.render();
  }

  /** Adds files to the next message (no repeats, at most MAX_FILES). */
  function addFiles(paths: string[]) {
    let added = 0;
    for (const p of paths) {
      if (p && !ts.files.includes(p) && ts.files.length < MAX_FILES) {
        ts.files.push(p);
        added += 1;
      }
    }
    if (added < paths.filter(Boolean).length && ts.files.length >= MAX_FILES) host.toast(`แนบได้ครั้งละไม่เกิน ${MAX_FILES} ไฟล์`);
    return added;
  }

  /**
   * What was dragged in (or right-clicked in Explorer). A folder becomes the folder to
   * work in (or, with a task open, a path for the agent to look at); files go with the
   * next message.
   */
  function drop(d: Dropped) {
    const t = currentTask();
    if (d.folder) {
      if (t) {
        addFiles([d.folder]);
      } else {
        ts.folder = d.folder;
        if (!ts.folders.includes(d.folder)) ts.folders.unshift(d.folder);
      }
    }
    if (d.files?.length) addFiles(d.files);
    update();
    focus();
  }

  /** Opens the form ready for a folder (and files), the way an IDE opens a project. */
  function prefill(d: Dropped) {
    ts.current = null;
    drop(d);
  }

  // ── Actions ──

  function goBack() {
    if (ts.current) {
      ts.current = null;
      update();
      focus();
    } else {
      host.back();
    }
  }

  function open(id: string | null = null) {
    ts.current = byId(id) ? id : null;
    update();
  }

  async function pickFolder() {
    try {
      const path = await api.taskPickFolder();
      if (path) {
        ts.folder = path;
        if (!ts.folders.includes(path)) ts.folders.unshift(path);
        update();
      }
    } catch (err) {
      host.toast(errorText(err));
    }
    taskInput.focus();
  }

  async function pickFiles() {
    try {
      const t = currentTask();
      const paths = await api.taskPickFiles(t?.cwd ?? ts.folder);
      if (paths.length) {
        addFiles(paths);
        update();
      }
    } catch (err) {
      host.toast(errorText(err));
    }
    focus();
  }

  function toggleContinue() {
    ts.continueLast = !ts.continueLast;
    update();
    taskInput.focus();
  }

  async function startTask() {
    const prompt = taskInput.value.trim();
    if (!prompt || ts.sending) return;
    const agent = ts.agent || installed()[0]?.id;
    if (!agent) {
      host.toast("ยังไม่พบ agent ในเครื่องนี้");
      return;
    }
    if (!ts.folder) {
      host.toast("เลือกโฟลเดอร์ที่จะให้ทำงานก่อน");
      return;
    }
    ts.sending = true;
    sendTask.disabled = true;
    try {
      const task = await api.taskStart({
        agent,
        cwd: ts.folder,
        prompt,
        mode: ts.mode,
        files: ts.files,
        continueLast: ts.continueLast && CAN_CONTINUE.includes(agent),
      });
      taskInput.value = "";
      grow(taskInput, 130);
      ts.files = [];
      ts.continueLast = false;
      apply(task);
      ts.current = task.id;
      host.react("excited", 1200);
      host.bump(2.4);
      host.sound("pop");
    } catch (err) {
      host.toast(errorText(err));
      host.react("sad", 1200);
    }
    ts.sending = false;
    update();
  }

  async function follow() {
    const t = currentTask();
    const prompt = followInput.value.trim();
    if (!t || !prompt || ts.sending || t.status === "running") return;
    ts.sending = true;
    try {
      const task = await api.taskStart({ follow: t.id, prompt, mode: t.mode, files: ts.files });
      followInput.value = "";
      grow(followInput, 110);
      ts.files = [];
      apply(task);
      host.react("happy", 900);
      host.bump(1.8);
    } catch (err) {
      host.toast(errorText(err));
    }
    ts.sending = false;
    update();
  }

  function stop() {
    const t = currentTask();
    if (t?.status === "running") void api.taskCancel(t.id);
  }

  // ── Drawing ──

  function chooser<T extends string>(el: HTMLElement, options: { id: T; label: string; color?: string }[], value: T, onPick: (v: T) => void) {
    el.replaceChildren(
      ...options.map((o) =>
        h(
          "button",
          {
            class: `opt${o.id === value ? " on" : ""}`,
            type: "button",
            role: "radio",
            "aria-checked": o.id === value ? "true" : "false",
            onclick: () => {
              onPick(o.id);
              update();
            },
          },
          o.color ? h("span", { class: "dot", style: { background: o.color } }) : null,
          o.label,
        ),
      ),
    );
  }

  /** The files that go with the next message, as chips (same list on both pages). */
  function drawFiles(el: HTMLElement) {
    const key = ts.files.join("|");
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(
      ...ts.files.map((f) =>
        h(
          "span",
          { class: "att", title: f },
          icon("file", 13),
          h("span", null, folderName(f)),
          h(
            "button",
            {
              class: "icon-btn",
              type: "button",
              "aria-label": `เอา ${folderName(f)} ออก`,
              onclick: () => {
                ts.files = ts.files.filter((x) => x !== f);
                update();
              },
            },
            icon("close", 12),
          ),
        ),
      ),
    );
    el.style.display = ts.files.length ? "flex" : "none";
  }

  function drawForm() {
    title.textContent = `สั่งงานให้ ${host.name()} จัดการ`;
    badge.style.display = "none";
    stopBtn.style.display = "none";
    const list = installed();
    // Until the list of installed agents is in, keep the one picked last time.
    if (ts.agent && host.providersChecked() && !list.some((p) => p.id === ts.agent)) ts.agent = "";
    const agent = (ts.agent || list[0]?.id || "") as ProviderId | "";
    const aKey = `${list.map((p) => p.id).join(",")}|${agent}`;
    if (aKey !== agentKey) {
      agentKey = aKey;
      chooser(
        agentChoice,
        list.map((p) => ({ id: p.id, label: p.label, color: DOT[p.id] })),
        agent as ProviderId,
        (v) => (ts.agent = v),
      );
    }
    if (!list.length) {
      empty.style.display = "flex";
      empty.replaceChildren(
        icon("alert", 16),
        h("span", null, host.providersChecked() ? "ยังไม่พบ Claude Code, Codex, Antigravity หรือ Gemini CLI ในเครื่อง" : "กำลังดูว่ามี agent ตัวไหนในเครื่องบ้าง…"),
        ...(host.providersChecked() ? [h("button", { class: "btn", onclick: () => void api.openSettings("chat") }, "ดูวิธีตั้งค่า")] : []),
      );
    } else {
      empty.style.display = "none";
    }

    const dirs = folders();
    if (!ts.folder && dirs.length) ts.folder = dirs[0];
    if (ts.folder && !dirs.includes(ts.folder)) dirs.unshift(ts.folder);
    const fKey = `${dirs.join("|")}>${ts.folder}`;
    if (fKey !== folderKey) {
      folderKey = fKey;
      folderSelect.replaceChildren(
        ...(dirs.length
          ? dirs.map((d) => h("option", { value: d, selected: d === ts.folder, title: d }, `${folderName(d)}  —  ${d}`))
          : [h("option", { value: "" }, "ยังไม่มี — กด “เลือก…” หรือลากโฟลเดอร์มาวาง")]),
      );
      folderSelect.disabled = !dirs.length;
    }

    if (ts.mode !== modeKey) {
      modeKey = ts.mode;
      chooser(
        modeChoice,
        TASK_MODES.map((m) => ({ id: m, label: TASK_MODE_LABELS[m] })),
        ts.mode,
        (v) => (ts.mode = v),
      );
    }
    hint.textContent = modeHint(agent, ts.mode);
    const who = list.find((p) => p.id === agent)?.label ?? "agent";

    const canContinue = !!agent && CAN_CONTINUE.includes(agent as ProviderId);
    continueBtn.parentElement!.style.display = canContinue ? "" : "none";
    continueBtn.classList.toggle("on", ts.continueLast);
    continueBtn.setAttribute("aria-checked", ts.continueLast ? "true" : "false");
    continueBtn.title = `ใช้บทสนทนาล่าสุดของ ${who} ในโฟลเดอร์นี้ (ที่คุยค้างไว้ใน terminal หรือ VS Code) แทนการเริ่มใหม่`;
    continueBtn.replaceChildren(h("span", { class: "knob", "aria-hidden": "true" }), `ต่อจากงานล่าสุดของ ${who} ในโฟลเดอร์นี้`);

    drawFiles(formFiles);
    const where = ts.folder ? folderName(ts.folder) : "โฟลเดอร์นี้";
    taskInput.placeholder = ts.continueLast
      ? `สั่ง ${who} ต่อจากที่ค้างไว้ใน ${where}…`
      : `อยากให้ ${who} ทำอะไรใน ${where}…  (Enter ส่ง · ลากไฟล์มาวางเพื่อแนบ)`;
    sendTask.disabled = !taskInput.value.trim() || ts.sending || !list.length;

    const latest = ts.tasks.slice(0, 5);
    const key = latest.map((t) => `${t.id}:${t.status}:${t.activity}:${Math.floor((Date.now() - t.updatedAt) / 60_000)}`).join("|");
    if (key === listKey) return;
    listKey = key;
    recent.replaceChildren(
      ...(latest.length ? [h("div", { class: "list-title" }, "งานล่าสุด")] : []),
      ...latest.map((t) => {
        const first = t.turns[0]?.prompt ?? "";
        return h(
          "button",
          { class: `task-row ${t.status}`, type: "button", onclick: () => open(t.id) },
          h("span", { class: `dot${t.status === "running" ? " busy" : ""}`, style: { background: statusColor(t) } }),
          h("span", { class: "what" }, h("b", null, t.project), ` · ${t.agentLabel} · `, h("span", { class: "sub" }, clip(first, 60))),
          h("span", { class: "when" }, t.status === "running" ? clip(t.activity || "กำลังทำ…", 28) : `${STATUS_LABELS[t.status]} · ${timeAgo(t.updatedAt)}`),
        );
      }),
    );
  }

  function statusColor(t: Task): string {
    switch (t.status) {
      case "running":
        return DOT[t.agent] ?? "var(--blue)";
      case "done":
        return "var(--green)";
      case "error":
        return "var(--red)";
      default:
        return "var(--muted-2)";
    }
  }

  /** What it is doing: its live session's activity when the hooks report, else the CLI's. */
  function activity(t: Task): string {
    const s = t.sessionKey ? host.sessions().find((x) => x.key === t.sessionKey) : null;
    if (s && s.state === "approval") return "รออนุมัติอยู่ — ดูการ์ดที่แถบด้านบน";
    if (s && (s.state === "working" || s.state === "thinking") && s.activity) return s.activity;
    return t.activity || "กำลังทำ…";
  }

  function drawTask(t: Task) {
    title.textContent = `${t.project} · ${t.agentLabel}`;
    badge.style.display = "";
    badge.className = `status-chip ${t.status}`;
    badge.textContent = STATUS_LABELS[t.status];
    stopBtn.style.display = t.status === "running" ? "" : "none";

    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    workingLabel.textContent = activity(t);
    const key = `${t.id}|${t.turns.map((x) => `${x.status}:${x.prompt.length}:${x.result.length}:${x.error?.length ?? 0}:${x.files?.length ?? 0}:${x.continued ? 1 : 0}`).join(",")}`;
    if (key === drawnKey) {
      if (nearBottom) msgs.scrollTop = msgs.scrollHeight;
      drawTaskControls(t);
      return;
    }
    drawnKey = key;
    const nodes: HTMLElement[] = [];
    t.turns.forEach((turn, i) => {
      if (turn.continued) nodes.push(h("div", { class: "turn-note" }, icon("back", 12), `ต่อจากงานล่าสุดของ ${t.agentLabel} ใน ${t.project}`));
      nodes.push(h("div", { class: "bubble user" }, turn.prompt));
      if (turn.files?.length) {
        nodes.push(
          h(
            "div",
            { class: "turn-files" },
            ...turn.files.map((f) => h("span", { class: "att small", title: f }, icon("file", 12), h("span", null, folderName(f)))),
          ),
        );
      }
      const last = i === t.turns.length - 1;
      if (turn.status === "running" && last) {
        nodes.push(working);
      } else if (turn.error) {
        nodes.push(h("div", { class: "bubble assistant error" }, turn.error));
      } else if (turn.status === "stopped") {
        nodes.push(h("div", { class: "bubble assistant muted" }, turn.result ? turn.result : "(หยุดแล้ว)"));
      } else if (turn.result) {
        const b = h("div", { class: "bubble assistant" });
        b.innerHTML = renderMarkdown(turn.result);
        nodes.push(b);
      }
    });
    msgs.replaceChildren(...nodes);
    msgs.scrollTop = msgs.scrollHeight;
    drawTaskControls(t);
  }

  function drawTaskControls(t: Task) {
    const running = t.status === "running";
    followInput.placeholder = running ? `${t.agentLabel} กำลังทำอยู่…` : `สั่ง ${t.agentLabel} ต่อในงานนี้…  (ลากไฟล์มาวางเพื่อแนบ)`;
    followInput.disabled = running;
    followAttach.disabled = running;
    drawFiles(followFiles);

    const fKey = `${t.id}|${running}|${t.mode}|${t.cwd}`;
    if (fKey === footerKey) return;
    footerKey = fKey;
    sendFollow.replaceChildren(icon(running ? "stop" : "up", 17));
    sendFollow.title = running ? "หยุดงาน" : "ส่ง (Enter)";
    sendFollow.setAttribute("aria-label", running ? "หยุดงาน" : "ส่ง");
    footer.replaceChildren(
      h("span", { class: "mode-chip", title: modeHint(t.agent, t.mode) }, `ทำเองได้: ${TASK_MODE_LABELS[t.mode]}`),
      h("span", { class: "grow" }),
      h("button", { class: "btn", onclick: () => void api.openFolder(t.cwd).catch((e) => host.toast(errorText(e))) }, icon("folder", 15), "เปิดโฟลเดอร์"),
      ...(running
        ? []
        : [
            h(
              "button",
              {
                class: "btn",
                onclick: async () => {
                  await api.taskDismiss(t.id).catch(() => false);
                  remove(t.id);
                },
              },
              "เอาออก",
            ),
          ]),
    );
  }

  function update() {
    const t = currentTask();
    if (!t) {
      drawnKey = "";
      footerKey = "";
    }
    form.style.display = t ? "none" : "";
    detail.style.display = t ? "" : "none";
    if (t) drawTask(t);
    else drawForm();
    host.layout();
  }

  function focus() {
    const t = currentTask();
    if (t) {
      if (t.status !== "running") followInput.focus();
    } else {
      taskInput.focus();
    }
  }

  return {
    root,
    update,
    focus,
    open,
    apply,
    remove,
    setSnapshot,
    drop,
    prefill,
    get current() {
      return ts.current;
    },
    tasks: () => ts.tasks,
    running: () => ts.tasks.filter((t) => t.status === "running"),
    byId,
  };
}

export type TaskView = ReturnType<typeof createTasks>;
