// The island's look (and the bubbles Mamori brings out on the screen): light or dark
// with the system, always dark, always light, or one of the themes. The pages style
// themselves from `<html data-look="…">`.

import type { IslandLook } from "./types";

export type ResolvedLook = Exclude<IslandLook, "auto">;

const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function resolveLook(look: IslandLook | undefined): ResolvedLook {
  if (look && look !== "auto") return look;
  return dark?.matches === false ? "light" : "dark";
}

/** Sets the look on the page now, and again whenever the system switches light/dark. */
export function useLook(get: () => IslandLook | undefined, changed?: (look: ResolvedLook) => void): () => void {
  const apply = () => {
    const look = resolveLook(get());
    if (document.documentElement.dataset.look !== look) {
      document.documentElement.dataset.look = look;
      changed?.(look);
    }
  };
  apply();
  dark?.addEventListener("change", apply);
  return apply;
}
