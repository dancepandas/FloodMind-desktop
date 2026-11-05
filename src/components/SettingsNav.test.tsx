import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsNav, { type Tab } from "./SettingsNav";

function Harness({ initial = "model" }: { initial?: Tab }) {
  const [active, setActive] = useState<Tab>(initial);
  return <SettingsNav active={active} onChange={setActive} />;
}
function expectActive(name: string) {
  const active = screen.getByRole("tab", { name });
  expect(active).toHaveFocus();
  for (const tab of screen.getAllByRole("tab")) {
    expect(tab).toHaveAttribute("tabindex", tab === active ? "0" : "-1");
    expect(tab).toHaveAttribute("aria-selected", String(tab === active));
    expect(tab).toHaveAttribute("aria-controls", "settings-panel");
  }
  return active;
}

afterEach(cleanup);

describe("settings navigation keyboard", () => {
  it("places only the current category in the tab order", () => {
    render(<Harness initial="permissions" />);
    expect(screen.getByRole("tablist", { name: "设置分类" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(8);
    screen.getByRole("tab", { name: "权限" }).focus();
    expectActive("权限");
  });

  it.each(["ArrowRight", "ArrowDown"])("%s selects and focuses the next category and wraps", (key) => {
    render(<Harness initial="diagnostics" />);
    const last = screen.getByRole("tab", { name: "诊断" });
    last.focus();
    expect(fireEvent.keyDown(last, { key })).toBe(false);
    const first = expectActive("模型");
    fireEvent.keyDown(first, { key });
    expectActive("身份");
  });

  it.each(["ArrowLeft", "ArrowUp"])("%s selects and focuses the previous category and wraps", (key) => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "模型" });
    first.focus();
    expect(fireEvent.keyDown(first, { key })).toBe(false);
    const last = expectActive("诊断");
    fireEvent.keyDown(last, { key });
    expectActive("插件");
  });

  it("Home and End select and focus the first and last categories", () => {
    render(<Harness initial="display" />);
    const middle = screen.getByRole("tab", { name: "显示" });
    middle.focus();
    expect(fireEvent.keyDown(middle, { key: "End" })).toBe(false);
    const last = expectActive("诊断");
    expect(fireEvent.keyDown(last, { key: "Home" })).toBe(false);
    expectActive("模型");
  });

  it("leaves Tab and unrelated keys to the browser without changing selection", () => {
    const onChange = vi.fn();
    render(<SettingsNav active="model" onChange={onChange} />);
    const first = screen.getByRole("tab", { name: "模型" });
    first.focus();
    for (const key of ["Tab", "Escape", "a"]) {
      expect(fireEvent.keyDown(first, { key })).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
    expectActive("模型");
  });
});
