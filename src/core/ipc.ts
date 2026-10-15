// Typed wrappers around the Rust commands and events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import type {
  AppInfo,
  ApprovalView,
  ChatEvent,
  ChatProviderSetting,
  ColorName,
  CursorEvent,
  FileInfo,
  HistoryItem,
  HookStatus,
  IslandLook,
  OpenRequest,
  ProviderStatus,
  RoamRequest,
  Session,
  Settings,
  Snapshot,
  Task,
  TaskRequest,
  TaskSnapshot,
} from "./types";

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Paths of files attached to this message. */
  files?: string[];
}

export interface Point {
  x: number;
  y: number;
}

export const api = {
  snapshot: () => invoke<Snapshot>("island_snapshot"),
  setHitRects: (rects: HitRect[]) => invoke<void>("island_set_hit_rects", { rects }),
  setInteractive: (on: boolean, focus = true) => invoke<void>("island_set_interactive", { on, focus }),
  hideIsland: () => invoke<void>("island_hide"),
  showIsland: () => invoke<void>("island_show"),
  takeOpen: () => invoke<OpenRequest | null>("island_take_open"),
  ackApproval: (id: number) => invoke<boolean>("approval_ack", { id }),
  decide: (id: number, decision: "allow" | "always" | "deny" | "terminal") =>
    invoke<boolean>("approval_decide", { id, decision }),
  history: () => invoke<HistoryItem[]>("history_list"),
  dismissSession: (key: string) => invoke<void>("session_dismiss", { key }),
  allowAllOff: (key: string) => invoke<boolean>("session_allow_all_off", { key }),
  chatSend: (provider: ChatProviderSetting, messages: ChatMessage[]) =>
    invoke<string>("chat_send", { request: { provider, messages: messages.map((m) => ({ ...m, files: m.files ?? [] })) } }),
  chatCancel: (id: string) => invoke<void>("chat_cancel", { id }),
  chatProviders: (refresh = false) => invoke<ProviderStatus[]>("chat_providers", { refresh }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  // Tasks Mamori runs in the background.
  taskList: () => invoke<TaskSnapshot>("task_list"),
  taskStart: (request: TaskRequest) =>
    invoke<Task>("task_start", { request: { agent: "", cwd: "", mode: "", files: [], continueLast: false, ...request } }),
  taskCancel: (id: string) => invoke<void>("task_cancel", { id }),
  taskDismiss: (id: string) => invoke<boolean>("task_dismiss", { id }),
  taskPickFolder: () => invoke<string | null>("task_pick_folder"),
  taskPickFiles: (start?: string) => invoke<string[]>("task_pick_files", { start: start ?? null }),
  inspectFiles: (paths: string[]) => invoke<FileInfo[]>("files_inspect", { paths }),
  demo: () => invoke<void>("demo_run"),
  openSettings: (tab?: string) => invoke<void>("settings_open", { tab: tab ?? null }),
  closeSettings: () => invoke<void>("settings_close"),
  getSettings: () => invoke<Settings>("settings_get"),
  saveSettings: (settings: Settings) => invoke<Settings>("settings_save", { settings }),
  hooksStatus: () => invoke<HookStatus[]>("hooks_status"),
  installHooks: (agent: string) => invoke<string>("hooks_install", { agent }),
  installAllHooks: () => invoke<[string, { Ok?: string; Err?: string }][]>("hooks_install_all"),
  uninstallHooks: (agent: string) => invoke<string>("hooks_uninstall", { agent }),
  appInfo: () => invoke<AppInfo>("app_info"),
  // Mamori's trips to the mouse pointer.
  roamStart: (request: RoamRequest, nest: Point, nestScale: number) =>
    invoke<boolean>("roam_start", { request, nest, nestScale }),
  roamNest: (nest: Point, nestScale: number) => invoke<void>("roam_nest", { nest, nestScale }),
  roamReady: () => invoke<void>("roam_ready"),
  roamShown: (trip: number) => invoke<void>("roam_shown", { trip }),
  roamDone: (trip: number) => invoke<void>("roam_done", { trip }),
  roamSetHitRects: (rects: HitRect[]) => invoke<void>("roam_set_hit_rects", { rects }),
  roamOpen: () => invoke<void>("roam_open"),
  roamRecall: () => invoke<void>("roam_recall"),
  roamTest: () => invoke<void>("roam_test"),
  log: (text: string) => invoke<void>("log_line", { text }).catch(() => {}),
};

/**
 * Listens to events sent to this window (and to every window). A plain `listen()`
 * also receives events Rust sends to *other* windows with `emit_to`, which matters
 * now that the island and the roam overlay both follow "cursor" and "approvals".
 */
function scoped<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  let label: string | null = null;
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    label = null;
  }
  return label ? listen<T>(event, cb, { target: { kind: "WebviewWindow", label } }) : listen<T>(event, cb);
}

