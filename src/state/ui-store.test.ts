import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";
import { useBackgroundTaskStore } from "./background-task-store";

afterEach(() => {
  useUiStore.getState().resetInspector();
  useBackgroundTaskStore.setState({ panelOpen: false });
});

describe("inspector commands", () => {
  it("opens arbitrary file paths in artifacts, and returns from detail without closing", () => {
    useUiStore.getState().setPreviewPath("D:\\external\\notes.txt");
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "artifacts", previewPath: "D:\\external\\notes.txt" });
    useUiStore.getState().closePreview();
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "artifacts", previewPath: null });
  });
  it("keeps selection across tabs and inspector close, and clears on reset", () => {
    const ui = useUiStore.getState();
    ui.setPreviewPath("report.md");
    ui.openInspector("tasks");
    ui.closeInspector();
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: false, inspectorTab: "tasks", previewPath: "report.md", inspectorDismissed: true });
    ui.resetInspector();
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: false, inspectorTab: "artifacts", previewPath: null, inspectorDismissed: false });
  });
  it("preserves plan entry commands without a second visibility flag", () => {
    const ui = useUiStore.getState();
    ui.setPlanPanelOpen(true);
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "plan" });
    ui.togglePlanPanel();
    expect(useUiStore.getState().inspectorOpen).toBe(false);
    ui.togglePlanPanel();
    expect(useUiStore.getState().inspectorOpen).toBe(true);
    ui.openInspector("artifacts");
    ui.setPlanPanelOpen(false);
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "artifacts" });
  });
  it("adapts background entry commands without syncing legacy flags back", () => {
    const bg = useBackgroundTaskStore.getState();
    bg.setPanelOpen(true);
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "tasks" });
    useUiStore.getState().openInspector("artifacts");
    expect(useBackgroundTaskStore.getState().panelOpen).toBe(true);
    bg.setPanelOpen(false);
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "artifacts" });
    bg.setPanelOpen(true);
    bg.setPanelOpen(false);
    expect(useUiStore.getState().inspectorOpen).toBe(false);
  });
});
