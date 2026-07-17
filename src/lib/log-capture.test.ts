import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initLogCapture, getRecentLogs, _resetCapture } from "./log-capture";

describe("log-capture", () => {
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  beforeEach(() => {
    _resetCapture();
    initLogCapture();
  });

  afterEach(() => {
    Object.assign(console, originals);
    _resetCapture();
  });

  it("captures console output", () => {
    console.log("hello");
    console.warn("careful");
    const logs = getRecentLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].level).toBe("log");
    expect(logs[0].message).toBe("hello");
    expect(logs[1].level).toBe("warn");
  });

  it("serializes objects", () => {
    console.log({ a: 1 });
    expect(getRecentLogs()[0].message).toBe('{"a":1}');
  });

  it("keeps a bounded buffer", () => {
    for (let i = 0; i < 320; i++) {
      console.log(String(i));
    }
    expect(getRecentLogs().length).toBeLessThanOrEqual(300);
  });
});
