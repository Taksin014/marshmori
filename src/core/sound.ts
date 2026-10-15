// Mamori's sounds, synthesised with Web Audio: no audio files, nothing to license,
// and each one is a few short sine/triangle notes so they stay soft.

export type SoundName = "ask" | "done" | "error" | "pop" | "gulp" | "hello";

let ctx: AudioContext | null = null;
let enabled = true;
let volume = 0.6;

export function configureSound(on: boolean, vol: number) {
  enabled = on;
  volume = Math.max(0, Math.min(1, vol));
}

function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

interface Note {
  freq: number;
  to?: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function play(notes: Note[]) {
  const ac = audio();
  if (!ac || !enabled || volume <= 0) return;
  const master = ac.createGain();
  master.gain.value = 0.22 * volume;
  master.connect(ac.destination);
  const t0 = ac.currentTime + 0.01;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.dur);
    const peak = n.gain ?? 1;
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.05);
  }
}

export function sound(name: SoundName) {
  switch (name) {
    case "ask": // two rising boops: "excuse me?"
      play([
        { freq: 620, at: 0, dur: 0.12 },
        { freq: 830, at: 0.14, dur: 0.16 },
      ]);
      break;
    case "done": // a little three-note chime
      play([
        { freq: 523.25, at: 0, dur: 0.18, type: "triangle" },
        { freq: 659.25, at: 0.09, dur: 0.2, type: "triangle" },
        { freq: 783.99, at: 0.18, dur: 0.32, type: "triangle" },
      ]);
      break;
    case "error": // a soft downward "bonk"
      play([
        { freq: 330, to: 196, at: 0, dur: 0.22, gain: 0.9 },
        { freq: 196, to: 165, at: 0.2, dur: 0.18, gain: 0.6 },
      ]);
      break;
    case "pop":
      play([{ freq: 880, to: 1320, at: 0, dur: 0.07 }]);
      break;
    case "gulp": // swallowing a file
      play([
        { freq: 520, to: 180, at: 0, dur: 0.16 },
        { freq: 660, at: 0.18, dur: 0.08, gain: 0.5 },
      ]);
      break;
    case "hello":
      play([
        { freq: 700, to: 900, at: 0, dur: 0.1 },
        { freq: 1050, at: 0.1, dur: 0.12, gain: 0.7 },
      ]);
      break;
  }
}
