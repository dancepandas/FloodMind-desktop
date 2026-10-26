import { describe, it, expect, beforeEach } from "vitest";
import { useAttachmentStore } from "./attachment-store";

beforeEach(() => useAttachmentStore.getState().clear());

describe("attachment-store images", () => {
  it("adds and removes image items by id", () => {
    const { addImages, removeImage } = useAttachmentStore.getState();
    addImages([{ id: "i1", name: "a.png", mime: "image/png", thumb: "data:x",
                source: "clipboard", data: "AAAA" }]);
    expect(useAttachmentStore.getState().images).toHaveLength(1);
    removeImage("i1");
    expect(useAttachmentStore.getState().images).toHaveLength(0);
  });

  it("clearImages empties images but leaves pending file refs", () => {
    const s = useAttachmentStore.getState();
    s.add(["foo.txt"]);
    s.addImages([{ id: "i1", name: "a.png", mime: "image/png", thumb: "",
                  source: "workspace", rel: "a.png" }]);
    s.clearImages();
    expect(useAttachmentStore.getState().images).toHaveLength(0);
    expect(useAttachmentStore.getState().pending).toEqual(["foo.txt"]);
  });

  it("toWire maps each source to its descriptor shape", () => {
    const s = useAttachmentStore.getState();
    s.addImages([
      { id: "w", name: "w.png", mime: "image/png", thumb: "", source: "workspace", rel: "sub/w.png" },
      { id: "f", name: "d.png", mime: "image/png", thumb: "", source: "file", absPath: "D:/d.png" },
      { id: "c", name: "p.png", mime: "image/png", thumb: "", source: "clipboard", data: "AAAA" },
    ]);
    const wire = useAttachmentStore.getState().toWire();
    expect(wire).toEqual([
      { source: "workspace", name: "sub/w.png", mime: "image/png" },
      { source: "file", path: "D:/d.png", mime: "image/png" },
      { source: "clipboard", data: "AAAA", mime: "image/png" },
    ]);
  });
});
