// What you have picked so far on a question card (Claude Code's AskUserQuestion),
// one draft per card. The card asks its questions one at a time, the way Claude Code
// does: a single choice moves on as soon as you pick it, several choices wait for
// "ถัดไป" / "ส่งคำตอบ", and "อื่น ๆ" takes your own words.

import type { Answers, ApprovalView, Question } from "../core/types";

export interface Draft {
  id: number;
  /** The question on screen. */
  step: number;
  /** Picked labels per question, in the order the agent listed them. */
  picked: string[][];
  /** Your own words per question ("อื่น ๆ"). */
  other: string[];
  /** The question whose "อื่น ๆ" box is open, if any. */
  typing: number | null;
}

const drafts = new Map<number, Draft>();

export function draftFor(a: ApprovalView): Draft {
  let d = drafts.get(a.id);
  if (!d) {
    const n = a.questions?.length ?? 0;
    d = { id: a.id, step: 0, picked: Array.from({ length: n }, () => []), other: Array.from({ length: n }, () => ""), typing: null };
    drafts.set(a.id, d);
  }
  return d;
}

/** Forgets the drafts of cards that are gone. */
export function keepDrafts(live: ApprovalView[]) {
  for (const id of drafts.keys()) if (!live.some((a) => a.id === id)) drafts.delete(id);
}

/**
 * The answer to one question so far: the picked labels, then your own words ("" if
 * none). A single choice is either an option or your own words (opening "อื่น ๆ" lets
 * go of the option).
 */
export function answerOf(q: Question, d: Draft, i: number): string {
  const own = d.other[i]?.trim() ?? "";
  if (!q.multiSelect) return d.picked[i]?.[0] ?? own;
  const labels = q.options.map((o) => o.label).filter((l) => d.picked[i]?.includes(l));
  if (own) labels.push(own);
  return labels.join(", ");
}

/** Every question answered: what goes back to the agent; null while one is still open. */
export function answersOf(a: ApprovalView, d: Draft): Answers | null {
  const out: Answers = {};
  for (const [i, q] of (a.questions ?? []).entries()) {
    const answer = answerOf(q, d, i);
    if (!answer) return null;
    out[q.question] = answer;
  }
  return out;
}

/** Picks an option. A single choice replaces the last one; several toggle. */
export function pick(q: Question, d: Draft, label: string) {
  const list = d.picked[d.step];
  if (q.multiSelect) {
    const at = list.indexOf(label);
    if (at >= 0) list.splice(at, 1);
    else list.push(label);
  } else {
    d.picked[d.step] = [label];
    d.typing = null;
  }
}
