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
