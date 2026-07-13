import { describe, it, expect, beforeEach } from "vitest";
import { useAttachmentStore } from "./attachment-store";

describe("attachment-store", () => {
  beforeEach(() => {
    useAttachmentStore.setState({ pending: [] });
  });

  it("adds and removes pending attachments", () => {
    useAttachmentStore.getState().add(["a.txt", "b.txt"]);
    expect(useAttachmentStore.getState().pending).toEqual(["a.txt", "b.txt"]);
    useAttachmentStore.getState().remove("a.txt");
    expect(useAttachmentStore.getState().pending).toEqual(["b.txt"]);
  });

  it("deduplicates added paths", () => {
    useAttachmentStore.getState().add(["a.txt"]);
    useAttachmentStore.getState().add(["a.txt", "b.txt"]);
    expect(useAttachmentStore.getState().pending).toEqual(["a.txt", "b.txt"]);
  });

  it("clears all pending attachments", () => {
    useAttachmentStore.getState().add(["a.txt"]);
    useAttachmentStore.getState().clear();
    expect(useAttachmentStore.getState().pending).toEqual([]);
  });
});
