// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangePasswordForm } from "../screens/SettingsScreen.jsx";

describe("ChangePasswordForm", () => {
  it("requires both password fields by default", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ChangePasswordForm onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Please fill in both password fields.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects a confirmation that doesn't match the new password", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ChangePasswordForm onSave={onSave} />);

    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "new-pw-1");
    await user.type(screen.getByLabelText("Confirm new password"), "new-pw-2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("New passwords don't match.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits {currentPassword, newPassword} and clears the fields on success", async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<ChangePasswordForm onSave={onSave} />);

    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "new-pw-1");
    await user.type(screen.getByLabelText("Confirm new password"), "new-pw-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ currentPassword: "old-pw", newPassword: "new-pw-1" });
    expect(await screen.findByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  });

  it("shows the server error and keeps the fields filled when the save fails", async () => {
    const onSave = vi.fn().mockResolvedValue({ success: false, error: "Wrong current password." });
    const user = userEvent.setup();
    render(<ChangePasswordForm onSave={onSave} />);

    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "new-pw-1");
    await user.type(screen.getByLabelText("Confirm new password"), "new-pw-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong current password.");
    expect(screen.getByLabelText("New password")).toHaveValue("new-pw-1");
  });

  it("skips the current-password field and its wording for the forced-reset path", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <ChangePasswordForm
        onSave={onSave}
        requireCurrentPassword={false}
        helperText="Set a new password to continue."
      />
    );

    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByText("Set a new password to continue.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please enter a new password.");
  });
});
