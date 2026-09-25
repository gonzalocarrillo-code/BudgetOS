import { DomainError } from "@budget/domain";
import { icons } from "lucide";
import type { AssetStore } from "./assets/asset-store.js";

/**
 * Lucide's kebab names (`bar-chart-2`, `arrow-down-0-1`, `axis-3d`) are its PascalCase keys with
 * hyphens between words and digit runs. Hyphen placement around digits is not recoverable from the
 * key, so names compare with hyphens and case removed; that accepts every name the web picker
 * (lucide-react's `iconNames`) offers, and nothing that is not an icon.
 */
const squash = (name: string) => name.replace(/-/g, "").toLowerCase();
const lucideNames = new Set(Object.keys(icons).map(squash));

export function isLucideName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && lucideNames.has(squash(name));
}

export function assertIcon(icon: string, store: AssetStore): void {
  if (icon.startsWith("lucide:")) {
    const name = icon.slice("lucide:".length);
    if (!isLucideName(name)) {
      throw new DomainError("VALIDATION", `Unknown Lucide icon ${name}`);
    }
    return;
  }
  if (icon.startsWith("asset:")) {
    const objectKey = icon.slice("asset:".length);
    if (objectKey.length === 0 || !store.has(objectKey)) {
      throw new DomainError("VALIDATION", "Icon asset was not uploaded");
    }
    return;
  }
  throw new DomainError("VALIDATION", "Icon must be lucide:<name> or asset:<gcsObject>");
}
