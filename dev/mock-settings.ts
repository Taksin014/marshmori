// Fakes the Rust side for the settings window:
// http://127.0.0.1:1420/dev/settings-mock.html#mamori   (welcome | general | mamori | approvals | agents | chat | about)

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

let settings = {
  mascotName: "Mamori",
  color: "cream",
  sound: true,
  volume: 0.6,
  eyesFollow: true,
  approvals: true,
  approvalTimeout: 110,
  antigravityApprovals: false,
  shortcuts: true,
  hideInFullscreen: true,
  toasts: true,
  autostart: false,
  screen: "primary",
  chatProvider: "auto",
  onboarded: true,
  roam: "all",
  autoHide: true,
  islandLook: "auto",
  hoverDelay: 600,
  islandBounce: "boing",
  motion: "system",
  reachWith: "auto",
  folderMenu: true,
  settingsVersion: 4,
};

const hook = (agent: string, label: string, installed: boolean) => ({
  agent,
  label,
  detected: true,
  installed,
  upToDate: installed,
  configPath: `C:\\Users\\me\\.${agent}\\settings.json`,
  relayPath: "C:\\Users\\me\\AppData\\Local\\Marshmori\\bin\\marshmori-hook.exe",
  relayReady: true,
  note: agent === "antigravity" ? "รีสตาร์ท Antigravity หนึ่งครั้งหลังติดตั้ง" : "ใช้ได้ทันทีกับ session ใหม่",
  error: null,
});

const providers = [
  { id: "claude", label: "Claude Code", program: "claude", installed: true, path: "C:\\Users\\me\\.local\\bin\\claude.exe", signedIn: true, detail: "ใช้แพ็กเกจ Claude ที่ล็อกอินไว้ (me@example.com)", billed: false },
  { id: "codex", label: "Codex", program: "codex", installed: true, path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", signedIn: true, detail: "ใช้แพ็กเกจ ChatGPT ที่ล็อกอินไว้", billed: false },
  { id: "antigravity", label: "Antigravity", program: "agy", installed: true, path: "C:\\Users\\me\\.local\\bin\\agy.exe", signedIn: null, detail: "ใช้บัญชี Google ที่ล็อกอินไว้ใน agy", billed: false },
  { id: "gemini", label: "Gemini CLI", program: "gemini", installed: false, path: null, signedIn: null, detail: "ยังไม่พบในเครื่องนี้ — ติดตั้งแล้วเปิด gemini ใน terminal เพื่อล็อกอินหนึ่งครั้ง", billed: false },
];

let connected = false;

mockWindows("settings");
mockIPC(
  (cmd, args) => {
    switch (cmd) {
      case "settings_get":
        return settings;
      case "settings_save":
        settings = (args as { settings: typeof settings }).settings;
        return settings;
      case "app_info":
        return { version: "0.7.2", dataDir: "C:\\Users\\me\\AppData\\Roaming\\Marshmori", logFile: "C:\\Users\\me\\AppData\\Local\\Marshmori\\marshmori.log", relayPath: "C:\\Users\\me\\AppData\\Local\\Marshmori\\bin\\marshmori-hook.exe", port: 51234 };
      case "hooks_status":
        return connected
          ? [hook("claude", "Claude Code", true), hook("codex", "Codex", true), hook("antigravity", "Antigravity", true)]
          : [hook("claude", "Claude Code", true), hook("codex", "Codex", false), hook("antigravity", "Antigravity", false)];
      case "hooks_install_all":
        connected = true;
        return [["codex", { Ok: "ติดตั้งแล้ว" }], ["antigravity", { Ok: "ติดตั้งแล้ว" }]];
      case "chat_providers":
        return providers;
      case "roam_test":
        return null;
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);
