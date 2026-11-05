import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import ArtifactCard, { formatArtifactSize } from "./ArtifactCard";

describe("formatArtifactSize", () => {
  test.each([
    [undefined, "—"],
    [0, "0 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [1048576, "1 MB"],
  ])("formats %s bytes as %s", (size, expected) => {
    expect(formatArtifactSize(size)).toBe(expected);
  });
});

test("renders a compact native button row and opens the artifact", () => {
  const onOpen = vi.fn();
  render(
    <ArtifactCard
      name="report.xlsx"
      artKind="file"
      path="/report.xlsx"
      size={1536}
      onOpen={onOpen}
    />,
  );

  const row = screen.getByRole("button", { name: /report\.xlsx.*1\.5 KB.*预览/ });
  expect(row.tagName).toBe("BUTTON");
  expect(row).toHaveAttribute("type", "button");
  fireEvent.click(row);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("uses native disabled semantics when the file is missing", () => {
  const onOpen = vi.fn();
  render(
    <ArtifactCard
      name="missing.png"
      artKind="image"
      path="C:\\output\\missing.png"
      exists={false}
      onOpen={onOpen}
    />,
  );

  const row = screen.getByRole("button", { name: /missing\.png.*文件不存在/ });
  expect(row).toBeDisabled();
  expect(screen.getByText("—")).toBeInTheDocument();
  fireEvent.click(row);
  expect(onOpen).not.toHaveBeenCalled();
});
