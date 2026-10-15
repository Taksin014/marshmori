// Fakes the Rust side so the island can be opened in a normal browser:
// http://127.0.0.1:1420/dev/island-mock.html?scenario=tuck|peek|pill|panel|approval|done|error|drop|file|chat|empty|away
//   |task-form|task-run|task-done|round|folder|task-files
//   &look=auto|dark|light|forest|midnight  &bounce=soft|boing|extra

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "panel";
const look = params.get("look") ?? "dark";
// A desktop to match: light wallpaper under a light island.
document.documentElement.classList.toggle("wall-light", look === "light");
const now = Date.now();

export const sessions = [
  {
    key: "claude:a",
    agent: "claude",
    agentLabel: "Claude Code",
    sessionId: "a",
    project: "shop",
    cwd: "C:\\โปรเจ็ค\\shop",
    state: "working",
    activity: "เขียน Login.tsx",
    detail: "C:\\โปรเจ็ค\\shop\\src\\Login.tsx",
    prompt: "เพิ่มหน้า login ให้หน่อย",
    toolCount: 4,
    startedAt: now - 200_000,
    updatedAt: now - 2_000,
    stateSince: now - 42_000,
    task: null,
    allowAll: scenario === "round",
    surface: "VS Code",
  },
  {
    key: "codex:b",
    agent: "codex",
    agentLabel: "Codex",
    sessionId: "b",
    project: "shop-api",
    cwd: "C:\\โปรเจ็ค\\shop-api",
    state: scenario === "approval" ? "approval" : "thinking",
    activity: scenario === "approval" ? "รออนุมัติ: รัน npm install zod" : "กำลังคิด: เขียน test ให้ routes",
    detail: null,
    prompt: "เขียน test ให้ routes",
    toolCount: 2,
    startedAt: now - 500_000,
    updatedAt: now - 5_000,
    stateSince: now - 15_000,
    task: null,
    allowAll: false,
    surface: null,
  },
  {
    key: "antigravity:c",
    agent: "antigravity",
    agentLabel: "Antigravity",
    sessionId: "c",
    project: "landing-page",
    cwd: "C:\\โปรเจ็ค\\landing-page",
    state: "done",
    activity: "เสร็จแล้ว",
    detail: "แก้หัวข้อเป็นภาษาไทยแล้ว",
    prompt: null,
    toolCount: 6,
    startedAt: now - 900_000,
    updatedAt: now - 30_000,
    stateSince: now - 30_000,
    task: null,
    allowAll: false,
    surface: null,
  },
];

const approvals =
  scenario === "approval"
    ? [
        {
          id: 1,
          agent: "codex",
          agentLabel: "Codex",
          sessionKey: "codex:b",
          project: "shop-api",
          cwd: "C:\\โปรเจ็ค\\shop-api",
          tool: "Bash",
          toolKind: "command",
          title: "รัน npm install zod",
          target: "npm install zod",
          detail: "npm install zod",
          alwaysLabel: "อนุญาตทุกอย่างที่ Codex ขอในรอบนี้ — สั่งงานครั้งถัดไปจะกลับมาถามใหม่",
          elsewhere: "ตอบใน terminal แทน",
          background: false,
          createdAt: now - 4_000,
          expiresAt: now + 106_000,
        },
        {
          id: 2,
          agent: "antigravity",
          agentLabel: "Antigravity",
          sessionKey: "antigravity:c",
          project: "landing-page",
          cwd: "C:\\โปรเจ็ค\\landing-page",
          tool: "run_command",
          toolKind: "command",
          title: "รัน npm run build",
          target: "npm run build",
          detail: "npm run build",
          alwaysLabel: "อนุญาตทุกอย่างที่ Antigravity ขอในรอบนี้ — สั่งงานครั้งถัดไปจะกลับมาถามใหม่",
          elsewhere: "ให้ Antigravity ถามเอง",
          background: false,
          createdAt: now - 1_000,
          expiresAt: now + 109_000,
        },
      ]
    : [];

