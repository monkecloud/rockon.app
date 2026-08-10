// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchScreen } from "../screens/SearchScreen.jsx";
import { installFetchMock } from "./mockFetch.js";

// §14.11 priority 5: SearchScreen's two modes. Climbs mode filters the
// in-memory `climbs` prop client-side (matchesClimbQuery, already unit
// tested in pure.test.js); Users mode debounces a request to
// /api/users/search (§14.18 part 1). SearchScreen itself is fully
// controlled (query/mode/results all come from props, lifted to App() so
// they survive tab switches) — this thin wrapper supplies the state a real
// parent would.
function ControlledSearchScreen({ climbs, onSelectClimb = vi.fn(), onSelectUser = vi.fn() }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("climbs");
  const [userResults, setUserResults] = useState([]);
  return (
    <SearchScreen
      climbs={climbs}
      query={query}
      mode={mode}
      userResults={userResults}
      onQueryChange={setQuery}
      onModeChange={setMode}
      onUserResultsChange={setUserResults}
      onSelectClimb={onSelectClimb}
      onSelectUser={onSelectUser}
    />
  );
}

const climbsFixture = [
  { wallId: 1, setterName: "golden-overhang", name: "Golden Overhang", setter: "alice", setterGrade: "V3", grade: "", ascentCount: 2 },
  { wallId: 2, setterName: "blue-streak", name: "Blue Streak", setter: "bob", setterGrade: "V5", grade: "", ascentCount: 0 },
];

describe("SearchScreen — Climbs mode", () => {
  it("filters the in-memory climbs list as you type and dispatches onSelectClimb", async () => {
    const onSelectClimb = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSearchScreen climbs={climbsFixture} onSelectClimb={onSelectClimb} />);

    await user.type(screen.getByPlaceholderText("Search"), "golden");
    expect(await screen.findByRole("button", { name: /golden overhang/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /blue streak/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /golden overhang/i }));
    expect(onSelectClimb).toHaveBeenCalledWith(climbsFixture[0]);
  });

  it("shows a mode-aware empty state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<ControlledSearchScreen climbs={climbsFixture} />);

    await user.type(screen.getByPlaceholderText("Search"), "nonexistent-climb");
    expect(await screen.findByText('No climbs match "nonexistent-climb".')).toBeInTheDocument();
  });
});

describe("SearchScreen — Users mode", () => {
  it("switches mode, debounces the search request, and dispatches onSelectUser", async () => {
    const { calls } = installFetchMock({
      "/api/users/search": { body: { users: [{ username: "sebi", name: "Sebi" }] } },
    });
    const onSelectUser = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSearchScreen climbs={climbsFixture} onSelectUser={onSelectUser} />);

    await user.click(screen.getByRole("button", { name: "Users" }));
    await user.type(screen.getByPlaceholderText("Search"), "sebi");

    const userRow = await screen.findByRole("button", { name: /sebi/i });
    expect(calls.some((c) => c.pathname === "/api/users/search")).toBe(true);

    await user.click(userRow);
    expect(onSelectUser).toHaveBeenCalledWith({ username: "sebi", name: "Sebi" });
  });

  it("does not fire a search request per keystroke — climbs mode never hits the network at all", async () => {
    const { calls } = installFetchMock();
    const user = userEvent.setup();
    render(<ControlledSearchScreen climbs={climbsFixture} />);

    await user.type(screen.getByPlaceholderText("Search"), "golden");
    expect(calls).toHaveLength(0);
  });
});
