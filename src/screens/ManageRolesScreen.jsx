import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ROLE_OPTIONS } from "../constants.js";
import { apiSend, useFetch } from "../lib/fetch.js";
import { roleOf } from "../lib/roles.js";
import { styles } from "../styles.js";

// Stacked, top-to-bottom filter tabs on the Admin screen: Moderator and
// Setter narrow the list to just that role; Users is unfiltered (everyone,
// including members and admins).
const ROLE_FILTER_TABS = [
  { id: "moderator", label: "Moderator" },
  { id: "setter", label: "Setter" },
  { id: "users", label: "Users" },
];

// Admin-only settings sub-page: lists every account and lets an admin
// change anyone's role via GET/POST /api/users(/:username/role) — grants
// and revokes moderator/admin access.
export function ManageRolesScreen() {
  const { data: usersData, loading, error: fetchError, retry } = useFetch("/api/users");
  const [users, setUsers] = useState(null);
  // Role dropdowns no longer save on change — they stage a pick here, and
  // Save (below) is what actually POSTs the ones that differ from the
  // account's role on the server.
  const [pendingRoles, setPendingRoles] = useState({});
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [savingAll, setSavingAll] = useState(false);
  const [resettingUsername, setResettingUsername] = useState(null);
  const [activeRoleTab, setActiveRoleTab] = useState("moderator");

  // Mirrors useFetch's data into local state so a save below can patch it
  // in place for instant feedback, rather than waiting on a refetch (apiSend
  // does clear the cache on success, so a later natural refetch picks up
  // the same change too).
  useEffect(() => {
    if (usersData?.users) {
      setUsers(usersData.users);
      setPendingRoles(Object.fromEntries(usersData.users.map((u) => [u.username, roleOf(u)])));
    }
  }, [usersData]);

  const handleRoleSelect = (username, role) => {
    setPendingRoles((prev) => ({ ...prev, [username]: role }));
  };

  // Only usernames whose staged pick actually differs from their current
  // server-side role — Save only POSTs these.
  const changedUsernames = (users || [])
    .filter((user) => pendingRoles[user.username] !== roleOf(user))
    .map((user) => user.username);

  const handleSaveRoles = async () => {
    setSavingAll(true);
    setError("");
    setSuccessMessage("");
    const results = await Promise.all(
      changedUsernames.map((username) =>
        apiSend(`/api/users/${encodeURIComponent(username)}/role`, {
          body: { role: pendingRoles[username] },
        }).then((result) => ({ ...result, username }))
      )
    );

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (succeeded.length) {
      setUsers((prev) =>
        prev.map((u) => succeeded.find((r) => r.username === u.username)?.data.user ?? u)
      );
    }

    if (failed.length) {
      const names = failed.map((f) => f.error || f.username).join(", ");
      setError(`Couldn't save ${failed.length} role${failed.length === 1 ? "" : "s"}: ${names}`);
    } else {
      setSuccessMessage(`Saved ${succeeded.length} role change${succeeded.length === 1 ? "" : "s"}.`);
    }
    setSavingAll(false);
  };

  const handleResetPassword = async (username) => {
    setResettingUsername(username);
    setError("");
    setSuccessMessage("");
    const result = await apiSend(`/api/users/${encodeURIComponent(username)}/reset-password`);
    if (!result.success) {
      setError(result.error);
    } else {
      setSuccessMessage(`${username}'s password was reset — they'll be prompted to set a new one at next login.`);
    }
    setResettingUsername(null);
  };

  const visibleUsers = (users || []).filter((user) =>
    activeRoleTab === "users" ? true : roleOf(user) === activeRoleTab
  );

  return (
    <div style={styles.screen}>
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20, marginBottom: 20 }}>
        {ROLE_FILTER_TABS.map((tab) => {
          const isActive = tab.id === activeRoleTab;
          return (
            <button
              key={tab.id}
              style={{
                ...styles.wallRow,
                color: isActive ? "var(--color-accent-bright)" : "var(--color-text-primary)",
              }}
              onClick={() => setActiveRoleTab(tab.id)}
            >
              <p style={{ ...styles.listTitle, margin: 0, color: "inherit" }}>{tab.label}</p>
              {isActive && <ChevronRight size={18} color="var(--color-accent-bright)" />}
            </button>
          );
        })}
      </div>

      {error && <p style={styles.formError} role="alert">{error}</p>}
      {successMessage && <p style={styles.formSuccess} role="status">{successMessage}</p>}
      {users === null && loading && <p style={styles.placeholderText}>Loading…</p>}
      {users === null && fetchError && (
        <div style={styles.asyncError}>
          <p style={styles.formError} role="alert">{fetchError}</p>
          <button type="button" style={styles.retryButton} onClick={retry}>
            Retry
          </button>
        </div>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {visibleUsers.map((user) => (
          <div key={user.username} style={styles.adminUserRow}>
            <div style={styles.adminUserRowTop}>
              <div>
                <p style={styles.listTitle}>{user.username}</p>
                {user.name && <p style={styles.listMeta}>{user.name}</p>}
              </div>
              <select
                style={{ ...styles.input, width: "auto" }}
                value={pendingRoles[user.username] ?? roleOf(user)}
                disabled={savingAll}
                onChange={(e) => handleRoleSelect(user.username, e.target.value)}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              style={styles.resetPasswordButton}
              disabled={resettingUsername === user.username}
              onClick={() => handleResetPassword(user.username)}
            >
              {resettingUsername === user.username ? "Resetting…" : "Reset password"}
            </button>
          </div>
        ))}
        {users !== null && visibleUsers.length === 0 && (
          <p style={styles.placeholderText}>No {activeRoleTab === "users" ? "users" : `${activeRoleTab}s`} yet.</p>
        )}
      </div>

      {users !== null && (
        <button
          type="button"
          style={{ ...styles.button, marginTop: 20 }}
          disabled={savingAll || changedUsernames.length === 0}
          onClick={handleSaveRoles}
        >
          {savingAll
            ? "Saving…"
            : changedUsernames.length > 0
            ? `Save changes (${changedUsernames.length})`
            : "Save changes"}
        </button>
      )}
    </div>
  );
}
