import { DomainError } from "@budget/domain";
import createDOMPurify from "dompurify";
import { optimize } from "svgo";

const SVG_MAX_BYTES = 50 * 1024;

/**
 * jsdom 30 bundles undici 8, and importing it installs undici 8 as Node's global HTTP dispatcher.
 * In this process that left compressed responses undecoded: Slack's replies read as gzip bytes
 * ("An API error occurred: <binary>"), as IAP's keys had (ADR-065). So jsdom loads only when an
 * icon is sanitized, and whatever dispatcher was there before is put back at once.
 */
const DISPATCHER = Symbol.for("undici.globalDispatcher.1");
let purify: ReturnType<typeof createDOMPurify> | null = null;
async function purifier(): Promise<ReturnType<typeof createDOMPurify>> {
  if (purify) return purify;
  const g = globalThis as Record<symbol, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, DISPATCHER);
  const before = g[DISPATCHER];
  const { JSDOM } = await import("jsdom");
  if (had) g[DISPATCHER] = before;
  else delete g[DISPATCHER];
  purify = createDOMPurify(new JSDOM("").window as Parameters<typeof createDOMPurify>[0]);
  return purify;
}

export async function sanitizeSvg(svg: string): Promise<string> {
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
  const clean = (await purifier()).sanitize(optimized.data, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  const lowered = clean.toLowerCase();
  if (!clean.includes("<svg") || lowered.includes("<script") || /\son\w+=/i.test(clean) || lowered.includes("javascript:")) {
    throw new DomainError("VALIDATION", "SVG icon was rejected by the sanitizer");
  }
  return clean;
}
