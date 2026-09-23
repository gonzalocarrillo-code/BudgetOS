import { useEffect, useRef, useState } from "react";
import type { QueryRow, RowSource } from "./types.js";

const MAX_PAGES = 32;

interface Page {
  rows: QueryRow[];
  dataVersion: string;
  used: number;
}

export interface RowCacheController {
  get(index: number): QueryRow | undefined;
  readonly total: number;
  readonly dataVersion: string | undefined;
  setTotal(total: number): void;
  settled(): Promise<void>;
  dispose(): void;
}

export function createRowCache(
  source: RowSource,
  options: { pageSize: number; prefetch: number },
  onChange: () => void,
): RowCacheController {
  const pages = new Map<number, Page>();
  const inflight = new Map<number, Promise<void>>();
  let generation = 0;
  let clock = 0;
  let total = 0;
  let knownTotal: number | undefined;
  let dataVersion: string | undefined;
  let disposed = false;

  const touch = (page: Page): void => {
    clock += 1;
    page.used = clock;
  };

  const remember = (start: number, page: Page): void => {
    pages.set(start, page);
    while (pages.size > MAX_PAGES) {
      let oldestKey: number | undefined;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [key, value] of pages) {
        if (key === start) continue;
        if (value.used < oldestUsed) {
          oldestUsed = value.used;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      pages.delete(oldestKey);
    }
  };

  const request = (start: number): void => {
    if (disposed || start < 0) return;
    if (pages.has(start) || inflight.has(start)) return;
    if (knownTotal !== undefined && start >= knownTotal) return;
    const generationAtStart = generation;
    const chain = source
      .getRows({ start, end: start + options.pageSize })
      .then((result) => {
        if (generationAtStart !== generation || disposed) return;
        knownTotal = result.total;
        total = result.total;
        dataVersion = result.dataVersion;
        clock += 1;
        remember(start, { rows: result.rows, dataVersion: result.dataVersion, used: clock });
        onChange();
      })
      .finally(() => {
        if (inflight.get(start) === chain) inflight.delete(start);
      });
    inflight.set(start, chain);
  };

  const prefetchFrom = (start: number): void => {
    for (let step = 1; step <= options.prefetch; step += 1) {
      request(start + step * options.pageSize);
    }
  };

  const invalidate = (): void => {
    if (disposed) return;
    generation += 1;
    const loaded = [...pages.keys()];
    pages.clear();
    inflight.clear();
    for (const start of loaded) request(start);
    onChange();
  };

  const unsubscribe = source.subscribe(invalidate);
  request(0);
  prefetchFrom(0);

  const controller: RowCacheController = {
    get(index) {
      if (index < 0 || (knownTotal !== undefined && index >= knownTotal)) return undefined;
      const start = Math.floor(index / options.pageSize) * options.pageSize;
      const page = pages.get(start);
      if (page === undefined) {
        request(start);
        prefetchFrom(start);
        return undefined;
      }
      touch(page);
      return page.rows[index - start];
    },
    get total() {
      return total;
    },
    get dataVersion() {
      return dataVersion;
    },
    setTotal(next) {
      total = next;
      knownTotal = next;
      onChange();
    },
    async settled() {
      while (inflight.size > 0) {
        await Promise.all([...inflight.values()]);
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      pages.clear();
      inflight.clear();
      unsubscribe();
    },
  };
  return controller;
}

export function useRowCache(
  source: RowSource,
  options: { pageSize: number; prefetch: number },
): RowCacheController {
  const [, setVersion] = useState(0);
  const cacheRef = useRef<RowCacheController | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = createRowCache(source, options, () => {
      setVersion((version) => version + 1);
    });
  }
  useEffect(() => () => cacheRef.current?.dispose(), []);
  return cacheRef.current;
}
