import { useEffect, useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { climbDisplayGrade } from "../../shared/grades.js";
import { matchesClimbQuery } from "../lib/climbs.js";
import { styles } from "../styles.js";

// Search tab: a textbox up top, two mode buttons underneath ("Climbs" /
// "Users") to scope the query, and a live results list below that fills in
// as the user types. Climbs are filtered client-side against the same
// climbs list the Walls tab already has in memory; users are looked up via
// GET /api/users/search since the full user list isn't fetched up front.
export function SearchScreen({
  climbs,
  query,
  mode,
  userResults,
  onQueryChange,
  onModeChange,
  onUserResultsChange,
  onSelectClimb,
  onSelectUser,
}) {
  const trimmedQuery = query.trim();

  const climbResults = useMemo(() => {
    if (!trimmedQuery || !climbs) return [];
    return climbs.filter((climb) => matchesClimbQuery(climb, trimmedQuery));
  }, [climbs, trimmedQuery]);

  // Debounced (300ms) so typing a full query doesn't fire a request per
  // keystroke — "cubesnail" was nine requests, eight already stale on
  // arrival (§14.18 part 1). `cancelled` still guards against an
  // out-of-order response landing after a newer query has superseded it.
  useEffect(() => {
    if (mode !== "users" || !trimmedQuery) {
      onUserResultsChange([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/users/search?q=${encodeURIComponent(trimmedQuery)}`)
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) onUserResultsChange(data.users || []);
        })
        .catch((err) => console.error("Failed to search users:", err));
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, trimmedQuery]);

  const results = mode === "climbs" ? climbResults : userResults;

  return (
    <div style={styles.screen}>
      <input
        style={{ ...styles.input, ...styles.searchInput }}
        type="text"
        placeholder="Search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <div style={{ ...styles.modeToggle, marginTop: 12 }}>
        <button
          type="button"
          onClick={() => onModeChange("climbs")}
          style={{
            ...styles.modeButton,
            ...(mode === "climbs" ? styles.modeButtonActive : {}),
          }}
        >
          Climbs
        </button>
        <button
          type="button"
          onClick={() => onModeChange("users")}
          style={{
            ...styles.modeButton,
            ...(mode === "users" ? styles.modeButtonActive : {}),
          }}
        >
          Users
        </button>
      </div>

      {trimmedQuery &&
        (results.length === 0 ? (
          <p style={styles.placeholderText}>No {mode} match "{trimmedQuery}".</p>
        ) : (
          <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
            {mode === "climbs"
              ? results.map((climb) => (
                  <button
                    key={`${climb.wallId}::${climb.setterName}`}
                    style={styles.climbRow}
                    onClick={() => onSelectClimb(climb)}
                  >
                    <div style={styles.climbRowLeft}>
                      <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
                      <span style={styles.climbAscents}>{climb.ascentCount ?? 0} ascents</span>
                    </div>
                    <div style={styles.climbRowRight}>
                      <span style={styles.climbTitle}>{climb.name}</span>
                      <span style={styles.climbSetter}>{climb.setter}</span>
                    </div>
                  </button>
                ))
              : results.map((user) => (
                  <button
                    key={user.username}
                    style={styles.wallRow}
                    onClick={() => onSelectUser(user)}
                  >
                    <div>
                      <p style={styles.listTitle}>{user.username}</p>
                      {user.name && <p style={styles.listMeta}>{user.name}</p>}
                    </div>
                    <ChevronRight size={18} color="var(--color-text-muted)" />
                  </button>
                ))}
          </div>
        ))}
    </div>
  );
}
