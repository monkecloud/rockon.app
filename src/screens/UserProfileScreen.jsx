import { styles } from "../styles.js";
import { GradeBarChart } from "../components/GradeBarChart.jsx";

// Read-only view of someone else's profile, opened by tapping a user in
// Search results (or in a followers/following list — see FollowListScreen).
// Same header layout as ProfileScreen's logged-in view (avatar, name,
// follower/following counts, grade pyramid) minus anything only the account
// owner should see or do (Settings, Logbook) — but with a Follow/Unfollow
// button in Settings' spot, and the follower/following counts tappable to
// drill into that list, neither of which make sense on your own profile.
export function UserProfileScreen({ user, currentUser, onFollow, onUnfollow, onViewFollowers, onViewFollowing }) {
  const initials = user.username.slice(0, 2).toUpperCase();
  const isSelf = currentUser?.username === user.username;

  return (
    <div style={styles.screen}>
      <div style={styles.profileHeaderRow}>
        <div style={styles.profileLeft}>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" style={styles.avatarImage} width={56} height={56} loading="lazy" />
          ) : (
            <div style={styles.avatar}>{initials}</div>
          )}
          <p style={styles.profileUsername}>{user.username}</p>
          {user.name && <p style={styles.profileDisplayName}>{user.name}</p>}
        </div>
        <div style={styles.profileRight}>
          <div style={styles.profileStatsRow}>
            <button type="button" style={styles.profileStatButton} onClick={onViewFollowers}>
              <span style={styles.profileStatNumber}>{user.followersCount ?? 0}</span>
              <span style={styles.profileStatLabel}>followers</span>
            </button>
            <button type="button" style={styles.profileStatButton} onClick={onViewFollowing}>
              <span style={styles.profileStatNumber}>{user.followingCount ?? 0}</span>
              <span style={styles.profileStatLabel}>following</span>
            </button>
          </div>
          {currentUser && !isSelf && (
            <button
              type="button"
              style={user.isFollowing ? styles.settingsButton : styles.followButton}
              onClick={user.isFollowing ? onUnfollow : onFollow}
            >
              {user.isFollowing ? "Unfollow" : "Follow"}
            </button>
          )}
        </div>
      </div>
      <GradeBarChart
        title={`${user.username}'s ascents`}
        endpoint={`/api/users/${encodeURIComponent(user.username)}/grade-counts`}
      />
    </div>
  );
}
