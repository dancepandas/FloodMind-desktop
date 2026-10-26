import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time";

const now = new Date("2026-03-15T12:00:00Z");
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("returns 刚刚 within one minute", () => {
    expect(relativeTime(iso(0), now)).toBe("刚刚");
    expect(relativeTime(iso(59_000), now)).toBe("刚刚");
  });

  it("returns N 分钟 under an hour", () => {
    expect(relativeTime(iso(MIN), now)).toBe("1 分钟");
    expect(relativeTime(iso(5 * MIN), now)).toBe("5 分钟");
    expect(relativeTime(iso(59 * MIN), now)).toBe("59 分钟");
  });

  it("returns N 小时 under a day", () => {
    expect(relativeTime(iso(HOUR), now)).toBe("1 小时");
    expect(relativeTime(iso(23 * HOUR + 59 * MIN), now)).toBe("23 小时");
  });

  it("returns N 天 under a week", () => {
    expect(relativeTime(iso(DAY), now)).toBe("1 天");
    expect(relativeTime(iso(6 * DAY), now)).toBe("6 天");
  });

  it("returns N 周 up to 30 days", () => {
    expect(relativeTime(iso(7 * DAY), now)).toBe("1 周");
    expect(relativeTime(iso(30 * DAY), now)).toBe("4 周");
  });

  it("falls back to M/D after 30 days in the same year", () => {
    expect(relativeTime(iso(31 * DAY), now)).toBe("2/12");
  });

  it("prefixes the year across year boundaries", () => {
    expect(relativeTime(iso(300 * DAY), now)).toBe("2025/5/19");
  });

  it("returns an empty string for invalid input", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });

  it("returns an empty string for future timestamps", () => {
    expect(relativeTime(iso(-HOUR), now)).toBe("");
  });
});
