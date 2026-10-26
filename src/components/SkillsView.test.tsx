import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import SkillsView from "./SkillsView";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://localhost") }));

describe("SkillsView management", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ drafts: [] }) }));
    useCatalogStore.setState({
      skills: [{ name: "csv", description: "CSV ops", category: "execution", disabled: false }],
      skillDetail: null,
      skillDetailLoading: false,
      skillSaving: false,
      skillError: null,
      loadSkills: vi.fn(),
      loadSkill: vi.fn(),
      setSkillDisabled: vi.fn(),
      createSkill: vi.fn(),
      updateSkill: vi.fn(),
      deleteSkill: vi.fn(),
    } as any);
  });

  it("selects a card and preserves built-in enable actions and complete details below", () => {
    useCatalogStore.setState({
      skills: [{ name: "csv", description: "CSV ops", builtin: true, disabled: true }],
      skillDetail: { name: "csv", description: "CSV ops", builtin: true, disabled: true, prompt: "Full skill text", scripts: ["parse.py"], references: ["format.md"], assets: ["sample.csv"], provides_tools: ["parse_csv"] },
    });
    render(<SkillsView />);
    const card = within(screen.getByRole("list", { name: "技能列表" })).getByRole("button");
    expect(card).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(useCatalogStore.getState().loadSkill).toHaveBeenCalledWith("csv");
    const detail = screen.getByRole("region", { name: "技能详情" });
    for (const text of ["Full skill text", "parse.py", "format.md", "sample.csv", "parse_csv"]) {
      expect(within(detail).getByText(text)).toBeInTheDocument();
    }
    expect(within(detail).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "启用" }));
    expect(useCatalogStore.getState().setSkillDisabled).toHaveBeenCalledWith("csv", false);
  });

  it("keeps loading and failure states in the detail region", () => {
    useCatalogStore.setState({ skillDetailLoading: true });
    const { rerender } = render(<SkillsView />);
    fireEvent.click(within(screen.getByRole("list", { name: "技能列表" })).getByRole("button"));
    expect(screen.getByRole("region", { name: "技能详情" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    useCatalogStore.setState({ skillDetailLoading: false });
    rerender(<SkillsView />);
    expect(screen.getByText("无法加载该 Skill")).toBeInTheDocument();
  });

  it("installs and rejects individual draft cards", async () => {
    const drafts = ["draft-one", "draft-two"].map((name) => ({ name, description: `Description ${name}`, keywords: ["csv"], path: name }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ drafts }) }));
    render(<SkillsView />);
    const section = await screen.findByRole("region", { name: "建议技能" });
    fireEvent.click(within(section).getAllByRole("button", { name: "安装" })[0]);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost/api/skills/drafts/draft-one/approve", { method: "POST" }));
    fireEvent.click(within(section).getAllByRole("button", { name: "拒绝" })[1]);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost/api/skills/drafts/draft-two/reject", { method: "POST" }));
    await waitFor(() => expect(useCatalogStore.getState().loadSkills).toHaveBeenCalledTimes(3));
  });

  it("opens create modal when add button is clicked", () => {
    render(<SkillsView />);
    fireEvent.click(screen.getByTitle("新建 Skill"));
    expect(screen.getByText("新建 Skill")).toBeInTheDocument();
  });
});
