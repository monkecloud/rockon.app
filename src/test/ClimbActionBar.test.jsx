// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClimbActionBar } from "../components/ClimbActionBar.jsx";

describe("ClimbActionBar — logDisabled (signed out)", () => {
  it("disables only the Log ascent button, leaving the attempts counter usable", async () => {
    const onLogAscent = vi.fn();
    const onIncrement = vi.fn();
    const user = userEvent.setup();
    render(
      <ClimbActionBar
        attempts={0}
        onDecrement={vi.fn()}
        onIncrement={onIncrement}
        onLogAscent={onLogAscent}
        logDisabled
      />
    );

    const logButton = screen.getByRole("button", { name: "Log ascent" });
    expect(logButton).toBeDisabled();
    await user.click(logButton);
    expect(onLogAscent).not.toHaveBeenCalled();

    const incrementButton = screen.getByRole("button", { name: "Increase attempts" });
    expect(incrementButton).not.toBeDisabled();
    await user.click(incrementButton);
    expect(onIncrement).toHaveBeenCalledTimes(1);
  });
});

describe("ClimbActionBar — disabled (view-only archived climb)", () => {
  it("disables the whole bar, including the attempts counter", () => {
    render(
      <ClimbActionBar
        attempts={0}
        onDecrement={vi.fn()}
        onIncrement={vi.fn()}
        onLogAscent={vi.fn()}
        disabled
      />
    );

    expect(screen.getByRole("button", { name: "Log ascent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase attempts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease attempts" })).toBeDisabled();
  });
});

describe("ClimbActionBar — enabled", () => {
  it("lets a signed-in user on a current climb tap Log ascent", async () => {
    const onLogAscent = vi.fn();
    const user = userEvent.setup();
    render(
      <ClimbActionBar attempts={2} onDecrement={vi.fn()} onIncrement={vi.fn()} onLogAscent={onLogAscent} />
    );

    const logButton = screen.getByRole("button", { name: "Log ascent" });
    expect(logButton).not.toBeDisabled();
    await user.click(logButton);
    expect(onLogAscent).toHaveBeenCalledTimes(1);
  });
});