export const on = {
  sessions: (cb: (s: Session[]) => void) => scoped<Session[]>("sessions", (e) => cb(e.payload)),
  approvals: (cb: (a: ApprovalView[]) => void) => scoped<ApprovalView[]>("approvals", (e) => cb(e.payload)),
  history: (cb: (h: HistoryItem) => void) => scoped<HistoryItem>("history", (e) => cb(e.payload)),
  cursor: (cb: (c: CursorEvent) => void) => scoped<CursorEvent>("cursor", (e) => cb(e.payload)),
  settings: (cb: (s: Settings) => void) => scoped<Settings>("settings", (e) => cb(e.payload)),
  chat: (cb: (c: ChatEvent) => void) => scoped<ChatEvent>("chat", (e) => cb(e.payload)),
  task: (cb: (t: Task) => void) => scoped<Task>("task", (e) => cb(e.payload)),
  taskRemoved: (cb: (id: string) => void) => scoped<string>("task-removed", (e) => cb(e.payload)),
  openTask: (cb: (req: OpenRequest) => void) => scoped<OpenRequest>("open-task", (e) => cb(e.payload)),
  visible: (cb: (v: boolean) => void) => scoped<boolean>("island-visible", (e) => cb(e.payload)),
  hooks: (cb: (h: HookStatus[]) => void) => scoped<HookStatus[]>("hooks", (e) => cb(e.payload)),
  settingsTab: (cb: (tab: string) => void) => scoped<string>("settings-tab", (e) => cb(e.payload)),
  // Island side of a trip.
  roamAway: (cb: (trip: number) => void) => scoped<number>("roam-away", (e) => cb(e.payload)),
  roamHome: (cb: (trip: number) => void) => scoped<number>("roam-home", (e) => cb(e.payload)),
  roamOpen: (cb: () => void) => scoped<null>("roam-open", () => cb()),
  roamTest: (cb: () => void) => scoped<null>("roam-test", () => cb()),
  // Overlay side.
  roamGo: (cb: (go: RoamGo) => void) => scoped<RoamGo>("roam-go", (e) => cb(e.payload)),
  roamNest: (cb: (n: { nest: Point; nestScale: number }) => void) =>
    scoped<{ nest: Point; nestScale: number }>("roam-nest", (e) => cb(e.payload)),
  roamRecall: (cb: () => void) => scoped<null>("roam-recall", () => cb()),
  roamAbort: (cb: () => void) => scoped<null>("roam-abort", () => cb()),
};

/** Sent to the overlay to start a trip, in the overlay's own CSS pixels. */
export interface RoamGo {
  trip: number;
  request: RoamRequest;
  nest: Point;
  nestScale: number;
  cursor: Point;
  /** The overlay's size in CSS pixels. */
  screen: Point;
  color: ColorName;
  /** The island's look: the bubble matches it. */
  look: IslandLook;
  sound: boolean;
  volume: number;
}

export type { UnlistenFn };

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}
