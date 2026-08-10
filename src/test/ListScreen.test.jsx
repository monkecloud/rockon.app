// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListScreen, ArchiveWallScreen } from "../screens/ListScreen.jsx";

// §14.11 priority 5: ListScreen's three modes (wall list -> a wall's climb
// list -> ZoomableImageViewer detail), all driven purely by props (the
// drill-down state itself lives in App(), already covered by
// App.navigation.test.jsx) — plus ArchiveWallScreen, its sibling export.

function climb(overrides = {}) {
  return {
    wallId: 1,
    setId: "s1",
    setterName: "golden-overhang",
    name: "Golden Overhang",
    setter: "alice",
    setType: "reset",
    setDate: "2026-01-01",
    setterGrade: "V2-4",
    grade: "",
    averageStars: 0,
    ascentCount: 0,
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    selectedItem: null,
    selectedSubItem: null,
    climbsByWall: null,
    climbsError: null,
    onRetryClimbs: vi.fn(),
    onSelectItem: vi.fn(),
    onSelectSubItem: vi.fn(),
    archiveExpanded: false,
    archiveWalls: null,
    archiveError: null,
    onRetryArchive: vi.fn(),
    onToggleArchive: vi.fn(),
    onSelectArchiveWall: vi.fn(),
    onOpenFilter: vi.fn(),
    climbSortBy: "gradeAsc",
    showResetClimbs: true,
    showBackfillClimbs: true,
    ...overrides,
  };
}

describe("ListScreen — wall-list mode", () => {
  it("lists all 4 walls with their current climb counts and dispatches onSelectItem", async () => {
    const onSelectItem = vi.fn();
    const user = userEvent.setup();
    render(
      <ListScreen
        {...baseProps({
          climbsByWall: { 1: [climb()], 2: [climb({ wallId: 2 }), climb({ wallId: 2, setterName: "b" })] },
          onSelectItem,
        })}
      />
    );

    expect(screen.getByRole("button", { name: /back\s*1 climbs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /slab\s*2 climbs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cave\s*0 climbs/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back\s*1 climbs/i }));
    expect(onSelectItem).toHaveBeenCalledWith({ id: 1, title: "Back" });
  });

  it("toggles the Archive section and lists its fetched walls", async () => {
    const onToggleArchive = vi.fn();
    const user = userEvent.setup();
    render(
      <ListScreen
        {...baseProps({
          archiveExpanded: true,
          archiveWalls: [{ wallId: 2, climbs: [climb(), climb()] }],
          onToggleArchive,
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onToggleArchive).toHaveBeenCalled();
    // "Slab" also appears as one of the 4 root wall rows above (every wall
    // shows regardless of archive state) — the archive row is the one that
    // additionally reports the fetched climb count.
    expect(screen.getByRole("button", { name: /slab\s*2 climbs/i })).toBeInTheDocument();
  });
});

describe("ListScreen — climbs-list mode", () => {
  it("shows 'Loading climbs…' while climbsByWall is null, not the empty state", () => {
    render(<ListScreen {...baseProps({ selectedItem: { id: 1, title: "Back" }, climbsByWall: null })} />);
    expect(screen.getByText("Loading climbs…")).toBeInTheDocument();
  });

  it("shows the wall-specific empty state once loaded with zero climbs", () => {
    render(<ListScreen {...baseProps({ selectedItem: { id: 1, title: "Back" }, climbsByWall: { 1: [] } })} />);
    expect(screen.getByText("No climbs on this wall yet.")).toBeInTheDocument();
  });

  it("filters climbs by the search box and clicking a row calls onSelectSubItem", async () => {
    const onSelectSubItem = vi.fn();
    const user = userEvent.setup();
    render(
      <ListScreen
        {...baseProps({
          selectedItem: { id: 1, title: "Back" },
          climbsByWall: {
            1: [
              climb({ name: "Golden Overhang", setterName: "golden-overhang" }),
              climb({ name: "Blue Streak", setterName: "blue-streak" }),
            ],
          },
          onSelectSubItem,
        })}
      />
    );

    await user.type(screen.getByPlaceholderText("Search climbs"), "golden");
    expect(screen.getByRole("button", { name: /golden overhang/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /blue streak/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /golden overhang/i }));
    expect(onSelectSubItem).toHaveBeenCalledWith("golden-overhang");
  });

  it("shows the fetch error with a working Retry button instead of the climb list", async () => {
    const onRetryClimbs = vi.fn();
    const user = userEvent.setup();
    render(
      <ListScreen
        {...baseProps({
          selectedItem: { id: 1, title: "Back" },
          climbsByWall: { 1: [climb()] },
          climbsError: "Couldn't reach the server.",
          onRetryClimbs,
        })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach the server.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryClimbs).toHaveBeenCalled();
  });

  it("clicking the filter button calls onOpenFilter", async () => {
    const onOpenFilter = vi.fn();
    const user = userEvent.setup();
    render(
      <ListScreen
        {...baseProps({ selectedItem: { id: 1, title: "Back" }, climbsByWall: { 1: [climb()] }, onOpenFilter })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Filter climbs" }));
    expect(onOpenFilter).toHaveBeenCalled();
  });
});

describe("ListScreen — climb-detail mode", () => {
  it("renders the zoomable image viewer with the climb's grade+name title and setter subtitle", () => {
    render(
      <ListScreen
        {...baseProps({
          selectedItem: { id: 1, title: "Back" },
          selectedSubItem: "golden-overhang",
          climbsByWall: {
            1: [climb({ name: "Golden Overhang", setterName: "golden-overhang", setter: "alice", grade: "V3" })],
          },
        })}
      />
    );

    // The grade and name render as separate nested elements (ClimbGradeLabel
    // + a trailing text node — see climbTitleNode), so getByText's default
    // own-text-only matching won't find "V3 · Golden Overhang" as a single
    // node; match the one element whose full textContent equals it instead.
    expect(
      screen.getByText((_, element) => element?.textContent === "V3 · Golden Overhang")
    ).toBeInTheDocument();
    expect(screen.getByText("Set by alice")).toBeInTheDocument();
  });
});

describe("ArchiveWallScreen", () => {
  it("renders nothing for a null wall", () => {
    const { container } = render(<ArchiveWallScreen wall={null} onSelectClimb={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the wall's archived climbs and dispatches onSelectClimb", async () => {
    const onSelectClimb = vi.fn();
    const wallClimb = climb({ name: "Golden Overhang", setterName: "golden-overhang" });
    const user = userEvent.setup();
    render(<ArchiveWallScreen wall={{ wallId: 1, climbs: [wallClimb] }} onSelectClimb={onSelectClimb} />);

    expect(screen.getByText("1 climbs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /golden overhang/i }));
    expect(onSelectClimb).toHaveBeenCalledWith(wallClimb);
  });
});
