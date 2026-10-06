import { describe, expect, it } from "vitest";
import { RecordingClosureSink, closureSinkFromEnv } from "./sink.js";

describe("closure sink from the environment", () => {
  it("none unless configured (closing is 503); memory only by explicit opt-in or under tests (T-032)", () => {
    expect(closureSinkFromEnv({ NODE_ENV: "development" })).toBeNull();
    expect(closureSinkFromEnv({ NODE_ENV: "development", CLOSURE_SINK: "memory" })).toBeInstanceOf(RecordingClosureSink);
    expect(closureSinkFromEnv({ NODE_ENV: "test" })).toBeInstanceOf(RecordingClosureSink);
    expect(closureSinkFromEnv({ NODE_ENV: "production", CLOSURE_SINK: "bogus" })).toBeNull();
  });
});

describe("recording sink (W3-1)", () => {
  it("never overwrites a table unless the caller owns it (replace: a retry of the same closing closure)", async () => {
    const sink = new RecordingClosureSink();
    await sink.write("closure_a", []);
    await expect(sink.write("closure_a", [])).rejects.toMatchObject({ code: "CONFLICT" });
    const row = { closure_id: "a" } as Parameters<RecordingClosureSink["write"]>[1][number];
    await sink.write("closure_a", [row], { replace: true });
    expect(sink.tables.get("closure_a")).toEqual([row]);
  });
});
