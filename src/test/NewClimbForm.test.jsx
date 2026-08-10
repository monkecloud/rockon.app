// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewClimbForm } from "../screens/NewClimbForm.jsx";
import { NewWallForm } from "../screens/NewWallForm.jsx";
import { clearApiCache } from "../lib/fetch.js";
import { installFetchMock } from "./mockFetch.js";

// Both forms share the same "bottom grade must not be harder than top
// grade" and required-fields validation (§14.11 priority 3) — NewClimbForm
// is fixed to one wallId/resetDate (the "+" from a wall's Climbs page),
// NewWallForm adds a wall picker and always saves as a reset (the "+" from
// the Walls root). See src/screens/NewClimbForm.jsx's own comment for the
// full distinction.

const SETTERS_ROUTE = { "/api/users/setters": { body: { setters: [{ username: "alice", name: "Alice A" }] } } };

beforeEach(() => {
  clearApiCache();
});

// useFetch("/api/users/setters") resolves asynchronously after mount — the
// <select> exists immediately but only the placeholder option until then,
// so selecting "alice" without waiting for it to actually appear is a race.
async function pickSetter(user) {
  await screen.findByRole("option", { name: /alice/i });
  await user.selectOptions(screen.getByLabelText("Setter"), "alice");
}

describe("NewClimbForm", () => {
  it("rejects a blank name/setter", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<NewClimbForm wallId={1} resetDate="2026-01-01" onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Climb name and setter are required.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects a bottom grade harder than the top grade", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<NewClimbForm wallId={1} resetDate="2026-01-01" onSave={onSave} />);

    await user.type(screen.getByLabelText("Climb name"), "Golden Overhang");
    await pickSetter(user);
    await user.selectOptions(screen.getByLabelText("Bottom grade"), "V5");
    await user.selectOptions(screen.getByLabelText("Top grade"), "V2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bottom grade must be the same as or easier than top grade."
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits a composed setterGrade with the fixed wallId/resetDate, trimming the name", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<NewClimbForm wallId={3} resetDate="2026-02-01" onSave={onSave} />);

    await user.type(screen.getByLabelText("Climb name"), "  Golden Overhang  ");
    await pickSetter(user);
    await user.selectOptions(screen.getByLabelText("Bottom grade"), "V2");
    await user.selectOptions(screen.getByLabelText("Top grade"), "V4");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      wallId: 3,
      name: "Golden Overhang",
      setterGrade: "V2-4",
      setter: "alice",
      setDate: "2026-02-01",
      photoUrl: "",
    });
  });

  it("shows the server error returned by onSave, without clearing the form", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn().mockResolvedValue({ success: false, error: "That climb name is already taken." });
    const user = userEvent.setup();
    render(<NewClimbForm wallId={1} resetDate="2026-01-01" onSave={onSave} />);

    await user.type(screen.getByLabelText("Climb name"), "Golden Overhang");
    await pickSetter(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That climb name is already taken.");
    expect(screen.getByLabelText("Climb name")).toHaveValue("Golden Overhang");
  });

  it("locks the Date field to resetDate unless Backfill is checked, then lets it be edited", async () => {
    installFetchMock(SETTERS_ROUTE);
    const user = userEvent.setup();
    render(<NewClimbForm wallId={1} resetDate="2026-03-01" onSave={vi.fn()} />);

    const dateInput = screen.getByLabelText("Date");
    expect(dateInput).toBeDisabled();
    expect(dateInput).toHaveValue("2026-03-01");

    await user.click(screen.getByLabelText(/Backfill/));
    expect(dateInput).toBeEnabled();
  });
});

describe("NewWallForm", () => {
  const WALLS = [
    { id: 1, name: "Back" },
    { id: 2, name: "Slab" },
  ];

  it("defaults to the first wall in the list and always saves as a reset", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<NewWallForm walls={WALLS} onSave={onSave} />);

    await user.type(screen.getByLabelText("Climb name"), "Golden Overhang");
    await pickSetter(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ wallId: 1, setType: "reset" }));
  });

  it("saves whichever wall is picked from the dropdown, not just the default", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<NewWallForm walls={WALLS} onSave={onSave} />);

    await user.selectOptions(screen.getByLabelText("Wall"), "Slab");
    await user.type(screen.getByLabelText("Climb name"), "Golden Overhang");
    await pickSetter(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ wallId: 2 }));
  });

  it("rejects a bottom grade harder than the top grade", async () => {
    installFetchMock(SETTERS_ROUTE);
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<NewWallForm walls={WALLS} onSave={onSave} />);

    await user.type(screen.getByLabelText("Climb name"), "Golden Overhang");
    await pickSetter(user);
    await user.selectOptions(screen.getByLabelText("Bottom grade"), "V5");
    await user.selectOptions(screen.getByLabelText("Top grade"), "V2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bottom grade must be the same as or easier than top grade."
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});
