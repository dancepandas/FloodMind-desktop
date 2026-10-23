import { useEffect, useMemo } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useChatStore } from "../state/chat-store";
import { useUiStore, type InspectorTab } from "../state/ui-store";
import { conversationArtifacts, findLatestPlan } from "../lib/context-data";
import { runningCount, useBackgroundTaskStore } from "../state/background-task-store";
import ArtifactCard from "./ArtifactCard";
import PreviewPanel from "./PreviewPanel";
import PlanPanel from "./PlanPanel";
import BackgroundTasksPanel from "./BackgroundTasksPanel";
import "../styles/context-panel.css";

/** Always mounted, even while closed: discovery must not depend on panel visibility. */
export default function ContextPanel() {
  const turns = useChatStore((s) => s.turns);
  const conversationId = useChatStore((s) => s.conversationId);
  const open = useUiStore((s) => s.inspectorOpen);
  const tab = useUiStore((s) => s.inspectorTab);
  const previewPath = useUiStore((s) => s.previewPath);
  const openInspector = useUiStore((s) => s.openInspector);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  const closePreview = useUiStore((s) => s.closePreview);
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const artifacts = useMemo(() => conversationArtifacts(turns), [turns]);
  const plan = useMemo(() => findLatestPlan(turns), [turns]);
  const tabs: { value: InspectorTab; label: string; count?: number }[] = [
    { value: "artifacts", label: "产物", count: artifacts.length },
    { value: "plan", label: "计划" },
    { value: "tasks", label: "后台任务", count: runningCount(tasks) || undefined },
  ];

  useEffect(() => {
    const previous = useUiStore.getState().inspectorConversationId;
    const switched = previous !== undefined && previous !== conversationId;
    if (switched) useUiStore.getState().resetInspector();
    useUiStore.setState({ inspectorConversationId: conversationId });
    if (!plan) return;
    const key = JSON.stringify([conversationId, plan.id]);
    const discovered = useUiStore.getState().inspectorDiscoveredPlans;
    if (discovered.has(key)) return;
    useUiStore.setState({ inspectorDiscoveredPlans: new Set([...discovered, key]) });
    const ui = useUiStore.getState();
    // A newly loaded conversation is not a new plan announcement. Discovery is
    // one-shot even when blocked, so closing a preview cannot reveal a queued plan.
    if (!switched && !ui.inspectorOpen && !ui.previewPath && !ui.inspectorDismissed) {
      ui.openInspector("plan");
    }
  }, [conversationId, plan]);

  if (!open) return null;

  return (
    <aside className="context-panel" aria-label="会话检查器">
      <div className="context-panel-heading">
        <span>会话上下文</span>
        <button type="button" className="context-close" aria-label="关闭检查器" onClick={closeInspector}>×</button>
      </div>
      <Tabs.Root className="context-tabs" value={tab} onValueChange={(value) => openInspector(value as InspectorTab)}>
        <Tabs.List className="context-tab-list" aria-label="检查器内容">
          {tabs.map((item) => <Tabs.Trigger key={item.value} className="context-tab" value={item.value}>
            {item.label}{item.count !== undefined && <span className="context-tab-count">{item.count}</span>}
          </Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content className="context-tab-content" value="artifacts">
          {previewPath ? (
            <div className="context-preview">
              <button className="context-back" type="button" onClick={closePreview}><span aria-hidden="true">‹ </span>返回产物列表</button>
              <PreviewPanel key={previewPath} path={previewPath} onClose={closePreview} />
            </div>
          ) : artifacts.length > 0 ? (
            <div className="context-artifact-list">
              <p className="context-caption">当前会话的最终产物</p>
              {artifacts.map((artifact, index) => (
                <ArtifactCard key={`${artifact.id}:${index}`} name={artifact.name} artKind={artifact.artKind}
                  path={artifact.path} exists={artifact.exists} size={artifact.size}
                  onOpen={() => setPreviewPath(artifact.path)} />
              ))}
            </div>
          ) : <div className="context-empty"><strong>暂无产物</strong><p>生成的文件会显示在这里，也可从会话中打开文件预览。</p></div>}
        </Tabs.Content>
        <Tabs.Content className="context-tab-content" value="plan"><PlanPanel /></Tabs.Content>
        <Tabs.Content className="context-tab-content" value="tasks"><BackgroundTasksPanel embedded /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
