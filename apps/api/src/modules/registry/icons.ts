import { DomainError } from "@budget/domain";
import { icons } from "lucide";
import type { AssetStore } from "./assets/asset-store.js";

function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

const lucideNames = new Set(Object.keys(icons).map(pascalToKebab));

export function assertIcon(icon: string, store: AssetStore): void {
  if (icon.startsWith("lucide:")) {
    const name = icon.slice("lucide:".length);
    if (!lucideNames.has(name)) {
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
