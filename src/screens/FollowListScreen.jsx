import { ChevronRight } from "lucide-react";
import { useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";
import { Async } from "../components/Async.jsx";

// Backs the follower/following list screens opened from UserProfileScreen's
// tappable counts. Same row shape/style as SearchScreen's "Users" results —
// tapping a row opens that person's own UserProfileScreen in turn.
export function FollowListScreen({ username, type, onSelectUser }) {
  const { data, loading, error, retry } = useFetch(`/api/users/${encodeURIComponent(username)}/${type}`);
  const users = data?.users;

  return (
    <div style={styles.screen}>
      <Async loading={loading} error={error} retry={retry}>
        {users && users.length === 0 ? (
          <p style={styles.placeholderText}>No {type} yet.</p>
        ) : (
          <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
            {(users || []).map((u) => (
              <button key={u.username} style={styles.wallRow} onClick={() => onSelectUser(u)}>
                <div>
                  <p style={styles.listTitle}>{u.username}</p>
                  {u.name && <p style={styles.listMeta}>{u.name}</p>}
                </div>
                <ChevronRight size={18} color="var(--color-text-muted)" />
              </button>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
