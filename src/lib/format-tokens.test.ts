import { describe, it, expect } from "vitest";
import { formatTokens } from "./format-tokens";

describe("formatTokens", () => {
  it("formats thousands with one decimal and lowercase k", () => {
    expect(formatTokens(62800)).toBe("62.8k");
    expect(formatTokens(53200)).toBe("53.2k");
    expect(formatTokens(1000)).toBe("1.0k");
  });

  it("formats millions with M", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("passes small counts through raw", () => {
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(0)).toBe("0");
  });
});
