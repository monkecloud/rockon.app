// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { clearApiCache } from "../App.jsx";
import { installFetchMock } from "./mockFetch.js";

// App() is the highest-risk file in the codebase: ~20 interdependent
// pieces of hand-rolled useState driving all navigation, with no router
// underneath (see CLAUDE.md's "one file, no router"). These are the
// regression tests that catch a refactor silently breaking tab switching,
// drill-down, back behavior, or the search stack — nothing else would
// (§14.11 priority 2).

const CURRENT_USER_KEY = "boilerplate:currentUser";

function memberUser(overrides = {}) {
  return {
    id: "u1",
    username: "cubesnail",
    name: "Cube Snail",
    followersCount: 0,
    followingCount: 0,
    ...overrides,
  };
}

// Seeds localStorage with a cached session AND makes /api/me confirm it,
// matching how a real logged-in reload behaves (§14.8/§14.9) — otherwise
// the mount-time session-verification effect immediately logs the test
// user back out.
function signedInAs(user) {
  window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  return { "/api/me": { body: { user } } };
}

const BASE_ROUTES = {
  "/api/climbs": { body: { climbs: [] } },
};

beforeEach(() => {
  window.localStorage.clear();
  // useFetch's apiCache (§14.9) is a module-level Map, so it survives
  // across renders within this file — without clearing it, a later test's
  // mock response for a URL an earlier test already fetched (e.g. every
  // test hits /api/users/leaderboard just by mounting <App/> on the Home
  // tab) is silently shadowed by the earlier test's stale cached response.
  clearApiCache();
});

describe("App() — tab bar", () => {
  it("renders logged-out with the 4 base tabs, no role-gated tabs", async () => {
    installFetchMock({ ...BASE_ROUTES, "/api/me": { status: 401, body: { error: "Not logged in." } } });
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /walls/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /profile/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^admin$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^grades$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("shows the Approve tab for a moderator, but not Grades/Admin", async () => {
    installFetchMock({ ...BASE_ROUTES, ...signedInAs(memberUser({ isModerator: true })) });
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^grades$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^admin$/i })).not.toBeInTheDocument();
  });

  it("shows Approve, Grades, and Admin for an admin", async () => {
    // Per the app's permission model (CLAUDE.md: "admin (all three flags
    // set)"), a real admin user always carries isModerator/isSetter too —
    // isAdmin alone is not a shape the server ever actually produces.
    installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser({ isAdmin: true, isModerator: true, isSetter: true })),
    });
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: /^admin$/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^grades$/i })).toBeInTheDocument();
  });
});

describe("App() — Walls drill-down and back behavior", () => {
  it("drills Walls -> a wall's climb list -> back to Walls root", async () => {
    installFetchMock({ ...BASE_ROUTES, "/api/me": { status: 401, body: {} } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /walls/i }));
    // Walls root: all 4 wall rows visible.
    expect(await screen.findByRole("button", { name: /back\s*\d+ climbs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /slab\s*\d+ climbs/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /slab\s*\d+ climbs/i }));
    // Drilled in: top bar title becomes the wall name, a real Back button appears.
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Slab" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /slab\s*\d+ climbs/i })).toBeInTheDocument();
  });

  it("re-tapping the active Walls tab pops straight back to the root list", async () => {
    installFetchMock({ ...BASE_ROUTES, "/api/me": { status: 401, body: {} } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /walls/i }));
    await user.click(await screen.findByRole("button", { name: /cave\s*\d+ climbs/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cave" })).toBeInTheDocument());

    // Re-tap the Walls tab itself (not the in-page Back button) — should
    // pop all the way to the root list in one step, matching the app's
    // "re-tapping the active tab pops to root" convention.
    await user.click(screen.getByRole("button", { name: /walls/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Cave" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /cave\s*\d+ climbs/i })).toBeInTheDocument();
  });
});

describe("App() — Search tab stack", () => {
  it("re-tapping the active Search tab pops the drilled-in profile back to results (clears the stack, not the query)", async () => {
    const foundUser = { username: "sebi", name: "Sebi", isFollowing: false, followersCount: 0 };
    installFetchMock({
      ...BASE_ROUTES,
      "/api/me": { status: 401, body: {} },
      "/api/users/search": { body: { users: [foundUser] } },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /search/i }));
    const searchInput = await screen.findByPlaceholderText("Search");
    await user.click(screen.getByRole("button", { name: "Users" }));
    await user.type(searchInput, "sebi");

    const resultRow = await screen.findByRole("button", { name: /sebi/i });
    await user.click(resultRow);

    // Drilled into the profile: top bar title becomes the username.
    await waitFor(() => expect(screen.getByRole("heading", { name: "sebi" })).toBeInTheDocument());

    // Re-tap Search (not the top bar Back button) — pops the stack back to
    // results in one step, same "re-tap pops toward root" convention as
    // the Walls tab, and the typed query survives (setSearchStack([]) does
    // not touch searchQuery).
    await user.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "sebi" })).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText("Search")).toHaveValue("sebi");
  });

  it("leaderboardReturnTab: opening a profile from the Home leaderboard and backing out returns to Home, not an empty Search tab", async () => {
    // 3 distinct users — the podium renders users[0..2] at ranks 2/1/3, so
    // reusing one object for all three would make every podium slot match
    // the same accessible name.
    const leaderboardUsers = [
      { username: "derrick", name: "Derrick", ascentCount: 4, isFollowing: false, followersCount: 0 },
      { username: "cubesnail", name: "Cube", ascentCount: 9, isFollowing: false, followersCount: 0 },
      { username: "sebi", name: "Sebi", ascentCount: 2, isFollowing: false, followersCount: 0 },
    ];
    installFetchMock({
      ...BASE_ROUTES,
      "/api/me": { status: 401, body: {} },
      "/api/users/leaderboard": { body: { users: leaderboardUsers } },
    });
    const user = userEvent.setup();
    render(<App />);

    // Home tab is the default; wait for the leaderboard podium to render.
    const podiumButton = await screen.findByRole("button", { name: /derrick/i });
    await user.click(podiumButton);

    // Following the Leaderboard into a profile switches to the Search tab.
    await waitFor(() => expect(screen.getByRole("button", { name: /search/i })).toHaveStyle({ color: "var(--color-accent-bright)" }));
    expect(screen.getByRole("heading", { name: "derrick" })).toBeInTheDocument();

    // Back out via the top bar's Back button — should land on Home, not a
    // blank Search tab, because handleSelectLeaderboardUser remembered
    // where this navigation started (§14.11 priority 2's named example).
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /home/i })).toHaveStyle({ color: "var(--color-accent-bright)" }));
  });
});

