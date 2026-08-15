// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import { clearApiCache } from "../lib/fetch.js";
import { installFetchMock } from "./mockFetch.js";

// §13.6-e: follow/unfollow, comment delete, and (partially) ascent logging
// went from "wait on a round trip" to optimistic. These tests hold the
// relevant request pending (via installFetchMock's Promise-returning route
// support) specifically to observe the UI *before* it resolves — the one
// thing that distinguishes "optimistic" from "just a fast normal fetch",
// and the exact thing that was missing from every other test file.

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

function signedInAs(user) {
  window.localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  return { "/api/me": { body: { user } } };
}

const WALLS = [{ id: 1, name: "Back" }];

const BASE_ROUTES = {
  "/api/walls": { body: { walls: WALLS } },
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  clearApiCache();
});

describe("App() — optimistic follow/unfollow", () => {
  it("flips immediately, then reconciles with the server's actual count on success", async () => {
    const foundUser = { username: "sebi", name: "Sebi", isFollowing: false, followersCount: 2 };
    const follow = deferred();
    installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser()),
      "/api/climbs": { body: { climbs: [] } },
      "/api/users/search": { body: { users: [foundUser] } },
      "POST /api/users/sebi/follow": () => follow.promise,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /search/i }));
    await user.click(screen.getByRole("button", { name: "Users" }));
    await user.type(screen.getByPlaceholderText("Search"), "sebi");
    await user.click(await screen.findByRole("button", { name: /sebi/i }));
    await screen.findByRole("heading", { name: "sebi" });

    await user.click(screen.getByRole("button", { name: "Follow" }));

    // Still pending — the request hasn't resolved yet, but the button and
    // count should already reflect the optimistic guess (+1, since the
    // server hasn't confirmed the real number).
    expect(screen.getByRole("button", { name: "Unfollow" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    // Resolve with a followersCount that deliberately differs from the
    // naive +1 guess, so the assertion below only passes if the server's
    // response actually overwrote the optimistic value rather than the
    // guess just happening to be right.
    follow.resolve({ body: { isFollowing: true, followersCount: 9 } });

    await waitFor(() => expect(screen.getByText("9")).toBeInTheDocument());
  });

  it("reverts to the pre-toggle state if the request fails", async () => {
    const foundUser = { username: "sebi", name: "Sebi", isFollowing: false, followersCount: 2 };
    const follow = deferred();
    installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser()),
      "/api/climbs": { body: { climbs: [] } },
      "/api/users/search": { body: { users: [foundUser] } },
      "POST /api/users/sebi/follow": () => follow.promise,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /search/i }));
    await user.click(screen.getByRole("button", { name: "Users" }));
    await user.type(screen.getByPlaceholderText("Search"), "sebi");
    await user.click(await screen.findByRole("button", { name: /sebi/i }));
    await screen.findByRole("heading", { name: "sebi" });

    await user.click(screen.getByRole("button", { name: "Follow" }));
    expect(screen.getByRole("button", { name: "Unfollow" })).toBeInTheDocument();

    follow.resolve({ status: 500, body: { error: "boom" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Follow" })).toBeInTheDocument());
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("App() — optimistic comment delete", () => {
  const climbFixture = {
    id: 1,
    wallId: 1,
    setterName: "golden-overhang",
    name: "Golden Overhang",
    setter: "alice",
    setType: "reset",
    setDate: "2026-01-01",
    setterGrade: "V2-4",
    grade: "",
    averageStars: 0,
    ascentCount: 1,
    comments: [{ id: "ascent-9", ascentId: 9, author: "cubesnail", text: "Great climb" }],
  };

  async function openClimbInfo(user) {
    await user.click(await screen.findByRole("button", { name: /walls/i }));
    await user.click(await screen.findByRole("button", { name: /back/i }));
    await user.click(await screen.findByRole("button", { name: /golden overhang/i }));
    await user.click(screen.getByRole("button", { name: "Climb info" }));
    await screen.findByText("Great climb");
  }

  it("removes the comment immediately, before the DELETE resolves", async () => {
    const del = deferred();
    installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser()),
      "/api/climbs": { body: { climbs: [climbFixture] } },
      "/api/climbs/grade-distribution": { body: { grades: [] } },
      "DELETE /api/users/cubesnail/ascents/9/comment": () => del.promise,
    });
    const user = userEvent.setup();
    render(<App />);

    await openClimbInfo(user);
    await user.click(screen.getByRole("button", { name: "Delete comment" }));

    // Gone already, request still pending.
    expect(screen.queryByText("Great climb")).not.toBeInTheDocument();

    del.resolve({ body: { success: true } });
    await waitFor(() => expect(screen.queryByText("Great climb")).not.toBeInTheDocument());
  });

  it("restores the comment (via refetch) if the DELETE fails", async () => {
    const del = deferred();
    installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser()),
      "/api/climbs": { body: { climbs: [climbFixture] } },
      "/api/climbs/grade-distribution": { body: { grades: [] } },
      "DELETE /api/users/cubesnail/ascents/9/comment": () => del.promise,
    });
    const user = userEvent.setup();
    render(<App />);

    await openClimbInfo(user);
    await user.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.queryByText("Great climb")).not.toBeInTheDocument();

    del.resolve({ status: 500, body: { error: "boom" } });

    // The failure path refetches /api/climbs, which (still) has the
    // comment — proving the optimistic removal gets corrected, not just
    // left wrong forever.
    await waitFor(() => expect(screen.getByText("Great climb")).toBeInTheDocument());
  });
});

