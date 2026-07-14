import { test, expect, vi } from "vitest";
import { fetchFilePreview } from "./preview";
import * as client from "./sidecar-client";

test("fetchFilePreview returns content and mime", async () => {
  vi.spyOn(client, "getBaseUrl").mockResolvedValue("http://localhost");
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: "hello", mime: "text/plain" }),
  });
  const out = await fetchFilePreview("a.txt");
  expect(out).toEqual({ content: "hello", mime: "text/plain" });
});
