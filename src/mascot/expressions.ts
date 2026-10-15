// What every Marshmori face is made of: eyes, mouth, brows, cheeks, how the sprout
// and the body move, what the little hands do, and the effects around the head.

import type { HangKind } from "./rig";

export type ExpressionName =
  | "normal" | "happy" | "excited" | "thinking" | "working" | "sleepy" | "surprised"
  | "sad" | "angry" | "love" | "confused" | "shy" | "ask" | "done" | "error"
  | "eat" | "waiting" | "wink" | "annoyed" | "dizzy" | "relaxed" | "pout" | "tired" | "adore";

export const EXPRESSIONS: ExpressionName[] = [
  "normal", "happy", "excited", "thinking", "working", "sleepy", "surprised", "sad", "angry",
  "love", "confused", "shy", "relaxed", "pout", "tired", "ask", "done", "error", "eat", "waiting",
  "wink", "annoyed", "dizzy", "adore",
];

export const EXPRESSION_LABELS: Record<ExpressionName, string> = {
  normal: "ปกติ",
  happy: "ยิ้ม",
  excited: "ตื่นเต้น",
  thinking: "คิด",
  working: "ทำงาน",
  sleepy: "ง่วง",
  surprised: "ตกใจ",
  sad: "เศร้า",
  angry: "โกรธ",
  love: "รัก",
  confused: "งง",
  shy: "เขิน",
  ask: "รออนุมัติ",
  done: "เสร็จแล้ว",
  error: "มีปัญหา",
  eat: "งับไฟล์",
  waiting: "รอคุณ",
  wink: "ขยิบตา",
  annoyed: "หงุดหงิด",
  dizzy: "มึน",
  relaxed: "สบาย ๆ",
  pout: "งอน",
  tired: "เหนื่อย",
  adore: "หลงรัก",
};

export type EyeKind =
  | "round" | "wide" | "happy" | "closed" | "focus" | "tired" | "star" | "heart" | "swirl"
  | "x" | "wink" | "up" | "squint";
export type MouthKind =
  | "smile" | "small" | "grin" | "cat" | "o" | "open" | "flat" | "frown" | "wavy" | "smirk" | "tongue" | "pout";
export type BrowKind = "none" | "angry" | "worried";
export type SproutKind = "sway" | "wiggle" | "tilt" | "perk" | "droop" | "fold" | "bloom" | "spin";
export type MotionKind = "breathe" | "bounce" | "bob" | "hop" | "wiggle" | "shiver" | "sway" | "sink" | "wobble" | "still";
export type Effect = "zz" | "sparkle" | "hearts" | "tear" | "anger" | "question" | "bang" | "dots" | "sweat" | "stars" | "rays" | "scribble";

export interface Expression {
  eyes: EyeKind;
  mouth: MouthKind;
  brows?: BrowKind;
  /** Pink in the cheeks, 0…1. */
  blush: number;
  sprout: SproutKind;
  motion: MotionKind;
  effects?: Effect[];
  /** Where the eyes look on their own (-1…1), when the face wants that. */
  look?: [number, number];
  /** Washes the colour out (a sick-looking error face). */
  tint?: number;
  /** What the two little hands do while only the head shows (the island). */
  hands?: HangKind;
  /** Frames per second this face needs to look smooth. */
  fps: number;
}

export const EXPR: Record<ExpressionName, Expression> = {
  normal:    { eyes: "round", mouth: "smile", blush: 0.6, sprout: "sway", motion: "breathe", fps: 30 },
  happy:     { eyes: "round", mouth: "grin", blush: 0.85, sprout: "wiggle", motion: "bounce", effects: ["rays"], hands: "pat", fps: 60 },
  excited:   { eyes: "wide", mouth: "grin", blush: 0.9, sprout: "perk", motion: "hop", effects: ["sparkle", "rays"], hands: "up", fps: 60 },
  thinking:  { eyes: "up", mouth: "small", blush: 0.45, sprout: "tilt", motion: "sway", effects: ["dots"], look: [0.55, -0.9], hands: "chin", fps: 30 },
  working:   { eyes: "round", mouth: "tongue", blush: 0.5, sprout: "spin", motion: "bob", look: [0.3, 0.55], hands: "type", fps: 60 },
  sleepy:    { eyes: "closed", mouth: "small", blush: 0.5, sprout: "fold", motion: "sink", effects: ["zz"], hands: "low", fps: 30 },
  surprised: { eyes: "wide", mouth: "o", blush: 0.4, sprout: "perk", motion: "still", effects: ["bang"], hands: "up", fps: 30 },
  sad:       { eyes: "round", mouth: "frown", blush: 0.35, sprout: "droop", motion: "sink", effects: ["tear"], look: [0, 0.35], hands: "low", fps: 30 },
  angry:     { eyes: "round", mouth: "frown", brows: "angry", blush: 0.9, sprout: "perk", motion: "shiver", effects: ["anger"], hands: "shake", fps: 60 },
  love:      { eyes: "round", mouth: "cat", blush: 1, sprout: "wiggle", motion: "bounce", effects: ["hearts"], hands: "cheeks", fps: 60 },
  confused:  { eyes: "round", mouth: "wavy", blush: 0.45, sprout: "tilt", motion: "sway", effects: ["question"], look: [-0.35, -0.2], hands: "chin", fps: 60 },
  shy:       { eyes: "closed", mouth: "small", blush: 1, sprout: "fold", motion: "breathe", hands: "cheeks", fps: 30 },
  relaxed:   { eyes: "closed", mouth: "smile", blush: 0.75, sprout: "sway", motion: "sink", hands: "low", fps: 30 },
  pout:      { eyes: "round", mouth: "pout", blush: 0.95, sprout: "droop", motion: "breathe", look: [-0.5, 0.15], fps: 30 },
  tired:     { eyes: "tired", mouth: "flat", blush: 0.5, sprout: "droop", motion: "sink", effects: ["scribble"], hands: "low", fps: 30 },
  ask:       { eyes: "wide", mouth: "o", blush: 0.55, sprout: "perk", motion: "wiggle", effects: ["bang"], hands: "wave", fps: 60 },
  done:      { eyes: "happy", mouth: "grin", blush: 0.85, sprout: "bloom", motion: "hop", effects: ["sparkle"], hands: "up", fps: 60 },
  error:     { eyes: "x", mouth: "wavy", blush: 0.15, sprout: "droop", motion: "shiver", effects: ["sweat"], tint: 0.45, hands: "shake", fps: 60 },
  eat:       { eyes: "wide", mouth: "open", blush: 0.6, sprout: "perk", motion: "wiggle", hands: "up", fps: 60 },
  waiting:   { eyes: "round", mouth: "small", blush: 0.55, sprout: "sway", motion: "breathe", effects: ["dots"], hands: "tap", fps: 30 },
  wink:      { eyes: "wink", mouth: "cat", blush: 0.8, sprout: "wiggle", motion: "bounce", effects: ["sparkle"], hands: "wave", fps: 60 },
  annoyed:   { eyes: "squint", mouth: "pout", blush: 0.9, sprout: "perk", motion: "shiver", effects: ["anger"], hands: "shake", fps: 60 },
  dizzy:     { eyes: "swirl", mouth: "wavy", blush: 0.5, sprout: "spin", motion: "wobble", effects: ["stars"], hands: "low", fps: 60 },
  adore:     { eyes: "heart", mouth: "cat", blush: 1, sprout: "bloom", motion: "bounce", effects: ["hearts", "sparkle"], hands: "cheeks", fps: 60 },
};

