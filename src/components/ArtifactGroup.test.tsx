import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ArtifactBlock } from "../state/chat-store";
import ArtifactGroup, { artifactParentPath, summarizeArtifactTypes } from "./ArtifactGroup";

afterEach(cleanup);

function artifact(index: number, overrides: Partial<ArtifactBlock> = {}): ArtifactBlock {
  return {
    id: `artifact-${index}`,
    kind: "artifact",
    artKind: "file",
    name: `file-${index}.txt`,
    path: `/output/file-${index}.txt`,
    exists: true,
    source: "declared",
    ...overrides,
  };
}

describe("artifactParentPath", () => {
  test.each([
    ["C:\\output\\report.docx", "C:\\output"],
    ["/output/report.docx", "/output"],
    ["/report.docx", "/"],
    ["report.docx", null],
  ])("returns the parent of %s", (path, expected) => {
    expect(artifactParentPath(path)).toBe(expected);
  });
});

test("summarizes unique extensions and labels extensionless artifacts as files", () => {
  expect(
    summarizeArtifactTypes([
      artifact(1, { name: "report.PDF" }),
      artifact(2, { name: "copy.pdf" }),
      artifact(3, { name: "chart.png", artKind: "image" }),
      artifact(4, { name: "README" }),
    ]),
  ).toBe("PDF、PNG、文件");
});

test("renders nothing for an empty artifact list", () => {
  const { container } = render(
    <ArtifactGroup artifacts={[]} onOpen={vi.fn()} onOpenFolder={vi.fn()} />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("shows a collapsed two-line summary and toggles the list", () => {
  render(
    <ArtifactGroup artifacts={[artifact(1)]} onOpen={vi.fn()} onOpenFolder={vi.fn()} />,
  );

  const summary = screen.getByRole("button", { name: /最终产物.*1 个.*TXT/ });
  expect(summary).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("file-1.txt")).not.toBeInTheDocument();

  fireEvent.click(summary);
  expect(summary).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("file-1.txt")).toBeInTheDocument();

  fireEvent.click(summary);
  expect(summary).toHaveAttribute("aria-expanded", "false");
});

test.each([
  [5, 5, null],
  [6, 5, "显示其余 1 个"],
  [12, 5, "显示其余 7 个"],
] as const)("shows the right initial rows for %i artifacts", (count, visible, remainderLabel) => {
  render(
    <ArtifactGroup
      artifacts={Array.from({ length: count }, (_, index) => artifact(index + 1))}
      onOpen={vi.fn()}
      onOpenFolder={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /最终产物/ }));

  expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(visible);
  if (remainderLabel) {
    const showAll = screen.getByRole("button", { name: remainderLabel });
    fireEvent.click(showAll);
    expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(count);
    fireEvent.click(screen.getByRole("button", { name: /收起其余/ }));
    expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(5);
  } else {
    expect(screen.queryByRole("button", { name: /显示其余/ })).not.toBeInTheDocument();
  }
});

test("resets the row limit when the whole group is collapsed", () => {
  render(
    <ArtifactGroup
      artifacts={Array.from({ length: 6 }, (_, index) => artifact(index + 1))}
      onOpen={vi.fn()}
      onOpenFolder={vi.fn()}
    />,
  );
  const summary = screen.getByRole("button", { name: /最终产物/ });
  fireEvent.click(summary);
  fireEvent.click(screen.getByRole("button", { name: "显示其余 1 个" }));
  fireEvent.click(summary);
  fireEvent.click(summary);
  expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(5);
  expect(screen.getByRole("button", { name: "显示其余 1 个" })).toBeInTheDocument();
});

test("marks fallback or historical artifacts as unfiltered", () => {
  const { rerender } = render(
    <ArtifactGroup artifacts={[artifact(1, { source: undefined })]} onOpen={vi.fn()} onOpenFolder={vi.fn()} />,
  );
  expect(screen.getByText("未筛选")).toBeInTheDocument();

  rerender(
    <ArtifactGroup artifacts={[artifact(1), artifact(2)]} onOpen={vi.fn()} onOpenFolder={vi.fn()} />,
  );
  expect(screen.queryByText("未筛选")).not.toBeInTheDocument();
});

test("keeps a missing artifact visible but disabled", () => {
  const onOpen = vi.fn();
  render(
    <ArtifactGroup
      artifacts={[artifact(1, { exists: false, name: "missing.txt" })]}
      onOpen={onOpen}
      onOpenFolder={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /最终产物/ }));
  const missing = screen.getByRole("button", { name: /missing\.txt.*文件不存在/ });
  expect(missing).toBeDisabled();
  fireEvent.click(missing);
  expect(onOpen).not.toHaveBeenCalled();
});

test("opens the first derivable parent folder without collapsing the group", () => {
  const onOpenFolder = vi.fn();
  render(
    <ArtifactGroup
      artifacts={[
        artifact(1, { path: "standalone.txt" }),
        artifact(2, { path: "C:\\deliverables\\report.pdf" }),
      ]}
      onOpen={vi.fn()}
      onOpenFolder={onOpenFolder}
    />,
  );
  const summary = screen.getByRole("button", { name: /最终产物/ });
  fireEvent.click(summary);
  const group = screen.getByRole("group", { name: "最终产物清单" });
  fireEvent.click(within(group).getByRole("button", { name: "打开所在文件夹" }));
  expect(onOpenFolder).toHaveBeenCalledWith("C:\\deliverables");
  expect(summary).toHaveAttribute("aria-expanded", "true");
});

test("does not offer a folder action when no parent can be derived", () => {
  render(
    <ArtifactGroup
      artifacts={[artifact(1, { path: "standalone.txt" })]}
      onOpen={vi.fn()}
      onOpenFolder={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /最终产物/ }));
  expect(screen.queryByRole("button", { name: "打开所在文件夹" })).not.toBeInTheDocument();
});
