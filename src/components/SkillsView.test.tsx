import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import SkillsView from "./SkillsView";

describe("SkillsView management", () => {
  beforeEach(() => {
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

  it("opens create modal when add button is clicked", () => {
    render(<SkillsView />);
    fireEvent.click(screen.getByTitle("新建 Skill"));
    expect(screen.getByText("新建 Skill")).toBeInTheDocument();
  });
});
