import { DomainError } from "@budget/domain";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { optimize } from "svgo";

const SVG_MAX_BYTES = 50 * 1024;

const window = new JSDOM("").window;
const purify = createDOMPurify(window as Parameters<typeof createDOMPurify>[0]);

export function sanitizeSvg(svg: string): string {
  if (Buffer.byteLength(svg, "utf8") > SVG_MAX_BYTES) {
    throw new DomainError("VALIDATION", "SVG icon must be 50 KB or smaller");
  }
  if (!svg.includes("<svg")) {
    throw new DomainError("VALIDATION", "Icon upload must be an SVG");
  }
  const optimized = optimize(svg, { multipass: true });
  if (!("data" in optimized) || optimized.data.length === 0) {
    throw new DomainError("VALIDATION", "SVG icon could not be sanitized");
  }
  const clean = purify.sanitize(optimized.data, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  const lowered = clean.toLowerCase();
  if (!clean.includes("<svg") || lowered.includes("<script") || /\son\w+=/i.test(clean) || lowered.includes("javascript:")) {
    throw new DomainError("VALIDATION", "SVG icon was rejected by the sanitizer");
  }
  return clean;
}
