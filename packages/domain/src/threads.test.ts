import { expect, it } from "vitest";
import { UpdateTagInput, extractMentions } from "./threads.js";

const u = "01927a00-0000-7000-8000-0000000000a1";
const g = "01927a00-0000-7000-8000-0000000000b2";

it("extracts canonical mentions and references, deduplicated in order", () => {
  const body = `@[user:${u}] can you check #[envelope:${g}]? cc @[group:${g}] and @[user:${u}] again; not @user or @[team:${u}]`;
  expect(extractMentions(body)).toEqual({
    mentions: [
      { type: "user", id: u },
      { type: "group", id: g },
    ],
    references: [{ type: "envelope", id: g }],
  });
  expect(extractMentions("no mentions")).toEqual({ mentions: [], references: [] });
});

it("a tag merge takes no other change", () => {
  expect(UpdateTagInput.safeParse({ mergeIntoId: u, name: "x" }).success).toBe(false);
});
