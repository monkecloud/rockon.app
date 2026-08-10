// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StarRatingInput } from "../components/StarRatingInput.jsx";

// §14.11 priority 6, pointer-driven. jsdom's getBoundingClientRect returns
// all zeros by default (no real layout), so the pointer-drag tests below
// stub it on the rendered slider to a known width — the keyboard tests
// don't need this since they never call it (setPointerCapture is already
// globally stubbed in src/test/setup.js since real jsdom doesn't implement
// the Pointer Events API's capture methods).
function Controlled({ initial = 0 }) {
  const [value, setValue] = useState(initial);
  return <StarRatingInput value={value} onChange={setValue} />;
}

function mockWidth(el, width = 250) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: width,
    top: 0,
    bottom: 30,
    width,
    height: 30,
    x: 0,
    y: 0,
  });
}

describe("StarRatingInput — pointer drag", () => {
  it("sets the rating from a single pointer-down tap, in 0.5-star steps", () => {
    render(<Controlled />);
    const slider = screen.getByRole("slider");
    mockWidth(slider);

    // Halfway across a 5-star, 250px-wide row -> 2.5 stars.
    fireEvent.pointerDown(slider, { clientX: 125, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", "2.5");
  });

  it("tracks pointer-move only while dragging, and stops once the pointer is released", () => {
    render(<Controlled />);
    const slider = screen.getByRole("slider");
    mockWidth(slider);

    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", "0");

    fireEvent.pointerMove(slider, { clientX: 250, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", "5");

    fireEvent.pointerUp(slider, { pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 0, pointerId: 1 });
    // A move after release must not drag the rating back down.
    expect(slider).toHaveAttribute("aria-valuenow", "5");
  });

  it("clamps to the row's bounds — off either edge still reads 0 or 5", () => {
    render(<Controlled />);
    const slider = screen.getByRole("slider");
    mockWidth(slider);

    fireEvent.pointerDown(slider, { clientX: -50, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", "0");

    fireEvent.pointerDown(slider, { clientX: 999, pointerId: 1 });
    expect(slider).toHaveAttribute("aria-valuenow", "5");
  });
});

describe("StarRatingInput — keyboard (§14.13 part 5)", () => {
  it("Right/Up increase and Left/Down decrease by 0.5 steps, clamped to [0, 5]", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={5} />);
    const slider = screen.getByRole("slider");
    slider.focus();

    await user.keyboard("{ArrowRight}"); // already at max, stays clamped
    expect(slider).toHaveAttribute("aria-valuenow", "5");

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(slider).toHaveAttribute("aria-valuenow", "4");

    await user.keyboard(
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}"
    );
    expect(slider).toHaveAttribute("aria-valuenow", "0"); // clamped, not negative
  });

  it("Home jumps to 0.5 (the practical minimum) and End jumps to 5", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={3} />);
    const slider = screen.getByRole("slider");
    slider.focus();

    await user.keyboard("{Home}");
    expect(slider).toHaveAttribute("aria-valuenow", "0.5");

    await user.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuenow", "5");
  });
});