/**
 * The little bud on top of Mamori's sprout that says what is going on, in a colour of
 * its own: thinking it over, working, waiting on you, done, a problem, or just here.
 */
export type BadgeKind = "thinking" | "working" | "ask" | "waiting" | "done" | "error" | "online";

export const BADGE_COLORS: Record<BadgeKind, string> = {
  thinking: "#A68CF0",
  working: "#4FA3F7",
  ask: "#F5B53D",
  waiting: "#F59A6B",
  done: "#45B46A",
  error: "#EE5A55",
  online: "#4CC970",
};

export const BADGE_LABELS: Record<BadgeKind, string> = {
  thinking: "กำลังคิด",
  working: "กำลังทำงาน",
  ask: "รอคุณอนุมัติ",
  waiting: "รอคำสั่ง",
  done: "เสร็จแล้ว",
  error: "มีปัญหา",
  online: "อยู่ตรงนี้",
};

/** The bud a face brings with it (a face not listed has none). */
export const BADGE_FOR: Partial<Record<ExpressionName, BadgeKind>> = {
  thinking: "thinking",
  working: "working",
  ask: "ask",
  waiting: "waiting",
  done: "done",
  error: "error",
};

/**
 * The colour a feeling washes over Mamori's head: strongest on top, fading down into
 * its own colour by the cheeks — red when angry, blue when sad, pink when in love.
 * `amount` is how strong it is at the very top (0…1). A face not listed keeps its colour.
 */
export const MOOD_COLORS: Partial<Record<ExpressionName, { color: string; amount: number }>> = {
  angry: { color: "#FF3B3B", amount: 0.86 },
  annoyed: { color: "#FF6A3D", amount: 0.62 },
  pout: { color: "#FF8A6B", amount: 0.45 },
  error: { color: "#8E6CF2", amount: 0.58 },
  sad: { color: "#4C8DF6", amount: 0.62 },
  tired: { color: "#7D8FB8", amount: 0.48 },
  sleepy: { color: "#9AA8D6", amount: 0.36 },
  love: { color: "#FF6F9F", amount: 0.6 },
  adore: { color: "#FF5C93", amount: 0.7 },
  shy: { color: "#FF8FB0", amount: 0.55 },
  happy: { color: "#FFC24D", amount: 0.46 },
  excited: { color: "#FFB13D", amount: 0.56 },
  done: { color: "#45B46A", amount: 0.5 },
  ask: { color: "#F5B53D", amount: 0.52 },
  thinking: { color: "#A68CF0", amount: 0.42 },
  working: { color: "#4FA3F7", amount: 0.3 },
  waiting: { color: "#F59A6B", amount: 0.3 },
  surprised: { color: "#6EC8FF", amount: 0.46 },
  confused: { color: "#B39DFF", amount: 0.46 },
  dizzy: { color: "#B07CFF", amount: 0.56 },
};

export type ColorName = "cream" | "mint" | "lilac" | "peach" | "butter" | "sky";

export const COLOR_NAMES: ColorName[] = ["cream", "mint", "lilac", "peach", "butter", "sky"];

/** Body colours: the base (lit) tone of the soft skin. */
export const SKIN: Record<ColorName, string> = {
  cream: "#F4E9E0",
  mint: "#CBE8D5",
  lilac: "#E0D6F5",
  peach: "#F8D5C4",
  butter: "#F7E6B5",
  sky: "#D3E4F4",
};

export const COLOR_LABELS: Record<ColorName, string> = {
  cream: "ครีม",
  mint: "มิ้นต์",
  lilac: "ลาเวนเดอร์",
  peach: "พีช",
  butter: "เนย",
  sky: "ฟ้า",
};
