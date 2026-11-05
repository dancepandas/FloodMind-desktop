import { describe, it, expect, vi, afterEach } from "vitest";
import {
  partitionPaths,
  listExternalPaths,
  registerExternalPaths,
  removeExternalPath,
} from "./external-paths";

const { getBaseUrlMock } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(async () => "http://test"),
}));
vi.mock("./sidecar-client", () => ({ getBaseUrl: getBaseUrlMock }));

describe("partitionPaths", () => {
  it("splits paths under the workspace root as inside, others as outside", () => {
    const { inside, outside } = partitionPaths(
      [
        "C:\\ws\\data\\info.csv",
        "C:\\ws\\report.xlsx",
        "D:\\outside\\notes.txt",
      ],
      "C:\\ws",
    );
    expect(inside).toEqual(["C:\\ws\\data\\info.csv", "C:\\ws\\report.xlsx"]);
    expect(outside).toEqual(["D:\\outside\\notes.txt"]);
  });

  it("treats the workspace root itself as inside", () => {
    const { inside, outside } = partitionPaths(["C:\\ws"], "C:\\ws");
    expect(inside).toEqual(["C:\\ws"]);
    expect(outside).toEqual([]);
  });

  it("handles forward slashes and trailing slashes case-insensitively", () => {
    const { inside, outside } = partitionPaths(
      ["c:/WS/data/info.csv", "C:/ws/", "D:/other/file.txt"],
      "C:\\ws\\",
    );
    expect(inside).toEqual(["c:/WS/data/info.csv", "C:/ws/"]);
    expect(outside).toEqual(["D:/other/file.txt"]);
  });

  it("classifies everything as outside when no workspace is open", () => {
    const { inside, outside } = partitionPaths(["C:\\anywhere\\f.txt"]);
    expect(inside).toEqual([]);
    expect(outside).toEqual(["C:\\anywhere\\f.txt"]);
  });

  it("does not treat a sibling directory as inside (prefix must be path-boundary)", () => {
    const { inside, outside } = partitionPaths(["C:\\wsx\\not-in-ws.txt"], "C:\\ws");
    expect(inside).toEqual([]);
    expect(outside).toEqual(["C:\\wsx\\not-in-ws.txt"]);
  });
});

describe("external-paths client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registerExternalPaths POSTs the paths and returns the persisted list", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init: RequestInit) =>
      new Response(JSON.stringify({ paths: ["C:\\a.txt"] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await registerExternalPaths(["C:\\a.txt"]);
    expect(out).toEqual(["C:\\a.txt"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test/api/external-paths");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ paths: ["C:\\a.txt"] });
  });

  it("listExternalPaths GETs and maps the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ paths: ["a", "b"] }), { status: 200 })),
    );
    expect(await listExternalPaths()).toEqual(["a", "b"]);
  });

  it("removeExternalPath DELETEs the path", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init: RequestInit) =>
      new Response(JSON.stringify({ paths: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await removeExternalPath("C:\\a.txt");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test/api/external-paths");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ path: "C:\\a.txt" });
  });
});
