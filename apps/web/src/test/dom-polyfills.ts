/**
 * jsdom (the `*.test.tsx` environment, vitest.config.mjs `environmentMatchGlobs`) does not implement
 * a few browser APIs that Radix UI primitives (Dialog, Popover, DropdownMenu, Tooltip — used by
 * @budget/ui's Modal/Menu/Popover/Button) call unconditionally. Importing this file for its side
 * effects, before rendering any component that uses those primitives, stubs them out so the tests
 * can drive real open/close/focus behaviour instead of crashing on a missing method.
 */
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class StubResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (window as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
  }

  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  const proto = Element.prototype as Element & {
    hasPointerCapture?: (id: number) => boolean;
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
    scrollIntoView?: () => void;
  };
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
}