describe("App() — optimistic ascent logging", () => {
  const climbFixture = {
    id: 1,
    wallId: 1,
    setterName: "golden-overhang",
    name: "Golden Overhang",
    setter: "alice",
    setType: "reset",
    setDate: "2026-01-01",
    setterGrade: "V2-4",
    grade: "",
    averageStars: 0,
    ascentCount: 0,
    comments: [],
  };

  it("shows the new comment before the ascent POST resolves, then still refetches for real stats", async () => {
    const post = deferred();
    const { calls } = installFetchMock({
      ...BASE_ROUTES,
      ...signedInAs(memberUser()),
      "/api/climbs": { body: { climbs: [climbFixture] } },
      "/api/climbs/grade-distribution": { body: { grades: [] } },
      "POST /api/ascents": () => post.promise,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /walls/i }));
    await user.click(await screen.findByRole("button", { name: /back/i }));
    await user.click(await screen.findByRole("button", { name: /golden overhang/i }));

    // LogAscentSheet requires attempts >= 1 to submit; attemptsThisSession
    // (App()'s attempts state) starts at 0, pre-filling the sheet's own
    // Attempts field to 0 unless bumped first.
    await user.click(screen.getByRole("button", { name: "Increase attempts" }));
    await user.click(screen.getByRole("button", { name: "Log ascent" }));
    const slider = screen.getByRole("slider", { name: "Rating" });
    await waitFor(() => expect(slider).toHaveFocus());
    await user.keyboard("{Home}");
    await user.type(screen.getByLabelText("Comment"), "Sent it!");
    await user.click(screen.getByRole("button", { name: "Save ascent" }));

    // Still pending: jump to the Info page and the comment should already
    // be there, ahead of the server confirming anything.
    await user.click(screen.getByRole("button", { name: "Climb info" }));
    expect(await screen.findByText("Sent it!")).toBeInTheDocument();

    const climbsCallsBefore = calls.filter((c) => c.pathname === "/api/climbs").length;
    post.resolve({ body: { ascents: [], ascentCount: 1 } });

    // climbsFetch.retry() after the POST resolves is what refreshes
    // ascentCount/averageStars (deliberately not faked optimistically) —
    // confirm it actually re-requested /api/climbs.
    await waitFor(() =>
      expect(calls.filter((c) => c.pathname === "/api/climbs").length).toBeGreaterThan(climbsCallsBefore)
    );
  });
});
