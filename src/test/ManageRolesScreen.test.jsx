// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManageRolesScreen } from "../screens/ManageRolesScreen.jsx";
import { clearApiCache } from "../lib/fetch.js";
import { installFetchMock } from "./mockFetch.js";

// §14.11 priority 4: ManageRolesScreen's changedUsernames diff — role
// dropdowns stage a pick locally (pendingRoles) and Save must POST only the
// usernames whose staged pick actually differs from the server's role, not
// every visible user (see the component's own comment on why: it used to
// save on every dropdown change).

const usersFixture = [
  { username: "alice", name: "Alice", isModerator: true },
  { username: "bob", name: "Bob", isSetter: true },
  { username: "carol", name: "Carol" },
];

beforeEach(() => {
  clearApiCache();
});

describe("ManageRolesScreen — role filter tabs", () => {
  it("filters to Moderator by default; switching to Users shows everyone", async () => {
    installFetchMock({ "/api/users": { body: { users: usersFixture } } });
    const user = userEvent.setup();
    render(<ManageRolesScreen />);

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    expect(screen.queryByText("carol")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Users" }));
    expect(await screen.findByText("bob")).toBeInTheDocument();
    expect(screen.getByText("carol")).toBeInTheDocument();
  });
});

describe("ManageRolesScreen — staged role changes", () => {
  it("Save is disabled until a role is actually changed, and POSTs only that user", async () => {
    const { calls } = installFetchMock({
      "/api/users": { body: { users: usersFixture } },
      "POST /api/users/bob/role": { body: { user: { ...usersFixture[1], isSetter: false } } },
    });
    const user = userEvent.setup();
    render(<ManageRolesScreen />);

    await user.click(await screen.findByRole("button", { name: "Users" }));
    // Rendered in usersFixture order on the unfiltered "Users" tab: alice,
    // bob, carol — index 1 is bob's role <select>. None of the rows expose
    // an accessible name of their own to query by, so this relies on that
    // fixed order.
    const selects = await screen.findAllByRole("combobox");
    expect(selects).toHaveLength(3);

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();

    await user.selectOptions(selects[1], "member"); // bob: setter -> member
    expect(saveButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes (1)" })).toBeInTheDocument();

    await user.click(saveButton);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved 1 role change."));
    const roleCalls = calls.filter((c) => c.pathname.endsWith("/role"));
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0].pathname).toBe("/api/users/bob/role");
    expect(JSON.parse(roleCalls[0].init.body)).toEqual({ role: "member" });
  });

  it("shows a per-user error and leaves Save re-enabled when a role change fails", async () => {
    installFetchMock({
      "/api/users": { body: { users: usersFixture } },
      "POST /api/users/bob/role": { status: 403, body: { error: "Not allowed." } },
    });
    const user = userEvent.setup();
    render(<ManageRolesScreen />);

    await user.click(await screen.findByRole("button", { name: "Users" }));
    const selects = await screen.findAllByRole("combobox");
    await user.selectOptions(selects[1], "member");
    await user.click(screen.getByRole("button", { name: "Save changes (1)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save 1 role: Not allowed.");
  });
});

describe("ManageRolesScreen — reset password", () => {
  it("resets a user's password and shows a success message", async () => {
    installFetchMock({
      "/api/users": { body: { users: usersFixture } },
      "POST /api/users/alice/reset-password": { body: {} },
    });
    const user = userEvent.setup();
    render(<ManageRolesScreen />);

    // Default "Moderator" tab shows only alice, so there's exactly one
    // Reset password button.
    await user.click(await screen.findByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "alice's password was reset — they'll be prompted to set a new one at next login."
    );
  });
});