const settings = {
  mascotName: "Mamori",
  color: "cream",
  sound: false,
  volume: 0.6,
  eyesFollow: true,
  approvals: true,
  approvalTimeout: 110,
  antigravityApprovals: true,
  shortcuts: true,
  hideInFullscreen: true,
  toasts: true,
  autostart: false,
  screen: "primary",
  chatProvider: "auto",
  roam: "all",
  autoHide: true,
  islandLook: look,
  hoverDelay: 600,
  islandBounce: params.get("bounce") ?? "boing",
  reachWith: "auto",
  settingsVersion: 4,
  onboarded: true,
};

const providers = [
  { id: "claude", label: "Claude Code", program: "claude", installed: true, path: "C:\\Users\\me\\.local\\bin\\claude.exe", signedIn: true, detail: "ใช้แพ็กเกจ Claude ที่ล็อกอินไว้", billed: false },
  { id: "codex", label: "Codex", program: "codex", installed: true, path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", signedIn: true, detail: "ใช้แพ็กเกจ ChatGPT ที่ล็อกอินไว้", billed: false },
  { id: "antigravity", label: "Antigravity", program: "agy", installed: true, path: "C:\\Users\\me\\.local\\bin\\agy.exe", signedIn: null, detail: "ใช้บัญชี Google ที่ล็อกอินไว้ใน agy", billed: false },
  { id: "gemini", label: "Gemini CLI", program: "gemini", installed: false, path: null, signedIn: null, detail: "ยังไม่พบในเครื่องนี้", billed: false },
];

const history = [
  { id: 5, at: now - 30_000, agent: "antigravity", agentLabel: "Antigravity", project: "landing-page", kind: "done", text: "เสร็จแล้ว — แก้หัวข้อเป็นภาษาไทยแล้ว" },
  { id: 4, at: now - 60_000, agent: "claude", agentLabel: "Claude Code", project: "shop", kind: "approval", text: "อนุญาต: รัน npm install zod" },
  { id: 3, at: now - 90_000, agent: "claude", agentLabel: "Claude Code", project: "shop", kind: "tool", text: "เขียน Login.tsx" },
  { id: 2, at: now - 200_000, agent: "codex", agentLabel: "Codex", project: "shop-api", kind: "prompt", text: "เขียน test ให้ routes" },
  { id: 1, at: now - 400_000, agent: "claude", agentLabel: "Claude Code", project: "shop", kind: "prompt", text: "เพิ่มหน้า login ให้หน่อย" },
];

const files = [
  { path: "C:\\Users\\me\\Desktop\\error-screenshot.png", name: "error-screenshot.png", size: 254_000, kind: "image", supported: true, reason: null },
  { path: "C:\\Users\\me\\Desktop\\spec.pdf", name: "spec.pdf", size: 1_400_000, kind: "pdf", supported: true, reason: null },
  { path: "C:\\Users\\me\\Desktop\\setup.exe", name: "setup.exe", size: 48_000_000, kind: "other", supported: false, reason: "ยังไม่รองรับไฟล์ชนิดนี้" },
];

export const tasks = [
  {
    id: "t1",
    agent: "claude",
    agentLabel: "Claude Code",
    cwd: "C:\\โปรเจ็ค\\shop",
    project: "shop",
    mode: "ask",
    status: "done",
    activity: "เสร็จแล้ว",
    agentSession: "s-1",
    sessionKey: null,
    turns: [
      {
        prompt: "เพิ่มปุ่มสลับ dark mode ที่หน้า Settings ให้หน่อย",
        result:
          "เพิ่มปุ่มสลับธีมให้แล้วครับ\n\n- `src/pages/Settings.tsx`: ปุ่ม **Dark mode** อยู่ใต้หัวข้อ “หน้าตา”\n- จำค่าไว้ใน `localStorage` เปิดใหม่ก็ยังเป็นธีมเดิม\n- `npm test` ผ่านหมด 24 ตัว\n\nลอง `npm run dev` แล้วเปิดหน้า Settings ดูได้เลย",
        error: null,
        status: "done",
        startedAt: now - 640_000,
        endedAt: now - 420_000,
      },
    ],
    createdAt: now - 640_000,
    updatedAt: now - 420_000,
  },
  {
    id: "t2",
    agent: "codex",
    agentLabel: "Codex",
    cwd: "C:\\โปรเจ็ค\\shop-api",
    project: "shop-api",
    mode: "edits",
    status: "error",
    activity: "Codex ต่ออินเทอร์เน็ตไม่ได้",
    agentSession: "th-2",
    sessionKey: null,
    turns: [
      {
        prompt: "อัปเดต dependency ทั้งหมดเป็นเวอร์ชันล่าสุด",
        result: "",
        error: "Codex ต่ออินเทอร์เน็ตไม่ได้ ลองใหม่อีกครั้ง",
        status: "error",
        startedAt: now - 3_600_000,
        endedAt: now - 3_500_000,
      },
    ],
    createdAt: now - 3_600_000,
    updatedAt: now - 3_500_000,
  },
];

(window as unknown as { __hitRects: unknown }).__hitRects = [];

mockWindows("island");
mockIPC(
  (cmd, args) => {
    switch (cmd) {
      case "island_snapshot":
        return {
          sessions: ["empty", "tuck", "peek"].includes(scenario) ? [] : scenario === "done" || scenario === "error" ? sessions.map((s) => (s.key === "claude:a" ? { ...s, state: "working" } : s)) : sessions,
          approvals,
          settings,
          visible: true,
        };
      case "island_set_hit_rects":
        (window as unknown as { __hitRects: unknown }).__hitRects = (args as { rects: unknown }).rects;
        return null;
      case "history_list":
        return history;
      case "files_inspect": {
        const paths = (args as { paths: string[] }).paths ?? [];
        // A path without a dot in its last part is a folder here.
        if (paths.some((p) => !/\.[a-z0-9]+$/i.test(p) && /[\\/]/.test(p))) {
          return paths.map((p) => {
            const name = p.split(/[\\/]/).pop() ?? p;
            const folder = !/\.[a-z0-9]+$/i.test(name);
            return folder
              ? { path: p, name, size: 0, kind: "folder", supported: false, reason: "เป็นโฟลเดอร์ — สั่งงานในโฟลเดอร์นี้ได้" }
              : { path: p, name, size: 12_000, kind: "text", supported: true, reason: null };
          });
        }
        return files;
      }
      case "task_pick_files":
        return ["C:\\Users\\me\\Desktop\\error-screenshot.png"];
      case "island_take_open":
        return null;
      case "session_allow_all_off":
        return true;
      case "chat_send":
        return "chat1";
      case "chat_providers":
        return providers;
      case "open_folder":
        return null;
      case "approval_ack":
        return true;
      case "task_list":
        return { tasks: scenario.startsWith("task") ? tasks : [], folders: ["C:\\โปรเจ็ค\\shop", "C:\\โปรเจ็ค\\shop-api", "C:\\โปรเจ็ค\\landing-page"], agent: "claude", mode: "ask" };
      case "task_start": {
        const req = (args as { request: { agent: string; cwd: string; prompt: string; mode: string } }).request;
        return {
          id: "t9",
          agent: req.agent,
          agentLabel: req.agent === "codex" ? "Codex" : "Claude Code",
          cwd: req.cwd,
          project: req.cwd.split(/[\\/]/).pop(),
          mode: req.mode,
          status: "running",
          activity: "กำลังเริ่ม…",
          agentSession: null,
          sessionKey: null,
          turns: [{ prompt: req.prompt, result: "", error: null, status: "running", startedAt: Date.now(), endedAt: null }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      case "task_pick_folder":
        return "C:\\Users\\me\\Projects\\blog";
      case "task_dismiss":
        return true;
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);
