import { PODIUM_HEIGHTS } from "../constants.js";
import { useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";
import { GradeBarChart } from "../components/GradeBarChart.jsx";

const RECENT_ACTIVITY_PLACEHOLDERS = [1, 2, 3, 4, 5];

// Top ascenders, from GET /api/users/leaderboard (ranked by ascentCount
// descending, zero-ascent users excluded server-side). onSelectUser opens
// that user's profile the same way tapping a Search result does.
export function Leaderboard({ onSelectUser }) {
  const { data, loading, error, retry } = useFetch("/api/users/leaderboard");
  const users = data?.users;

  // Nothing to show yet (still loading) or nobody's logged an ascent yet —
  // no placeholder podium, just omit the section entirely, same as before
  // §14.9. A genuine fetch failure is the one case now surfaced (with
  // retry) rather than silently vanishing forever.
  if (loading) return null;
  if (error) {
    return (
      <div style={styles.gradeChartWrapper}>
        <div style={styles.asyncError}>
          <p style={styles.formError} role="alert">{error}</p>
          <button type="button" style={styles.retryButton} onClick={retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!users || users.length === 0) return null;

  // Display order is 2nd/1st/3rd; skip a slot entirely if fewer than 3
  // people have logged ascents yet, rather than padding with anything fake.
  const podiumRanks = [2, 1, 3].filter((rank) => rank <= users.length);

  return (
    <div style={styles.gradeChartWrapper}>
      <p style={styles.gradeChartTitle}>Leaderboard</p>
      <div style={styles.leaderboardRow}>
        {podiumRanks.map((rank) => {
          const user = users[rank - 1];
          const initials = user.username.slice(0, 2).toUpperCase();
          return (
            <button
              key={user.username}
              type="button"
              style={styles.leaderboardColumn}
              onClick={() => onSelectUser(user)}
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" style={styles.avatarImage} width={56} height={56} loading="lazy" />
              ) : (
                <div style={styles.avatar}>{initials}</div>
              )}
              <p style={styles.leaderboardUsername}>{user.username}</p>
              {user.name && <p style={styles.leaderboardName}>{user.name}</p>}
              <p style={styles.leaderboardAscents}>{user.ascentCount} ascents</p>
              <div
                style={{
                  ...styles.leaderboardPodiumBlock,
                  height: PODIUM_HEIGHTS[rank],
                  background: rank === 1 ? "var(--color-accent)" : "var(--color-surface-5)",
                }}
              >
                <span style={styles.leaderboardPodiumRank}>{rank}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function HomeScreen({ onSelectUser }) {
  return (
    <div style={styles.screen}>
      <GradeBarChart title="Climbs on the wall" endpoint="/api/climbs/grade-counts" />
      <Leaderboard onSelectUser={onSelectUser} />
      <div style={{ marginLeft: -20, marginRight: -20 }}>
        <div style={styles.archiveBar}>
          <p style={{ margin: 0 }}>Recent Activity</p>
        </div>
        {RECENT_ACTIVITY_PLACEHOLDERS.map((n) => (
          <button key={n} style={styles.wallRow}>
            <p style={styles.listTitle}>Placeholder {n}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
