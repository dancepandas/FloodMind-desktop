import { render, screen, fireEvent } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import ArtifactCard from "./ArtifactCard";

test("renders file card and calls onOpen", () => {
  const onOpen = vi.fn();
  render(<ArtifactCard name="report.xlsx" artKind="file" path="/report.xlsx" onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button"));
  expect(onOpen).toHaveBeenCalled();
});
