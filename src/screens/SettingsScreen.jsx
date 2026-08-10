import { useState } from "react";
import { ChevronRight, LogOut, Camera } from "lucide-react";
import { SETTINGS_OPTIONS } from "../constants.js";
import { styles } from "../styles.js";

export function SettingsScreen({ onSelectOption, onLogout }) {
  return (
    <div style={styles.screen}>
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {SETTINGS_OPTIONS.map((option) => (
          <button
            key={option.id}
            style={styles.wallRow}
            onClick={() => onSelectOption(option.id)}
          >
            <p style={styles.listTitle}>{option.label}</p>
            <ChevronRight size={18} color="var(--color-text-muted)" />
          </button>
        ))}
      </div>
      <div style={{ marginLeft: -20, marginRight: -20 }}>
        <button style={styles.logoutButton} onClick={onLogout}>
          <LogOut size={16} />
          Log out
        </button>
      </div>
    </div>
  );
}

export function ChangeAvatarForm({ currentUser, onSave }) {
  const [preview, setPreview] = useState(currentUser.avatarUrl || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!preview) {
      setError("Choose an image first.");
      return;
    }

    setSubmitting(true);
    setError("");
    const result = await onSave(preview);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        {preview ? (
          <img src={preview} alt="" style={styles.avatarPreview} />
        ) : (
          <div style={styles.avatarPreviewPlaceholder}>
            <Camera size={28} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}

        <label style={styles.pickImageButton}>
          Choose image
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </label>

        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

export function ChangeUsernameForm({ currentUser, onSave }) {
  const [username, setUsername] = useState(currentUser.username);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = username.trim();

    if (!trimmed) {
      setError("Username can't be empty.");
      return;
    }

    setSubmitting(true);
    setError("");
    const result = await onSave(trimmed);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        <label style={styles.label}>
          New username
          <input
            style={styles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

export function ChangeNameForm({ currentUser, onSave }) {
  const [name, setName] = useState(currentUser.name || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);
    setError("");
    const result = await onSave(name.trim());
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        <label style={styles.label}>
          Name
          <input
            style={styles.input}
            type="text"
            value={name}
            placeholder="Jane Doe"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

export function ChangePasswordForm({ onSave, requireCurrentPassword = true, helperText }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if ((requireCurrentPassword && !currentPassword) || !newPassword) {
      setError(
        requireCurrentPassword
          ? "Please fill in both password fields."
          : "Please enter a new password."
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }

    setSubmitting(true);
    setError("");
    const result = await onSave({ currentPassword, newPassword });
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  return (
    <div style={styles.screen}>
      {helperText && <p style={styles.gradeChartTitle}>{helperText}</p>}
      <form style={styles.form} onSubmit={handleSubmit}>
        {requireCurrentPassword && (
          <label style={styles.label}>
            Current password
            <input
              style={styles.input}
              type="password"
              value={currentPassword}
              placeholder="••••••••"
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
        )}
        <label style={styles.label}>
          New password
          <input
            style={styles.input}
            type="password"
            value={newPassword}
            placeholder="••••••••"
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Confirm new password
          <input
            style={styles.input}
            type="password"
            value={confirmPassword}
            placeholder="••••••••"
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </label>
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
