// Shapes shared with the Rust side (see src-tauri/src/*.rs, camelCase over the wire).

export type AgentId = "claude" | "codex" | "antigravity";
export type SessionState = "idle" | "thinking" | "working" | "approval" | "waiting" | "done" | "error";
export type ToolKind = "command" | "edit" | "read" | "search" | "web" | "agent" | "plan" | "mcp" | "other";
export type ColorName = "cream" | "mint" | "lilac" | "peach" | "butter" | "sky";
export type RoamWhen = "all" | "approvals" | "off";
/** The agent CLIs the chat can go through (no API keys: each one's own sign-in). */
export type ProviderId = "claude" | "codex" | "antigravity" | "gemini";
export type ChatProviderSetting = "auto" | ProviderId;

export interface Session {
  key: string;
  agent: AgentId;
  agentLabel: string;
  sessionId: string;
  project: string;
  cwd: string;
  state: SessionState;
  activity: string;
  detail: string | null;
  prompt: string | null;
  toolCount: number;
  startedAt: number;
  updatedAt: number;
  stateSince: number;
  /** Mamori started this session itself: the id of its task. */
  task: string | null;
  /** "Allow for this round" is on: everything it asks goes through until the next prompt. */
  allowAll: boolean;
  /** Where its own prompts show up when it isn't a terminal ("VS Code"…). */
  surface: string | null;
}

export interface ApprovalView {
  id: number;
  agent: AgentId;
  agentLabel: string;
  sessionKey: string;
  project: string;
  cwd: string;
  tool: string;
  toolKind: ToolKind;
  title: string;
  target: string | null;
  detail: string | null;
  alwaysLabel: string;
  /** The link back to the agent's own prompt ("ตอบใน VS Code แทน"); null for a background task. */
  elsewhere: string | null;
  createdAt: number;
  expiresAt: number;
  /** A task Mamori runs in the background: there is no terminal to answer in. */
  background: boolean;
}

export interface HistoryItem {
  id: number;
  at: number;
  agent: AgentId;
  agentLabel: string;
  project: string;
  kind: "prompt" | "tool" | "approval" | "done" | "error" | "info";
  text: string;
}

export interface Settings {
  /** What the app calls the mascot (default "Mamori"; its full name is Marshmori). */
  mascotName: string;
  color: ColorName;
  sound: boolean;
  volume: number;
  eyesFollow: boolean;
  approvals: boolean;
  approvalTimeout: number;
  antigravityApprovals: boolean;
  shortcuts: boolean;
  hideInFullscreen: boolean;
  toasts: boolean;
  autostart: boolean;
  screen: "primary" | "cursor";
  chatProvider: ChatProviderSetting;
  onboarded: boolean;
  /** When Mamori stretches its neck out to the mouse pointer. */
  roam: RoamWhen;
  /** Tuck the island away when nothing is going on. */
  autoHide: boolean;
  /** The island's colours ("auto": light or dark with the system). */
  islandLook: IslandLook;
  /** How long the pointer stays at the island before it peeks out or opens (ms). */
  hoverDelay: number;
  /** How much the island bounces as it opens. */
  islandBounce: IslandBounce;
  /** What Mamori nudges you with when it reaches out: its head, a hand, or whichever suits the news. */
  reachWith: ReachWith;
  /** "สั่งงาน Mamori ที่นี่" in Explorer's right-click menu on folders. */
  folderMenu: boolean;
  /** Agents you disconnected (kept by the app; Marshmori doesn't connect them again by itself). */
  hooksOff?: string[];
  settingsVersion: number;
}

/** A folder (Explorer's menu) or files (dropped on the app icon) to start a task with. */
export interface OpenRequest {
  folder: string | null;
  files: string[];
}

export type ReachWith = "auto" | "head" | "hand";

export const REACH_WITH_LABELS: Record<ReachWith, string> = {
  auto: "ตามเรื่อง",
  head: "ยื่นหัว",
  hand: "ยื่นมือ",
};

/** How the island opens: "soft" barely bounces, "boing" wobbles back (the default), "extra" bounces a lot. */
export type IslandBounce = "soft" | "boing" | "extra";

export const ISLAND_BOUNCE_LABELS: Record<IslandBounce, string> = {
  soft: "นุ่ม ๆ",
  boing: "ดึ๋ง",
  extra: "ดึ๋งมาก",
};

// ── Tasks Mamori runs for you (src-tauri/src/tasks.rs) ──────────────────────────

