// Drives the mocked island into a given state, for screenshots and manual checks.
// The window is 720 px wide, like the real one (the island sits in its top centre).

import { emit } from "@tauri-apps/api/event";

import { sessions, tasks } from "./mock-island";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "panel";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const point = (x: number, y: number, inside: boolean) => emit("cursor", { x, y, inside });
const hover = () => point(360, 18, true);
// For scripted recordings: move the pretend pointer from outside the page.
(window as unknown as { __point: typeof point }).__point = point;

async function run() {
  await wait(500);
  switch (scenario) {
    case "tuck":
      await point(120, 400, false);
      break;
    case "peek":
      await point(360, 10, false);
      break;
    case "pill":
      await point(120, 400, false);
      break;
    case "panel":
    case "empty":
    case "round":
      await hover();
      break;
    case "folder":
      await point(120, 400, false);
      await emit("tauri://drag-drop", { paths: ["C:\\โปรเจ็ค\\blog", "C:\\Users\\me\\Desktop\\notes.md"], position: { x: 360, y: 20 } });
      break;
    case "task-files": {
      await hover();
      await wait(1300);
      document.querySelector<HTMLButtonElement>(".head .task-btn")?.click();
      await wait(600);
      await emit("tauri://drag-drop", { paths: ["C:\\Users\\me\\Desktop\\error-screenshot.png", "C:\\โปรเจ็ค\\shop\\src\\Checkout.tsx"], position: { x: 360, y: 120 } });
      await wait(400);
      document.querySelector<HTMLButtonElement>(".toggle-chip")?.click();
      const ta = document.querySelector<HTMLTextAreaElement>(".task-form textarea")!;
      ta.value = "ดูรูป error นี้แล้วแก้ Checkout.tsx ให้หน่อย";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      break;
    }
    case "done":
    case "error": {
      await point(120, 400, false);
      await wait(300);
      const next = sessions.map((s) =>
        s.key === "claude:a"
          ? { ...s, state: scenario, activity: scenario === "done" ? "เสร็จแล้ว" : "มีปัญหา", detail: scenario === "done" ? "เพิ่มหน้า login พร้อมตรวจอีเมล/รหัสผ่านแล้ว" : "npm test ไม่ผ่าน 2 ตัว", stateSince: Date.now() }
          : s,
      );
      await emit("sessions", next);
      break;
    }
    case "chat": {
      await hover();
      await wait(1300);
      document.querySelector<HTMLButtonElement>('.head .icon-btn[aria-label^="แชทกับ"]')?.click();
      await wait(500);
      const ta = document.querySelector<HTMLTextAreaElement>(".compose textarea")!;
      ta.value = "npx tailwindcss init -p ขึ้นว่า could not determine executable to run คืออะไร";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(300);
      await emit("chat", { id: "chat1", kind: "start", text: "Claude Code" });
      await wait(400);
      const reply =
        "Tailwind v4 ไม่มีคำสั่ง `init` แล้ว เลยหาไฟล์รันไม่เจอครับ\n\nถ้าใช้ Vite ให้ทำแบบนี้แทน:\n```bash\nnpm install tailwindcss @tailwindcss/vite\n```\n- เพิ่ม `tailwindcss()` ใน **vite.config.ts**\n- ใส่ `@import \"tailwindcss\";` ในไฟล์ CSS";
      for (const part of reply.match(/[\s\S]{1,12}/g) ?? []) {
        await emit("chat", { id: "chat1", kind: "delta", text: part });
        await wait(12);
      }
      await emit("chat", { id: "chat1", kind: "done", text: "" });
      break;
    }
    case "task-form": {
      await hover();
      await wait(1300);
      document.querySelector<HTMLButtonElement>(".head .task-btn")?.click();
      await wait(600);
      const ta = document.querySelector<HTMLTextAreaElement>(".task-form textarea")!;
      ta.value = "หน้า checkout กดจ่ายเงินแล้วค้าง ช่วยหาสาเหตุแล้วแก้ให้หน่อย พร้อมเขียน test กันพังซ้ำ";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      break;
    }
    case "task-run": {
      await hover();
      await wait(1300);
      document.querySelector<HTMLButtonElement>(".head .task-btn")?.click();
      await wait(500);
      const ta = document.querySelector<HTMLTextAreaElement>(".task-form textarea")!;
      ta.value = "หน้า checkout กดจ่ายเงินแล้วค้าง ช่วยหาสาเหตุแล้วแก้ให้หน่อย";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(700);
      const base = {
        id: "t9",
        agent: "claude",
        agentLabel: "Claude Code",
        cwd: "C:\\โปรเจ็ค\\shop",
        project: "shop",
        mode: "ask",
        status: "running",
        agentSession: "s-9",
        sessionKey: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const turn = { prompt: ta.value || "หน้า checkout กดจ่ายเงินแล้วค้าง ช่วยหาสาเหตุแล้วแก้ให้หน่อย", result: "", error: null, status: "running", startedAt: Date.now(), endedAt: null };
      for (const activity of ["อ่าน Checkout.tsx", "ค้นหา \"submitPayment\"", "แก้ไข usePayment.ts"]) {
        await emit("task", { ...base, activity, turns: [turn] });
        await wait(450);
      }
      break;
    }
    case "task-done": {
      await hover();
      await wait(1300);
      document.querySelector<HTMLButtonElement>(".head .task-btn")?.click();
      await wait(500);
      document.querySelector<HTMLButtonElement>(".task-row")?.click();
      void tasks;
      break;
    }
    case "drop":
      await emit("tauri://drag-enter", { paths: ["a"], position: { x: 360, y: 20 } });
      break;
    case "file":
      await emit("tauri://drag-drop", { paths: ["a", "b", "c"], position: { x: 360, y: 20 } });
      break;
    case "away":
      await point(120, 400, false);
      await emit("roam-away", 1);
      break;
    default:
      break;
  }
  await wait(1200);
  document.body.dataset.ready = "1";
}

void run();
