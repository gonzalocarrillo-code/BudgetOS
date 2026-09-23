import type { GridEvents } from "./types.js";

export function forwardPaste(
  events: GridEvents,
  target: readonly [number, number],
  values: readonly (readonly string[])[],
): false {
  const col = target[0];
  const row = target[1];
  events.onPaste({
    anchor: { col, row },
    cells: values.map((line) => [...line]),
  });
  return false;
}
