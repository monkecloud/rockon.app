import { useState } from "react";
import { styles } from "../styles.js";
import { GradeBarChart } from "../components/GradeBarChart.jsx";
import { ChangePasswordForm } from "./SettingsScreen.jsx";

export function ProfileScreen({
  currentUser,
  onSignup,
  onLogin,
  onOpenSettings,
  onOpenLogbook,
  onSetPassword,
}) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [forcePasswordReset, setForcePasswordReset] = useState(false);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
    setPassword("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedUsername = username.trim();

    if (!trimmedUsername || !password) {
      setError("Please fill in both fields.");
      return;
    }

    setSubmitting(true);
    setError("");

    const result =
      mode === "signup"
        ? await onSignup({ username: trimmedUsername, password, name: name.trim() })
        : await onLogin({ username: trimmedUsername, password });

    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setUsername("");
    setPassword("");
    setName("");
    if (result.needsPasswordReset) setForcePasswordReset(true);
  };

  if (currentUser && forcePasswordReset) {
    return (
      <ChangePasswordForm
        requireCurrentPassword={false}
        helperText="Password reset"
        onSave={async (credentials) => {
          const result = await onSetPassword(credentials);
          if (result.success) setForcePasswordReset(false);
          return result;
        }}
      />
    );
  }

  if (currentUser) {
    const initials = currentUser.username.slice(0, 2).toUpperCase();

    return (
      <div style={styles.screen}>
        <div style={styles.profileHeaderRow}>
          <div style={styles.profileLeft}>
            {currentUser.avatarUrl ? (
              <img src={currentUser.avatarUrl} alt="" style={styles.avatarImage} width={56} height={56} loading="lazy" />
            ) : (
              <div style={styles.avatar}>{initials}</div>
            )}
            <p style={styles.profileUsername}>{currentUser.username}</p>
            <p style={styles.profileDisplayName}>
              {currentUser.name || "Add your name"}
            </p>
          </div>
          <div style={styles.profileRight}>
            <div style={styles.profileStatsRow}>
              <div style={styles.profileStat}>
                <span style={styles.profileStatNumber}>{currentUser.followersCount ?? 0}</span>
                <span style={styles.profileStatLabel}>followers</span>
              </div>
              <div style={styles.profileStat}>
                <span style={styles.profileStatNumber}>{currentUser.followingCount ?? 0}</span>
                <span style={styles.profileStatLabel}>following</span>
              </div>
            </div>
            <button type="button" style={styles.settingsButton} onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
        <GradeBarChart
          title="Your ascents"
          endpoint={`/api/users/${encodeURIComponent(currentUser.username)}/grade-counts`}
        />
        <button style={styles.logbookButton} onClick={onOpenLogbook}>
          Logbook
        </button>
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      <div style={styles.modeToggle}>
        <button
          type="button"
          onClick={() => switchMode("login")}
          style={{
            ...styles.modeButton,
            ...(mode === "login" ? styles.modeButtonActive : {}),
          }}
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => switchMode("signup")}
          style={{
            ...styles.modeButton,
            ...(mode === "signup" ? styles.modeButtonActive : {}),
          }}
        >
          Sign up
        </button>
      </div>

      <form style={styles.form} onSubmit={handleSubmit}>
        <label style={styles.label}>
          Username
          <input
            style={styles.input}
            type="text"
            value={username}
            placeholder="janedoe"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {mode === "signup" && (
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
        )}
        <label style={styles.label}>
          Password
          <input
            style={styles.input}
            type="password"
            value={password}
            placeholder="••••••••"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting
            ? "Please wait…"
            : mode === "signup"
            ? "Create account"
            : "Log in"}
        </button>
      </form>
    </div>
  );
}