describe("App() — Profile tab / auth state", () => {
  it("shows the login/signup form when logged out", async () => {
    installFetchMock({ ...BASE_ROUTES, "/api/me": { status: 401, body: {} } });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /profile/i }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /log in/i }).length).toBeGreaterThan(0));
  });

  it("shows the logged-in profile (username) once /api/me confirms the cached session", async () => {
    installFetchMock({ ...BASE_ROUTES, ...signedInAs(memberUser({ username: "cubesnail" })) });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /profile/i }));
    await waitFor(() => expect(screen.getByText("cubesnail")).toBeInTheDocument());
  });

  it("logs a stale cached session out when /api/me returns 401 (a network error must NOT do this — see App.jsx's session-verification effect)", async () => {
    window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(memberUser()));
    installFetchMock({ ...BASE_ROUTES, "/api/me": { status: 401, body: { error: "Session expired." } } });
    const user = userEvent.setup();
    render(<App />);

    // Cached user should be dropped once the 401 resolves — ends up on the
    // login form even though localStorage had a cached session at mount.
    await user.click(await screen.findByRole("button", { name: /profile/i }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /log in/i }).length).toBeGreaterThan(0));
  });

  // §14.11's own "regression tests worth writing immediately" list: a
  // network error (dropped wifi, server restarting) must NOT clear the
  // cached session the way an explicit 401 does — get this backwards and
  // every wifi blip at a climbing gym becomes a surprise logout.
  it("keeps a cached session logged in when /api/me fails with a network error, not a 401", async () => {
    const user = memberUser({ username: "cubesnail" });
    window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
    installFetchMock({ ...BASE_ROUTES, "/api/me": { networkError: true } });
    const u = userEvent.setup();
    render(<App />);

    await u.click(await screen.findByRole("button", { name: /profile/i }));
    // Give the failed /api/me a tick to resolve, then assert the cached
    // session survived it — still showing the logged-in profile, not the
    // login form.
    await waitFor(() => expect(screen.getByText("cubesnail")).toBeInTheDocument());
    expect(screen.queryAllByRole("button", { name: /log in/i })).toHaveLength(0);
  });
});

describe("App() — §14.9 regression: a wall with zero current climbs", () => {
  it("shows an empty state, not 'Loading climbs…' forever", async () => {
    // climbsByWall[id] is undefined for a wall no climb references — the
    // exact case that used to be indistinguishable from "hasn't fetched
    // yet" before the null-vs-[] fix.
    installFetchMock({
      "/api/climbs": { body: { climbs: [{ wallId: 2, name: "Some Climb", setterName: "Some Climb", setter: "X", setId: "s1", setDate: "2026-01-01", setType: "reset", setterGrade: "V1" }] } },
      "/api/me": { status: 401, body: {} },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /walls/i }));
    // "Back" (wallId 1) has zero current climbs in this fixture.
    await user.click(await screen.findByRole("button", { name: /^back\s*0 climbs/i }));

    await waitFor(() => expect(screen.getByText("No climbs on this wall yet.")).toBeInTheDocument());
    expect(screen.queryByText("Loading climbs…")).not.toBeInTheDocument();
  });
});
