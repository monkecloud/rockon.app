// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogAscentSheet } from "../components/LogAscentSheet.jsx";

// §14.11 priority 3: LogAscentSheet requires starRating >= 0.5 and
// attempts >= 1 before it will call onSubmit — this is the app's only
// client-side gate on ascent logging (the server re-validates too, §14.6,
// but a silent no-op submit here would be a confusing dead button).
function setup(props = {}) {
  const onClose = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <LogAscentSheet
      open
      attemptsThisSession={2}
      currentGrade="V3"
      ascentClaims={[]}
      onClose={onClose}
      onSubmit={onSubmit}
      {...props}
    />
  );
  return { ...utils, onClose, onSubmit };
}

// The sheet moves focus onto the rating slider itself on open, via a
// double-requestAnimationFrame (see the component's own comment on why —
// a transitioned visibility style not landing for a frame). Racing that
// with a manual slider.focus() is exactly the kind of interleaving that's
// flaky in a real browser too; waiting for it to land first is the
// deterministic way to drive keyboard input into the rating control.
async function waitForRatingFocus() {
  const slider = screen.getByRole("slider", { name: "Rating" });
  await waitFor(() => expect(slider).toHaveFocus());
  return slider;
}

describe("LogAscentSheet — validation", () => {
  it("blocks submit with no rating, even though attempts pre-fills from the session count", async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save ascent" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submit when attempts is dropped to 0, even with a rating set", async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();

    await waitForRatingFocus();
    await user.keyboard("{End}"); // jumps to 5 stars

    const attemptsInput = screen.getByLabelText("Attempts");
    await user.clear(attemptsInput);
    await user.type(attemptsInput, "0");

    await user.click(screen.getByRole("button", { name: "Save ascent" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the rating, attempts, grade, and comment once both minimums are met", async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();

    await waitForRatingFocus();
    await user.keyboard("{Home}"); // jumps to 0.5 stars, the practical minimum
    await user.type(screen.getByLabelText("Comment"), "Fun overhang");

    await user.click(screen.getByRole("button", { name: "Save ascent" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        starRating: 0.5,
        attempts: 2,
        attemptsThisSession: 2,
        grade: "V3",
        comment: "Fun overhang",
        logAttempts: true,
      })
    );
  });

  it("offers the next ascent-claim slot while fewer than 5 are taken", () => {
    setup({ ascentClaims: [{ id: 1 }, { id: 2 }] });
    expect(screen.getByLabelText(/Third ascent/)).toBeInTheDocument();
  });

  it("hides the ascent-claim fields once all 5 slots are taken", () => {
    setup({ ascentClaims: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] });
    // Matching /ascent$/ alone would also match the dialog's own
    // aria-label="Log ascent" — anchor to the ordinal-prefixed field label
    // pattern instead ("First ascent", "Second ascent", ...).
    expect(screen.queryByLabelText(/^(First|Second|Third|Fourth|Fifth) ascent$/)).not.toBeInTheDocument();
  });
});