/** How much the agent may do without asking. */
export type TaskMode = "ask" | "edits" | "auto" | "plan";
export type TaskStatus = "running" | "done" | "error" | "stopped";

export const TASK_MODES: TaskMode[] = ["ask", "edits", "auto", "plan"];

export const TASK_MODE_LABELS: Record<TaskMode, string> = {
  ask: "ถามก่อน",
  edits: "แก้ไฟล์ได้",
  auto: "อัตโนมัติ",
  plan: "วางแผน",
};

export interface TaskTurn {
  prompt: string;
  result: string;
  error: string | null;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  /** Files and folders dragged in with this message. */
  files?: string[];
  /** It picked up the agent's latest conversation in the folder. */
  continued?: boolean;
}

export interface Task {
  id: string;
  agent: ProviderId;
  agentLabel: string;
  cwd: string;
  project: string;
  mode: TaskMode;
  status: TaskStatus;
  /** What it is doing right now. */
  activity: string;
  agentSession: string | null;
  /** The island's session for it, once its hooks reported in. */
  sessionKey: string | null;
  turns: TaskTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskSnapshot {
  tasks: Task[];
  /** Folders used for tasks lately, newest first. */
  folders: string[];
  /** Picked last time. */
  agent: string;
  mode: TaskMode;
}

export interface TaskRequest {
  agent?: ProviderId;
  cwd?: string;
  prompt: string;
  mode?: TaskMode;
  /** Continue this task (a follow-up). */
  follow?: string;
  /** Files and folders dragged in (absolute paths). */
  files?: string[];
  /** Pick up the agent's latest conversation in the folder instead of starting fresh. */
  continueLast?: boolean;
}

/** How the island looks: "auto" follows the system's light or dark mode. */
export type IslandLook = "auto" | "dark" | "light" | "forest" | "midnight";

export const ISLAND_LOOKS: IslandLook[] = ["auto", "dark", "light", "forest", "midnight"];

export const ISLAND_LOOK_LABELS: Record<IslandLook, string> = {
  auto: "ตามระบบ",
  dark: "เข้ม",
  light: "สว่าง",
  forest: "ป่า",
  midnight: "มิดไนท์",
};

export interface Snapshot {
  sessions: Session[];
  approvals: ApprovalView[];
  settings: Settings;
  visible: boolean;
}

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  kind: "image" | "pdf" | "text" | "folder" | "other";
  supported: boolean;
  reason: string | null;
}

export interface HookStatus {
  agent: AgentId;
  label: string;
  detected: boolean;
  installed: boolean;
  upToDate: boolean;
  configPath: string;
  relayPath: string;
  relayReady: boolean;
  note: string;
  error: string | null;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  program: string;
  installed: boolean;
  path: string | null;
  /** true signed in, false not, null: the tool can't tell. */
  signedIn: boolean | null;
  detail: string;
  /** Signed in with an API key: every message is billed. */
  billed: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logFile: string;
  relayPath: string;
  port: number | null;
}

export interface ChatEvent {
  id: string;
  /** "start" carries the provider's label. */
  kind: "start" | "delta" | "done" | "error" | "cancelled";
  text: string;
}

export type RoamKind = "approval" | "done" | "error";

/** What Mamori reaches out to say (see src-tauri/src/roam.rs). */
export interface RoamRequest {
  kind: RoamKind;
  title: string;
  text: string;
  /** The text is a command or code (monospace). */
  code?: boolean;
  agent?: AgentId | null;
  approvalId?: number | null;
  /** For approvals: when the card appeared and when it gives up (ms since epoch). */
  createdAt?: number | null;
  expiresAt?: number | null;
  /** What Mamori reaches out with: its head on the long neck, or a hand that taps the pointer. */
  reach?: "head" | "hand";
}

export interface CursorEvent {
  x: number;
  y: number;
  inside: boolean;
}

export const AGENT_COLORS: Record<AgentId, string> = {
  claude: "#FF8A5B",
  codex: "#4FD1C5",
  antigravity: "#7C9CFF",
};

/** Each agent's sessions get a Mamori of their own colour in the side column. */
export const AGENT_SKINS: Record<AgentId, ColorName> = {
  claude: "peach",
  codex: "mint",
  antigravity: "sky",
};

export const STATE_LABELS: Record<SessionState, string> = {
  idle: "ว่าง",
  thinking: "กำลังคิด",
  working: "กำลังทำงาน",
  approval: "รออนุมัติ",
  waiting: "รอคุณ",
  done: "เสร็จแล้ว",
  error: "มีปัญหา",
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
};
