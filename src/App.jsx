import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Home,
  ListChecks,
  Search,
  User,
  LogOut,
  ChevronRight,
  ArrowLeft,
  Info,
  Image as ImageIcon,
  Minus,
  Plus,
  Star,
  StarHalf,
  Trash2,
  Camera,
  Filter,
  Shield,
  Check,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Boilerplate mobile-style web app
// - Persistent top bar showing the current screen's title, with a back
//   button when drilled into a list item
// - 4 tabs, persistent bottom bar with icon + label
// - Home tab: shows a grade pyramid of every *currently active* climb
//   across all walls (see GradeBarChart — same component the Profile
//   page uses for the logged-in user's own ascent history, just pointed
//   at a different endpoint)
// - Walls tab (bottom bar label): a scrollable list of "walls", each
//   drilling into its own "Climbs" list, each of which drills into a
//   "Climb" detail page. Top bar title reflects the current level
//   (Walls / Climbs / Climb); selection persists if you switch tabs away
//   and back. Climb data (name, grade, comments) is fetched from the
//   server (GET /api/climbs, backed by server/climbs.json — see that file
//   to add/edit climbs). The Climb detail page has a full-height
//   zoomable/pannable placeholder image (pinch, scroll-wheel, and drag all
//   work), with a secondary bar pinned below the persistent top bar
//   showing the climb's grade and name. A message-circle icon in the
//   top-right of the persistent top bar opens that climb's Comments page.
// - Profile tab: sign up / log in against a small Express server that
//   stores users in server/users.json — shared across everyone hitting
//   this server, not just the local browser (plaintext, no real auth —
//   see server/index.js for where to add hashing/a real database)
// - Search tab: placeholder screen, ready for you to build out
// ---------------------------------------------------------------------------

const TABS = [
  { id: "home", label: "Home", icon: Home },
  { id: "list", label: "Walls", icon: ListChecks },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Profile", icon: User },
];

// Appended to TABS (as the rightmost tab) only when currentUser.isAdmin —
// see the visibleTabs computation in App().
const ADMIN_TAB = { id: "admin", label: "Admin", icon: Shield };

// Appended for moderators/setters (admins too, since they keep every
// moderator/setter capability) — see the visibleTabs computation in App().
const APPROVE_TAB = { id: "approve", label: "Approve", icon: Check };

// The 4 walls. Climbs themselves (name, grade, comments) are fetched
// from the server at /api/climbs — see server/climbs.json — and grouped by
// wallId; climb counts aren't hardcoded here since which climbs are
// "current" on a wall changes as sets are reset/backfilled server-side.
const WALLS = [
  { id: 1, name: "Back" },
  { id: 2, name: "Slab" },
  { id: 3, name: "Cave" },
  { id: 4, name: "Front" },
];

const LIST_ITEMS = WALLS.map((wall) => ({ id: wall.id, title: wall.name }));

// ---------------------------------------------------------------------------
// Client-side session persistence — plain localStorage, so the logged-in
// session survives page refreshes. The user *database* itself now lives on
// the server (see server/index.js + server/users.json), which is what makes
// it shared across everyone hitting this server rather than per-browser.
// Guarded so this file also behaves in environments without a browser
// window (e.g. server-side rendering).
// ---------------------------------------------------------------------------
const STORAGE_KEYS = {
  currentUser: "boilerplate:currentUser",
};

function loadFromStorage(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error("Failed to read from localStorage:", err);
    return fallback;
  }
}

function saveToStorage(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error("Failed to write to localStorage:", err);
  }
}

const RECENT_ACTIVITY_PLACEHOLDERS = [1, 2, 3, 4, 5];

// Static stand-in data — no leaderboard endpoint exists yet server-side.
// Shaped like the real user records (username/name/avatarUrl/ascentCount)
// so wiring this up to a real "top ascenders" endpoint later is a data swap,
// not a layout change.
const LEADERBOARD_PLACEHOLDERS = [
  { rank: 1, username: "placeholder1", name: "Placeholder One", avatarUrl: "", ascentCount: 128 },
  { rank: 2, username: "placeholder2", name: "Placeholder Two", avatarUrl: "", ascentCount: 97 },
  { rank: 3, username: "placeholder3", name: "Placeholder Three", avatarUrl: "", ascentCount: 84 },
];

// Podium block heights, tallest in the middle (1st place) — left-to-right
// display order is 2nd/1st/3rd, the standard podium arrangement.
const PODIUM_HEIGHTS = { 1: 64, 2: 44, 3: 30 };
const PODIUM_ORDER = [2, 1, 3];

function Leaderboard() {
  return (
    <div style={styles.gradeChartWrapper}>
      <p style={styles.gradeChartTitle}>Leaderboard</p>
      <div style={styles.leaderboardRow}>
        {PODIUM_ORDER.map((rank) => {
          const entry = LEADERBOARD_PLACEHOLDERS.find((e) => e.rank === rank);
          const initials = entry.username.slice(0, 2).toUpperCase();
          return (
            <div key={rank} style={styles.leaderboardColumn}>
              {entry.avatarUrl ? (
                <img src={entry.avatarUrl} alt="" style={styles.avatarImage} />
              ) : (
                <div style={styles.avatar}>{initials}</div>
              )}
              <p style={styles.leaderboardUsername}>{entry.username}</p>
              <p style={styles.leaderboardName}>{entry.name}</p>
              <p style={styles.leaderboardAscents}>{entry.ascentCount} ascents</p>
              <div
                style={{
                  ...styles.leaderboardPodiumBlock,
                  height: PODIUM_HEIGHTS[rank],
                  background: rank === 1 ? "var(--color-accent)" : "var(--color-surface-5)",
                }}
              >
                <span style={styles.leaderboardPodiumRank}>{rank}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HomeScreen() {
  return (
    <div style={styles.screen}>
      <GradeBarChart title="Climbs on the wall" endpoint="/api/climbs/grade-counts" />
      <Leaderboard />
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

// A full-height, zoomable/pannable image area with its own toolbar
// (zoom out / percentage / zoom in / reset) that stays pinned just below
// the persistent top bar. Uses the Pointer Events API so mouse drag,
// touch drag, and two-finger pinch all go through the same code path.
function ZoomableImageViewer({ title, subtitle, photoUrl }) {
  const imageRef = useRef(null);
  // Mutable, not React state: on mobile, calling setState on every single
  // pointermove event was enough to make pinch/drag feel glitchy, since
  // each update forced a full re-render. Writing the transform straight to
  // the DOM node keeps this at native frame rate.
  const transformState = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map());
  const lastDistance = useRef(null);
  const dragStart = useRef(null);

  const clampScale = (value) => Math.min(4, Math.max(1, value));

  const applyTransform = () => {
    const { scale, x, y } = transformState.current;
    if (imageRef.current) {
      imageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
  };

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      dragStart.current = {
        x: e.clientX - transformState.current.x,
        y: e.clientY - transformState.current.y,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      lastDistance.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const handlePointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDistance.current) {
        transformState.current.scale = clampScale(
          transformState.current.scale * (distance / lastDistance.current)
        );
      }
      lastDistance.current = distance;
    } else if (pointers.current.size === 1 && dragStart.current) {
      transformState.current.x = e.clientX - dragStart.current.x;
      transformState.current.y = e.clientY - dragStart.current.y;
    }

    applyTransform();
  };

  const handlePointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastDistance.current = null;
    if (pointers.current.size === 0) dragStart.current = null;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    transformState.current.scale = clampScale(transformState.current.scale + delta);
    applyTransform();
  };

  return (
    <div>
      <div style={styles.secondaryBar}>
        <span style={styles.secondaryBarPlaceholder}>{title}</span>
        {subtitle && <span style={styles.secondaryBarSubtitle}>{subtitle}</span>}
      </div>

      <div
        style={styles.imageStage}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {photoUrl ? (
          <img ref={imageRef} src={photoUrl} alt="" style={styles.climbPhoto} />
        ) : (
          <div ref={imageRef} style={styles.imagePlaceholder}>
            <ImageIcon size={56} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}
      </div>
    </div>
  );
}

function CommentsScreen({ climb, currentUser, onDeleteComment }) {
  const comments = climb?.comments ?? [];

  return (
    <div style={styles.screen}>
      {comments.length === 0 ? (
        <p style={styles.placeholderText}>No comments yet.</p>
      ) : (
        <div style={styles.list}>
          {comments.map((comment) => {
            // Only a comment's own author can delete it, and only
            // user-submitted comments (ones tied to a logged ascent) are
            // deletable at all — the seeded sample comments aren't.
            const canDelete =
              Boolean(comment.ascentId) &&
              currentUser &&
              comment.author === currentUser.username;

            return (
              <div key={comment.id} style={styles.listRow}>
                <div style={styles.commentHeader}>
                  <p style={styles.commentAuthor}>{comment.author}</p>
                  {canDelete && (
                    <button
                      type="button"
                      style={styles.commentDeleteButton}
                      onClick={() => onDeleteComment(comment.ascentId)}
                      aria-label="Delete comment"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <p style={styles.commentText}>{comment.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ListScreen({
  selectedItem,
  selectedSubItem,
  climbsByWall,
  onSelectItem,
  onSelectSubItem,
  archiveExpanded,
  archiveWalls,
  onToggleArchive,
  onSelectArchiveWall,
  onOpenFilter,
}) {
  const [climbSearch, setClimbSearch] = useState("");

  if (selectedItem && selectedSubItem) {
    const climb = (climbsByWall[selectedItem.id] || []).find((c) => c.name === selectedSubItem);
    const title = climb ? climbTitleNode(climb) : "Loading…";
    const subtitle = climb ? `Set by ${climb.setter}` : undefined;

    return <ZoomableImageViewer title={title} subtitle={subtitle} photoUrl={climb?.photoUrl} />;
  }

  if (selectedItem) {
    const climbs = climbsByWall[selectedItem.id] || [];
    const filteredClimbs = climbs.filter((climb) =>
      climb.name.toLowerCase().includes(climbSearch.trim().toLowerCase())
    );

    return (
      <div style={styles.screen}>
        {climbs.length > 0 && (
          <GradeBarChart
            title={`${climbs.length} climbs`}
            counts={bucketGradeCounts(climbs.map(climbBucketGrade))}
          />
        )}
        <div style={styles.climbsFilterRow}>
          <input
            style={styles.climbsFilterInput}
            type="text"
            placeholder="Search climbs"
            value={climbSearch}
            onChange={(e) => setClimbSearch(e.target.value)}
          />
          <button type="button" style={styles.climbsFilterButton} onClick={onOpenFilter}>
            <Filter size={18} />
          </button>
        </div>
        {climbs.length === 0 ? (
          <p style={styles.placeholderText}>Loading climbs…</p>
        ) : filteredClimbs.length === 0 ? (
          <p style={styles.placeholderText}>No climbs match "{climbSearch}".</p>
        ) : (
          <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
            {filteredClimbs.map((climb) => (
              <button
                key={`${climb.setId}::${climb.name}`}
                style={styles.climbRow}
                onClick={() => onSelectSubItem(climb.name)}
              >
                <div style={styles.climbRowLeft}>
                  <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
                  <span style={styles.climbStars}>
                    {(() => {
                      const filled = Math.round(climb.averageStars || 0);
                      return "⭐".repeat(filled) + "☆".repeat(5 - filled);
                    })()}
                  </span>
                  <span style={styles.climbAscents}>{climb.ascentCount ?? 0} ascents</span>
                </div>
                <div style={styles.climbRowRight}>
                  <span style={styles.climbTitle}>{climb.name}</span>
                  <span style={styles.climbSetter}>{climb.setter}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {LIST_ITEMS.map((item) => (
          <button key={item.id} style={styles.wallRow} onClick={() => onSelectItem(item)}>
            <div>
              <p style={styles.listTitle}>{item.title}</p>
              <p style={styles.listMeta}>{(climbsByWall[item.id] || []).length} climbs</p>
            </div>
            <ChevronRight size={18} color="var(--color-text-muted)" />
          </button>
        ))}
        <ArchiveSection
          expanded={archiveExpanded}
          walls={archiveWalls}
          onToggle={onToggleArchive}
          onSelectWall={onSelectArchiveWall}
        />
      </div>
    </div>
  );
}

const WALL_NAME_BY_ID = Object.fromEntries(WALLS.map((wall) => [wall.id, wall.name]));

// Not a separate page — tapping "Archive" expands the list of walls that
// have older climbs, right underneath it, in the same Walls list. Tapping
// a wall, though, opens its own dedicated page of climbs (see onSelectWall
// / App's viewingArchiveWallId) — same as tapping a wall does for its
// current climbs, and just as flat: every past climb for that wall in one
// list, with no reset/backfill/date grouping surfaced, exactly like the
// live Climbs page shows no such grouping either.
//
// Fully controlled from App (expanded/walls all live there) so this state
// survives ListScreen unmounting — e.g. switching tabs away and back, or
// drilling into a wall/climb and backing out — instead of resetting every
// time this component remounts.
function ArchiveSection({ expanded, walls, onToggle, onSelectWall }) {
  return (
    <>
      <div style={styles.archiveBar} onClick={onToggle}>
        <span>Archive</span>
        <ChevronRight
          size={18}
          color="var(--color-text-muted)"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        />
      </div>

      {expanded &&
        (walls === null ? (
          <p style={{ ...styles.placeholderText, padding: "16px 20px" }}>Loading…</p>
        ) : walls.length === 0 ? (
          <p style={{ ...styles.placeholderText, padding: "16px 20px" }}>No archived climbs yet.</p>
        ) : (
          walls.map((wall) => (
            <div
              key={wall.wallId}
              style={styles.archiveSetRow}
              onClick={() => onSelectWall(wall.wallId)}
            >
              <div>
                <p style={styles.listTitle}>
                  {WALL_NAME_BY_ID[wall.wallId] ?? `Wall ${wall.wallId}`}
                </p>
                <p style={styles.listMeta}>{wall.climbs.length} climbs</p>
              </div>
              <ChevronRight size={18} color="var(--color-text-muted)" />
            </div>
          ))
        ))}
    </>
  );
}

// The dedicated page for one wall's archived climbs — opened from
// ArchiveSection, styled the same as ListScreen's current-climbs list (and
// just as flat — no date/cycle grouping). Tapping a climb opens its detail
// image (see onSelectClimb / App's viewingArchivedClimb), same as a
// current climb, but without the ability to log an ascent unless it's from
// the most recent archived cycle.
function ArchiveWallScreen({ wall, onSelectClimb }) {
  if (!wall) return null;

  return (
    <div style={styles.screen}>
      <p style={styles.listMeta}>{wall.climbs.length} climbs</p>
      <div style={{ ...styles.list, marginTop: 16, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {wall.climbs.map((climb) => (
          <button
            key={`${climb.name}-${climb.setDate}`}
            style={styles.climbRow}
            onClick={() => onSelectClimb(climb)}
          >
            <div style={styles.climbRowLeft}>
              <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
              <span style={styles.climbStars}>
                {(() => {
                  const filled = Math.round(climb.averageStars || 0);
                  return "⭐".repeat(filled) + "☆".repeat(5 - filled);
                })()}
              </span>
              <span style={styles.climbAscents}>{climb.ascentCount ?? 0} ascents</span>
            </div>
            <div style={styles.climbRowRight}>
              <span style={styles.climbTitle}>{climb.name}</span>
              <span style={styles.climbSetter}>{climb.setter}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlaceholderScreen({ title }) {
  return (
    <div style={styles.screen}>
      <p style={styles.placeholderText}>This screen is ready for content.</p>
    </div>
  );
}

// Search tab: a textbox up top, two mode buttons underneath ("Climbs" /
// "Users") to scope the query, and a live results list below that fills in
// as the user types. Climbs are filtered client-side against the same
// climbs list the Walls tab already has in memory; users are looked up via
// GET /api/users/search since the full user list isn't fetched up front.
function SearchScreen({
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
    if (!trimmedQuery) return [];
    const q = trimmedQuery.toLowerCase();
    return climbs.filter(
      (climb) =>
        climb.name.toLowerCase().includes(q) || (climb.setter || "").toLowerCase().includes(q)
    );
  }, [climbs, trimmedQuery]);

  useEffect(() => {
    if (mode !== "users" || !trimmedQuery) {
      onUserResultsChange([]);
      return;
    }

    let cancelled = false;
    fetch(`/api/users/search?q=${encodeURIComponent(trimmedQuery)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) onUserResultsChange(data.users || []);
      })
      .catch((err) => console.error("Failed to search users:", err));

    return () => {
      cancelled = true;
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
                    key={`${climb.wallId}::${climb.name}`}
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

// Read-only view of someone else's profile, opened by tapping a user in
// Search results. Same header layout as ProfileScreen's logged-in view
// (avatar, name, follower/following counts, grade pyramid) minus anything
// only the account owner should see or do (Settings, Logbook).
function UserProfileScreen({ user }) {
  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <div style={styles.screen}>
      <div style={styles.profileHeaderRow}>
        <div style={styles.profileLeft}>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" style={styles.avatarImage} />
          ) : (
            <div style={styles.avatar}>{initials}</div>
          )}
          <p style={styles.profileUsername}>{user.username}</p>
          {user.name && <p style={styles.profileDisplayName}>{user.name}</p>}
        </div>
        <div style={styles.profileRight}>
          <div style={styles.profileStatsRow}>
            <div style={styles.profileStat}>
              <span style={styles.profileStatNumber}>{user.followersCount ?? 0}</span>
              <span style={styles.profileStatLabel}>followers</span>
            </div>
            <div style={styles.profileStat}>
              <span style={styles.profileStatNumber}>{user.followingCount ?? 0}</span>
              <span style={styles.profileStatLabel}>following</span>
            </div>
          </div>
        </div>
      </div>
      <GradeBarChart
        title={`${user.username}'s ascents`}
        endpoint={`/api/users/${encodeURIComponent(user.username)}/grade-counts`}
      />
    </div>
  );
}

// Opened from the filter button on a wall's Climbs page. Not wired up to
// anything yet — just the page shell and placeholder fields for whatever
// a real climb filter ends up needing.
function ClimbsFilterForm() {
  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={(e) => e.preventDefault()}>
        <label style={styles.label}>
          Minimum grade
          <select style={styles.input} defaultValue="">
            <option value="">Any</option>
            {GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Maximum grade
          <select style={styles.input} defaultValue="">
            <option value="">Any</option>
            {GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Setter
          <input style={styles.input} type="text" placeholder="e.g. Alex" />
        </label>
        <button type="button" style={styles.button}>
          Apply filters
        </button>
      </form>
    </div>
  );
}

// A setter's rough grade guess at set time is a bottom/top pair (e.g.
// "V2" to "V4") — collapsed into the single string stored as a climb's
// setterGrade: just the grade itself when bottom and top match ("V6"), or
// "V2-4"/"V3-4" style when they don't. Mirrored server-side by
// climbBucketGrade in server/worker.js, which parses this same shape back
// apart for grade-pyramid bucketing.
function composeSetterGrade(bottom, top) {
  if (bottom === top) return bottom;
  return `${bottom}-${top.replace(/^V/, "")}`;
}

// Opened from the "+" button on a wall's Climbs page (moderators/setters
// only) — wallId/resetDate are fixed, no wall picker. Every climb saved
// here is stored server-side as a "backfill" (see POST /api/climbs) — the
// Backfill checkbox only decides which date it's dated: today's/the
// current reset's date, or a picked date in the past for logging a climb
// that's been up for a while already. Compare with NewWallForm below,
// opened from the Walls root list's "+" instead — similar fields, but for
// starting a wall's next "reset" rather than adding to its current set.
function NewClimbForm({ wallId, resetDate, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const [setters, setSetters] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [isBackfill, setIsBackfill] = useState(false);
  const [backfillDate, setBackfillDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetch("/api/users/setters")
      .then((res) => res.json())
      .then((data) => setSetters(data.setters || []))
      .catch((err) => console.error("Failed to load /api/users/setters:", err));
  }, []);

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setPhoto(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    if (!name.trim() || !setter.trim()) {
      setError("Climb name and setter are required.");
      return;
    }
    if (GRADE_OPTIONS.indexOf(gradeBottom) > GRADE_OPTIONS.indexOf(gradeTop)) {
      setError("Bottom grade must be the same as or easier than top grade.");
      return;
    }

    setError("");
    setSaving(true);
    const result = await onSave({
      wallId,
      name: name.trim(),
      setterGrade: composeSetterGrade(gradeBottom, gradeTop),
      setter: setter.trim(),
      setDate: isBackfill ? backfillDate : resetDate,
      photoUrl: photo,
    });
    setSaving(false);

    if (!result.success) {
      setError(result.error || "Something went wrong.");
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        {photo ? (
          <img src={photo} alt="" style={styles.avatarPreview} />
        ) : (
          <div style={styles.avatarPreviewPlaceholder}>
            <Camera size={28} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}
        <label style={styles.pickImageButton}>
          Choose photo
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
        </label>

        <label style={styles.label}>
          Climb name
          <input
            style={styles.input}
            type="text"
            placeholder="e.g. Golden Overhang"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Bottom grade
          <select style={styles.input} value={gradeBottom} onChange={(e) => setGradeBottom(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Top grade
          <select style={styles.input} value={gradeTop} onChange={(e) => setGradeTop(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Setter
          <select style={styles.input} value={setter} onChange={(e) => setSetter(e.target.value)}>
            <option value="">Select a setter</option>
            {setters.map((s) => (
              <option key={s.username} value={s.username}>
                {s.name ? `${s.name} (${s.username})` : s.username}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.checkboxRow}>
          <input
            style={styles.checkboxInput}
            type="checkbox"
            checked={isBackfill}
            onChange={(e) => setIsBackfill(e.target.checked)}
          />
          Backfill (pick a past date)
        </label>
        <label style={styles.label}>
          Date
          <input
            style={isBackfill ? styles.input : { ...styles.input, ...styles.inputDisabled }}
            type="date"
            value={isBackfill ? backfillDate : resetDate || ""}
            onChange={(e) => setBackfillDate(e.target.value)}
            disabled={!isBackfill}
          />
        </label>
        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

// Opened from the "+" button on the Walls root list (moderators/setters
// only), where no wall is selected yet — always shows a Wall dropdown.
// Unlike NewClimbForm, this always saves as setType "reset": adding a
// climb here starts (or adds to) a wall's next cycle, which — per
// currentClimbsOnly — supersedes every older climb on that wall as soon as
// it's saved, without anything needing to be deleted from climbs.json.
// There's no Backfill checkbox, since every save here already is the new
// current set; the Date field is plain and always editable (rather than
// locked/toggle-based like NewClimbForm's) so a setter adding several
// climbs to the same new set can give them all the same date and have them
// land in one cycle together.
function NewWallForm({ walls, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const [setters, setSetters] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedWallId, setSelectedWallId] = useState(walls?.[0]?.id ?? "");
  const [setDate, setSetDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetch("/api/users/setters")
      .then((res) => res.json())
      .then((data) => setSetters(data.setters || []))
      .catch((err) => console.error("Failed to load /api/users/setters:", err));
  }, []);

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setPhoto(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    if (!name.trim() || !setter.trim()) {
      setError("Climb name and setter are required.");
      return;
    }
    if (GRADE_OPTIONS.indexOf(gradeBottom) > GRADE_OPTIONS.indexOf(gradeTop)) {
      setError("Bottom grade must be the same as or easier than top grade.");
      return;
    }

    setError("");
    setSaving(true);
    const result = await onSave({
      wallId: selectedWallId,
      name: name.trim(),
      setterGrade: composeSetterGrade(gradeBottom, gradeTop),
      setter: setter.trim(),
      setDate,
      photoUrl: photo,
      setType: "reset",
    });
    setSaving(false);

    if (!result.success) {
      setError(result.error || "Something went wrong.");
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        {photo ? (
          <img src={photo} alt="" style={styles.avatarPreview} />
        ) : (
          <div style={styles.avatarPreviewPlaceholder}>
            <Camera size={28} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}
        <label style={styles.pickImageButton}>
          Choose photo
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
        </label>

        <label style={styles.label}>
          Wall
          <select
            style={styles.input}
            value={selectedWallId}
            onChange={(e) => setSelectedWallId(Number(e.target.value))}
          >
            {walls.map((wall) => (
              <option key={wall.id} value={wall.id}>
                {wall.name}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Climb name
          <input
            style={styles.input}
            type="text"
            placeholder="e.g. Golden Overhang"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Bottom grade
          <select style={styles.input} value={gradeBottom} onChange={(e) => setGradeBottom(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Top grade
          <select style={styles.input} value={gradeTop} onChange={(e) => setGradeTop(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Setter
          <select style={styles.input} value={setter} onChange={(e) => setSetter(e.target.value)}>
            <option value="">Select a setter</option>
            {setters.map((s) => (
              <option key={s.username} value={s.username}>
                {s.name ? `${s.name} (${s.username})` : s.username}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Date
          <input
            style={styles.input}
            type="date"
            value={setDate}
            onChange={(e) => setSetDate(e.target.value)}
          />
        </label>
        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

const GRADE_BUCKETS = ["VB", ...Array.from({ length: 10 }, (_, n) => `V${n}`), "V10+"];

// Client-side mirror of gradeToBucket in server/index.js, for charts built
// from climbs already in memory rather than from a counts endpoint.
function bucketGradeCounts(grades) {
  const counts = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));

  for (const raw of grades) {
    if (!raw) continue;
    const trimmed = raw.trim().toUpperCase();
    if (trimmed === "VB") {
      counts.VB += 1;
      continue;
    }
    const match = trimmed.match(/^V(\d+)$/);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    counts[n >= 10 ? "V10+" : `V${n}`] += 1;
  }

  return GRADE_BUCKETS.map((grade) => ({ grade, count: counts[grade] }));
}

// The grade to show/bucket for a climb: its confirmed grade if it has one,
// otherwise its setterGrade — bucketed by the top end of a range (e.g.
// "V2-4" reads as V4) since that's the harder, more conservative read of
// the setter's guess. Mirrors climbBucketGrade in server/worker.js.
function climbBucketGrade(climb) {
  if (climb.grade) return climb.grade;
  const setterGrade = climb.setterGrade || "";
  const dashIndex = setterGrade.indexOf("-");
  return dashIndex === -1 ? setterGrade : `V${setterGrade.slice(dashIndex + 1)}`;
}

// The grade text a climb row shows: confirmed grade if set, otherwise its
// setterGrade range/guess as-is (e.g. "V2-4", not collapsed to one end).
const climbDisplayGrade = (climb) => climb.grade || climb.setterGrade;

// The colored grade shown in a climb's title (see climbTitleNode below) —
// gray for a setter's still-unconfirmed guess, white once a setter/
// moderator has locked in the final grade (see the Approve tab).
function ClimbGradeLabel({ climb }) {
  const confirmed = Boolean(climb.grade);
  return (
    <span
      style={{ color: confirmed ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
    >
      {climbDisplayGrade(climb)}
    </span>
  );
}

// "V4 · Climb Name" title shown atop the Climb detail page's image, for
// both current and archived climbs — the grade colored per ClimbGradeLabel.
function climbTitleNode(climb) {
  return (
    <>
      <ClimbGradeLabel climb={climb} />
      {` · ${climb.name}`}
    </>
  );
}

// A grade pyramid — how many things fall in each V-grade bucket (VB,
// V0-V9, V10+). Takes either pre-computed `counts` (when the data is
// already in memory, e.g. a wall's climbs) or an `endpoint` to fetch them
// from. The Home tab points this at GET /api/climbs/grade-counts
// (currently active climbs); the Profile tab points it at
// GET /api/users/:username/grade-counts (that user's logged ascents,
// preferring the grade typed on the ascent and falling back to the
// climb's own bucket grade when that was left blank).
function GradeBarChart({ title, endpoint, counts: providedCounts }) {
  const [fetchedCounts, setFetchedCounts] = useState(null);

  useEffect(() => {
    if (!endpoint) return;
    setFetchedCounts(null);
    fetch(endpoint)
      .then((res) => res.json())
      .then((data) => setFetchedCounts(data.counts || []))
      .catch((err) => console.error(`Failed to load ${endpoint}:`, err));
  }, [endpoint]);

  const counts = providedCounts ?? fetchedCounts;
  if (!counts) return null;

  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const trackHeight = 80;
  // Same 4 fractions the gridlines in gradeBarTrack are drawn at (100%
  // down to 25%), plus the 0 baseline — rounded so the axis always shows
  // whole ascents, never fractional counts.
  // Rounding to integers can collapse neighboring fractions to the same
  // whole number when maxCount is small (e.g. 1, 1, 1, 0, 0) — blank out
  // repeats so the axis never shows the same value twice in a row.
  let lastTick = null;
  const axisTicks = [1, 0.75, 0.5, 0.25, 0].map((frac) => {
    const value = Math.round(maxCount * frac);
    if (value === lastTick) return null;
    lastTick = value;
    return value;
  });
  // The 0 baseline is implied by the bars starting from the bottom, so
  // don't print it on the axis.
  axisTicks[axisTicks.length - 1] = null;

  return (
    <div style={styles.gradeChartWrapper}>
      {title && <p style={styles.gradeChartTitle}>{title}</p>}
      <div style={styles.gradeChart}>
        <div style={styles.gradeAxisColumn}>
          <span style={styles.gradeAxisSpacer} />
          <div style={styles.gradeAxisTrack}>
            {axisTicks.map((tick, i) => (
              <span key={i} style={styles.gradeAxisLabel}>
                {tick === null ? "" : tick}
              </span>
            ))}
          </div>
          <span style={styles.gradeAxisSpacer} />
        </div>
        <div style={styles.gradeBarsRow}>
          {/* Drawn once behind every column, rather than once per column,
              so the lines are continuous instead of broken up by the gaps
              between bars. */}
          <div style={styles.gradeGridlines} />
          {counts.map(({ grade, count }) => (
            <div key={grade} style={styles.gradeBarColumn}>
              <span style={styles.gradeBarCount}>{count > 0 ? count : ""}</span>
              <div style={styles.gradeBarTrack}>
                <div
                  style={{
                    ...styles.gradeBar,
                    height: count > 0 ? Math.max(3, (count / maxCount) * trackHeight) : 0,
                  }}
                />
              </div>
              <span style={styles.gradeBarLabel}>{grade === "V10+" ? "10+" : grade}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProfileScreen({
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
              <img src={currentUser.avatarUrl} alt="" style={styles.avatarImage} />
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
        {error && <p style={styles.formError}>{error}</p>}
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

const SETTINGS_OPTIONS = [
  { id: "avatar", label: "Change profile picture" },
  { id: "username", label: "Change username" },
  { id: "name", label: "Change name" },
  { id: "password", label: "Change password" },
];

function SettingsScreen({ onSelectOption, onLogout }) {
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

function ChangeAvatarForm({ currentUser, onSave }) {
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

        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

function ChangeUsernameForm({ currentUser, onSave }) {
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
        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

function ChangeNameForm({ currentUser, onSave }) {
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
        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

function ChangePasswordForm({ onSave, requireCurrentPassword = true, helperText }) {
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
        {error && <p style={styles.formError}>{error}</p>}
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "moderator", label: "Moderator" },
  { value: "setter", label: "Setter" },
  { value: "admin", label: "Admin" },
];

// Moderator and setter are peers (same permission level, different label);
// admin implies both, so it's checked first.
function roleOf(user) {
  if (user.isAdmin) return "admin";
  if (user.isModerator) return "moderator";
  if (user.isSetter) return "setter";
  return "member";
}

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
function ManageRolesScreen() {
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

  useEffect(() => {
    fetch("/api/users")
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(data.error || "Couldn't load users.");
          return;
        }
        setUsers(data.users);
        setPendingRoles(Object.fromEntries(data.users.map((u) => [u.username, roleOf(u)])));
      })
      .catch((err) => {
        console.error("Failed to load /api/users:", err);
        setError("Couldn't reach the server. Is it running?");
      });
  }, []);

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
    try {
      const results = await Promise.all(
        changedUsernames.map((username) =>
          fetch(`/api/users/${encodeURIComponent(username)}/role`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: pendingRoles[username] }),
          }).then((res) => res.json().then((data) => ({ ok: res.ok, data, username })))
        )
      );

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      if (succeeded.length) {
        setUsers((prev) =>
          prev.map((u) => succeeded.find((r) => r.username === u.username)?.data.user ?? u)
        );
      }

      if (failed.length) {
        const names = failed.map((f) => f.data.error || f.username).join(", ");
        setError(`Couldn't save ${failed.length} role${failed.length === 1 ? "" : "s"}: ${names}`);
      } else {
        setSuccessMessage(`Saved ${succeeded.length} role change${succeeded.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      console.error("Failed to save roles:", err);
      setError("Couldn't reach the server. Is it running?");
    } finally {
      setSavingAll(false);
    }
  };

  const handleResetPassword = async (username) => {
    setResettingUsername(username);
    setError("");
    setSuccessMessage("");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}/reset-password`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't reset that password.");
        return;
      }
      setSuccessMessage(`${username}'s password was reset — they'll be prompted to set a new one at next login.`);
    } catch (err) {
      console.error("Failed to reset password:", err);
      setError("Couldn't reach the server. Is it running?");
    } finally {
      setResettingUsername(null);
    }
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

      {error && <p style={styles.formError}>{error}</p>}
      {successMessage && <p style={styles.formSuccess}>{successMessage}</p>}
      {users === null && !error && <p style={styles.placeholderText}>Loading…</p>}
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

// Opened from the Approve tab (moderators/setters only). Lists every climb
// that's been superseded by a newer reset on its wall (see currentClimbsOnly
// server-side) but doesn't have a confirmed grade yet — i.e. exactly the
// climbs a setter/moderator is now allowed to lock in a final grade for,
// per the gate on POST /api/climbs/grade. Picking a grade and tapping the
// checkmark confirms it and drops the row from this list.
function ApproveClimbsScreen() {
  const [climbs, setClimbs] = useState(null);
  const [error, setError] = useState("");
  const [gradeByKey, setGradeByKey] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    fetch("/api/climbs/needs-grade")
      .then((res) => res.json())
      .then((data) => setClimbs(data.climbs || []))
      .catch((err) => {
        console.error("Failed to load /api/climbs/needs-grade:", err);
        setError("Couldn't reach the server. Is it running?");
      });
  }, []);

  const handleConfirmGrade = async (climb, key, grade) => {
    setSavingKey(key);
    setError("");
    try {
      const res = await fetch("/api/climbs/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallId: climb.wallId, name: climb.name, grade }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't set that grade.");
        return;
      }
      setClimbs((prev) => prev.filter((c) => c.wallId !== climb.wallId || c.name !== climb.name));
    } catch (err) {
      console.error("Failed to set grade:", err);
      setError("Couldn't reach the server. Is it running?");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div style={styles.screen}>
      {error && <p style={styles.formError}>{error}</p>}
      {climbs === null && !error && <p style={styles.placeholderText}>Loading…</p>}
      {climbs !== null && climbs.length === 0 && (
        <p style={styles.placeholderText}>No climbs waiting on a final grade.</p>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {(climbs || []).map((climb) => {
          const key = `${climb.wallId}::${climb.name}`;
          // A reasonable starting point for the dropdown: the bottom end of
          // the setter's original guess (e.g. "V2" out of "V2-4").
          const grade = gradeByKey[key] ?? climb.setterGrade.split("-")[0];

          return (
            <div key={key} style={styles.climbRow}>
              <div style={styles.climbRowLeft}>
                <span style={styles.climbTitle}>{climb.name}</span>
                <span style={styles.climbSetter}>
                  {WALL_NAME_BY_ID[climb.wallId] ?? `Wall ${climb.wallId}`} · Set by {climb.setter}
                </span>
                <span style={styles.climbSetter}>Setter guess: {climb.setterGrade}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <select
                  style={{ ...styles.input, width: "auto" }}
                  value={grade}
                  disabled={savingKey === key}
                  onChange={(e) =>
                    setGradeByKey((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                >
                  {GRADE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingKey === key}
                  aria-label={`Confirm grade for ${climb.name}`}
                  onClick={() => handleConfirmGrade(climb, key, grade)}
                >
                  <Check size={20} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopBar({
  title,
  showBack,
  onBack,
  showCommentsButton,
  onShowComments,
  showAddButton,
  onAdd,
}) {
  return (
    <header style={styles.topBar}>
      {showBack ? (
        <button style={styles.topBarBackButton} onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
      ) : (
        <div style={styles.topBarSpacer} />
      )}
      <h1 style={styles.topBarTitle}>{title}</h1>
      {showCommentsButton ? (
        <button style={styles.topBarBackButton} onClick={onShowComments}>
          <Info size={20} />
        </button>
      ) : showAddButton ? (
        <button style={styles.topBarBackButton} onClick={onAdd}>
          <Plus size={20} />
        </button>
      ) : (
        <div style={styles.topBarSpacer} />
      )}
    </header>
  );
}

// Replaces the persistent tab bar while viewing a Climb detail page: an
// attempts counter (with -/+ buttons on either side) above a center button
// to log an ascent. Logging isn't wired up to anything yet.
function ClimbActionBar({ attempts, onDecrement, onIncrement, onLogAscent, disabled }) {
  return (
    <nav style={styles.climbActionBar}>
      <button
        style={{
          ...styles.climbActionSideButton,
          ...(disabled ? styles.climbActionSideButtonDisabled : {}),
        }}
        onClick={disabled ? undefined : onDecrement}
        disabled={disabled}
      >
        <Minus size={22} />
      </button>
      <div style={styles.climbActionCenter}>
        <span
          style={{ ...styles.attemptsCounter, ...(disabled ? styles.attemptsCounterDisabled : {}) }}
        >
          {attempts}
        </span>
        <button
          style={{ ...styles.logAscentButton, ...(disabled ? styles.logAscentButtonDisabled : {}) }}
          onClick={disabled ? undefined : onLogAscent}
          disabled={disabled}
        >
          Log ascent
        </button>
      </div>
      <button
        style={{
          ...styles.climbActionSideButton,
          ...(disabled ? styles.climbActionSideButtonDisabled : {}),
        }}
        onClick={disabled ? undefined : onIncrement}
        disabled={disabled}
      >
        <Plus size={22} />
      </button>
    </nav>
  );
}

function StarRatingInput({ value, onChange, invalid }) {
  // A precise left-half/right-half tap on a 26px star is too fiddly with a
  // finger, so instead the whole row is a drag surface: press or drag
  // anywhere across it and the rating (in 0.5 steps) tracks the pointer's
  // x position, the way most mobile star pickers work.
  const rowRef = useRef(null);
  const isDragging = useRef(false);

  const valueFromPointer = (clientX) => {
    const el = rowRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(5, Math.max(0, Math.round(ratio * 5 * 2) / 2));
  };

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    onChange(valueFromPointer(e.clientX));
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    onChange(valueFromPointer(e.clientX));
  };

  const stopDragging = () => {
    isDragging.current = false;
  };

  return (
    <div
      ref={rowRef}
      style={{ ...styles.starRow, ...(invalid ? styles.starRowInvalid : {}) }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const isFull = value >= n;
        const isHalf = !isFull && value >= n - 0.5;
        const StarIconComponent = isHalf ? StarHalf : Star;

        return (
          <StarIconComponent
            key={n}
            size={30}
            color={isFull || isHalf ? "var(--color-star)" : "var(--color-text-disabled)"}
            fill={isFull || isHalf ? "var(--color-star)" : "none"}
            strokeWidth={1.5}
          />
        );
      })}
    </div>
  );
}

// Full-width bottom sheet for logging an ascent. Slides up from behind the
// climb action bar. Attempts (total and this session) are always included
// in what gets saved, via POST /api/ascents (see App's handleSubmitAscent).
const GRADE_OPTIONS = ["VB", ...Array.from({ length: 12 }, (_, n) => `V${n}`)];

// Up to 5 ascentClaims live on the climb itself (see server/index.js), one
// slot per ordinal. Whoever logs an ascent while a slot is still open gets
// offered it — a name to credit (defaults to blank, e.g. crediting someone
// else) or a "Pass" to leave it unclaimed. Filling in neither during a
// given ascent just leaves that slot open for the next person to log one.
const ASCENT_ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];

function LogAscentSheet({
  open,
  attemptsThisSession,
  currentGrade,
  ascentClaims,
  onClose,
  onSubmit,
}) {
  const [starRating, setStarRating] = useState(0);
  const [attempts, setAttempts] = useState(attemptsThisSession);
  const [grade, setGrade] = useState(currentGrade || "VB");
  const [comment, setComment] = useState("");
  const [showValidation, setShowValidation] = useState(false);
  const [ascentClaimName, setAscentClaimName] = useState("");
  const [ascentClaimPass, setAscentClaimPass] = useState(false);

  useEffect(() => {
    if (open) {
      setStarRating(0);
      setAttempts(attemptsThisSession);
      setGrade(currentGrade || "VB");
      setComment("");
      setShowValidation(false);
      setAscentClaimName("");
      setAscentClaimPass(false);
    }
  }, [open, attemptsThisSession, currentGrade]);

  const claimedCount = ascentClaims?.length ?? 0;
  const showAscentClaim = claimedCount < 5;

  const attemptsValue = Number(attempts) || 0;
  const ratingInvalid = showValidation && starRating < 0.5;
  const attemptsInvalid = showValidation && attemptsValue < 1;

  const handleSubmit = (e) => {
    e.preventDefault();

    if (starRating < 0.5 || attemptsValue < 1) {
      setShowValidation(true);
      return;
    }

    setShowValidation(false);
    onSubmit({
      starRating,
      grade,
      comment,
      logAttempts: true,
      attempts: attemptsValue,
      attemptsThisSession,
      ascentClaim:
        showAscentClaim && (ascentClaimName.trim() || ascentClaimPass)
          ? { name: ascentClaimName.trim(), pass: ascentClaimPass }
          : null,
    });
  };

  return (
    <>
      <div
        style={{
          ...styles.sheetBackdrop,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
        onClick={onClose}
      />
      <div
        style={{
          ...styles.sheet,
          transform: open ? "translateY(0)" : "translateY(100%)",
        }}
      >
        <div style={styles.sheetHandle} />
        <form style={styles.sheetForm} onSubmit={handleSubmit} noValidate>
          <label style={styles.label}>
            Rating
            <StarRatingInput value={starRating} onChange={setStarRating} invalid={ratingInvalid} />
          </label>

          <label style={styles.label}>
            Grade
            <select
              style={styles.input}
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
            >
              {GRADE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.label}>
            Comment
            <textarea
              style={styles.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </label>

          <label style={styles.label}>
            Attempts
            <input
              style={{ ...styles.input, ...(attemptsInvalid ? styles.inputInvalid : {}) }}
              type="number"
              min={1}
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
            />
          </label>

          {showAscentClaim && (
            <>
              <label style={styles.label}>
                {ASCENT_ORDINALS[claimedCount]} ascent
                <input
                  style={
                    ascentClaimPass ? { ...styles.input, ...styles.inputDisabled } : styles.input
                  }
                  type="text"
                  placeholder="name"
                  value={ascentClaimName}
                  disabled={ascentClaimPass}
                  onChange={(e) => setAscentClaimName(e.target.value)}
                />
              </label>
              <label style={styles.checkboxRow}>
                <input
                  style={styles.checkboxInput}
                  type="checkbox"
                  checked={ascentClaimPass}
                  onChange={(e) => setAscentClaimPass(e.target.checked)}
                />
                Pass
              </label>
            </>
          )}

          <button type="submit" style={styles.button}>
            Save ascent
          </button>
        </form>
      </div>
    </>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("home");
  const [selectedListItem, setSelectedListItem] = useState(null);
  const [selectedSubItem, setSelectedSubItem] = useState(null);
  const [showComments, setShowComments] = useState(false);
  const [viewingArchivedClimb, setViewingArchivedClimb] = useState(null);
  // Lifted out of ArchiveSection so it survives that component unmounting
  // (tab switches, drilling into a wall/climb and back) instead of
  // resetting. viewingArchiveWallId is which wall's archived-climbs page
  // (ArchiveWallScreen) is currently open, if any.
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [archiveWalls, setArchiveWalls] = useState(null);
  const [viewingArchiveWallId, setViewingArchiveWallId] = useState(null);
  // Moderator-only "add" flow from the Climbs page — not wired up to
  // anything yet, just the page shell and a placeholder form.
  const [creatingClimb, setCreatingClimb] = useState(false);
  // "Filter" flow from the Climbs page — not wired up to anything yet,
  // just the page shell and a placeholder form.
  const [filteringClimbs, setFilteringClimbs] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [showLogAscentSheet, setShowLogAscentSheet] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOption, setSettingsOption] = useState(null);
  // The user (search-result shape: username/name/avatarUrl/counts) whose
  // read-only profile is currently open, if any — set by tapping a user in
  // the Search tab's results (see UserProfileScreen).
  const [viewingSearchUser, setViewingSearchUser] = useState(null);
  // Search tab's query/mode/results, lifted out of SearchScreen so they
  // survive that component unmounting — e.g. opening a user's profile from
  // a result and hitting back — instead of resetting, same reasoning as
  // ArchiveSection's lifted state above.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState("climbs");
  const [searchUserResults, setSearchUserResults] = useState([]);

  // --- Climbs data -----------------------------------------------------
  // Fetched from the server (server/climbs.json via GET /api/climbs), which
  // only returns each wall's *current* climbs (its most recent reset plus
  // any backfills on top of it — see currentClimbsOnly in server/index.js)
  // and merges in ascent-derived stats and user comments. Climbs have no
  // id of their own, so climbsByWall groups them by wallId, and a climb is
  // looked up within that group by its (wall-unique) name. Re-fetched after
  // logging an ascent so a newly-added comment shows up immediately (see
  // handleSubmitAscent below).
  const [climbs, setClimbs] = useState([]);

  const fetchClimbs = () =>
    fetch("/api/climbs")
      .then((res) => res.json())
      .then((data) => setClimbs(data.climbs || []))
      .catch((err) => console.error("Failed to load /api/climbs:", err));

  useEffect(() => {
    fetchClimbs();
  }, []);

  const climbsByWall = useMemo(() => {
    const map = {};
    climbs.forEach((climb) => {
      if (!map[climb.wallId]) map[climb.wallId] = [];
      map[climb.wallId].push(climb);
    });
    return map;
  }, [climbs]);

  const selectedClimb =
    selectedListItem && selectedSubItem
      ? (climbsByWall[selectedListItem.id] || []).find((c) => c.name === selectedSubItem)
      : null;

  // Whichever climb the Climb-detail UI (image, comments, action bar) is
  // currently showing — a normal current climb, or one opened from the
  // Archive. Both use the exact same detail UI; only the action bar
  // (attempts/log-ascent) is disabled for an archived climb.
  const activeClimb = viewingArchivedClimb || selectedClimb;

  // --- Persisted session ---------------------------------------------------
  // The user *database* now lives on the server, in server/users.json — see
  // handleSignup/handleLogin below. We still keep the logged-in session
  // client-side in localStorage so a refresh doesn't log you out.
  const [currentUser, setCurrentUser] = useState(() =>
    loadFromStorage(STORAGE_KEYS.currentUser, null)
  );

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.currentUser, currentUser);
  }, [currentUser]);

  const callAuthApi = async (endpoint, credentials) => {
    try {
      const res = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error || "Something went wrong." };
      }

      setCurrentUser(data.user);
      return { success: true, needsPasswordReset: !!data.needsPasswordReset };
    } catch (err) {
      console.error(`Failed to reach /api/${endpoint}:`, err);
      return {
        success: false,
        error: "Couldn't reach the server. Is it running?",
      };
    }
  };

  const handleSignup = (credentials) => callAuthApi("signup", credentials);
  const handleLogin = (credentials) => callAuthApi("login", credentials);
  const handleLogout = () => {
    setCurrentUser(null);
    // Best-effort: invalidates the session token server-side too, so the
    // old cookie (if it somehow survived) can't be replayed. The client is
    // logged out either way, even if this fails.
    fetch("/api/logout", { method: "POST" }).catch((err) =>
      console.error("Failed to reach /api/logout:", err)
    );
  };

  const handleOpenSettings = () => {
    setSettingsOption(null);
    setShowSettings(true);
  };

  // TODO: wire this up once there's an actual logbook screen to open.
  const handleOpenLogbook = () => {};

  // Shared by the three Settings forms: POST to a /api/users/:username/...
  // route, and on success replace currentUser with the fresh copy the
  // server sends back (it stays in sync with localStorage via the effect
  // above) and pop back to the Settings list.
  const callSettingsApi = async (path, body) => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(currentUser.username)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error || "Something went wrong." };
      }

      if (data.user) setCurrentUser(data.user);
      setSettingsOption(null);
      return { success: true };
    } catch (err) {
      console.error(`Failed to reach /api/users/.../${path}:`, err);
      return { success: false, error: "Couldn't reach the server. Is it running?" };
    }
  };

  // Used by NewClimbForm's Save button (see the "+" flow on a wall's Climbs
  // page). On success, refetches the wall's climbs so the new one shows up
  // immediately and pops back out of the creation form.
  const handleCreateClimb = async (fields) => {
    try {
      const res = await fetch("/api/climbs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error || "Something went wrong." };
      }

      await fetchClimbs();
      setCreatingClimb(false);
      return { success: true };
    } catch (err) {
      console.error("Failed to create climb:", err);
      return { success: false, error: "Couldn't reach the server. Is it running?" };
    }
  };

  const handleUpdateAvatar = (avatarUrl) => callSettingsApi("/avatar", { avatarUrl });
  const handleUpdateUsername = (newUsername) => callSettingsApi("/username", { newUsername });
  const handleUpdateName = (name) => callSettingsApi("/name", { name });
  const handleUpdatePassword = ({ currentPassword, newPassword }) =>
    callSettingsApi("/password", { currentPassword, newPassword });

  const handleSelectListItem = (item) => {
    setSelectedListItem(item);
    setSelectedSubItem(null);
    setShowComments(false);
    setCreatingClimb(false);
    setFilteringClimbs(false);
  };

  // Tapping a climb in Search results: jump straight to the Walls tab's
  // climb-detail view for it, same destination as drilling in from the
  // wall's own Climbs list — so it needs the same state reset that
  // handleSelectListItem + handleSelectSubItem do together.
  const handleSelectSearchClimb = (climb) => {
    setActiveTab("list");
    setSelectedListItem({ id: climb.wallId, title: WALL_NAME_BY_ID[climb.wallId] ?? "" });
    setSelectedSubItem(climb.name);
    setShowComments(false);
    setCreatingClimb(false);
    setFilteringClimbs(false);
    setViewingArchivedClimb(null);
    setViewingArchiveWallId(null);
    setAttempts(0);
    setShowLogAscentSheet(false);
  };

  const handleSelectSearchUser = (user) => setViewingSearchUser(user);

  const handleViewArchivedClimb = (climb) => {
    setViewingArchivedClimb(climb);
    setShowComments(false);
    setAttempts(0);
    setShowLogAscentSheet(false);
  };

  const handleToggleArchive = () => {
    const next = !archiveExpanded;
    setArchiveExpanded(next);
    if (next && archiveWalls === null) {
      fetch("/api/archive")
        .then((res) => res.json())
        .then((data) => setArchiveWalls(data.walls || []))
        .catch((err) => console.error("Failed to load /api/archive:", err));
    }
  };

  // Tapping the Walls tab while already on it pops all the way back to the
  // top-level Walls list, same as re-tapping the current tab in most apps.
  const handleTabPress = (tabId) => {
    if (tabId === activeTab && tabId === "list") {
      setSelectedListItem(null);
      setSelectedSubItem(null);
      setShowComments(false);
      setShowLogAscentSheet(false);
      setViewingArchivedClimb(null);
      setViewingArchiveWallId(null);
      setCreatingClimb(false);
      setFilteringClimbs(false);
      return;
    }
    if (tabId === activeTab && tabId === "profile") {
      setShowSettings(false);
      setSettingsOption(null);
      return;
    }
    if (tabId === activeTab && tabId === "search") {
      setViewingSearchUser(null);
      return;
    }
    setActiveTab(tabId);
  };

  const handleSelectSubItem = (climbName) => {
    setSelectedSubItem(climbName);
    setShowComments(false);
    setAttempts(0);
    setShowLogAscentSheet(false);
  };

  const handleDecrementAttempts = () => setAttempts((n) => Math.max(0, n - 1));
  const handleIncrementAttempts = () => setAttempts((n) => n + 1);
  const handleLogAscent = () => setShowLogAscentSheet(true);

  const handleSubmitAscent = async (fields) => {
    setShowLogAscentSheet(false);

    // Most archived climbs are view-only — the Log Ascent button is
    // disabled for them (see isClimbActionDisabled below), so this
    // shouldn't be reachable, but guard against it as defense in depth.
    // The most recent archived reset+backfill per wall stays loggable
    // (climb.loggable, set by GET /api/archive), same as a current climb.
    const isDisabledArchivedClimb = viewingArchivedClimb && !viewingArchivedClimb.loggable;
    if (!currentUser || !activeClimb || isDisabledArchivedClimb) return;

    try {
      await fetch("/api/ascents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallId: activeClimb.wallId,
          climbName: activeClimb.name,
          ...fields,
        }),
      });
      await fetchClimbs();
    } catch (err) {
      console.error("Failed to save ascent:", err);
    }
  };

  const handleDeleteComment = async (ascentId) => {
    if (!currentUser) return;

    try {
      await fetch(`/api/users/${encodeURIComponent(currentUser.username)}/ascents/${ascentId}/comment`, {
        method: "DELETE",
      });
      await fetchClimbs();
    } catch (err) {
      console.error("Failed to delete comment:", err);
    }
  };

  const content = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeScreen />;
      case "list": {
        if (creatingClimb) {
          if (selectedListItem) {
            // The reset date for the wall being added to — every current
            // climb on that wall shares the same setDate for its "reset"
            // entry, so the first one found is enough.
            const wallClimbs = climbsByWall[selectedListItem.id] || [];
            const resetDate =
              wallClimbs.find((c) => c.setType === "reset")?.setDate ??
              wallClimbs[0]?.setDate ??
              "";
            return (
              <NewClimbForm
                wallId={selectedListItem.id}
                resetDate={resetDate}
                onSave={handleCreateClimb}
              />
            );
          }
          // Opened from the "+" on the Walls root list: no wall selected
          // yet, and this always starts a new "reset" cycle rather than
          // adding to whatever's current — see NewWallForm.
          return <NewWallForm walls={WALLS} onSave={handleCreateClimb} />;
        }
        if (filteringClimbs) {
          return <ClimbsFilterForm />;
        }
        if (activeClimb && showComments) {
          return (
            <CommentsScreen
              climb={activeClimb}
              currentUser={currentUser}
              onDeleteComment={handleDeleteComment}
            />
          );
        }
        if (viewingArchivedClimb) {
          const title = climbTitleNode(viewingArchivedClimb);
          const subtitle = `Set by ${viewingArchivedClimb.setter}`;
          return (
            <ZoomableImageViewer
              title={title}
              subtitle={subtitle}
              photoUrl={viewingArchivedClimb.photoUrl}
            />
          );
        }
        if (viewingArchiveWallId) {
          const wall = (archiveWalls || []).find((w) => w.wallId === viewingArchiveWallId);
          return <ArchiveWallScreen wall={wall} onSelectClimb={handleViewArchivedClimb} />;
        }
        return (
          <ListScreen
            selectedItem={selectedListItem}
            selectedSubItem={selectedSubItem}
            climbsByWall={climbsByWall}
            onSelectItem={handleSelectListItem}
            onSelectSubItem={handleSelectSubItem}
            archiveExpanded={archiveExpanded}
            archiveWalls={archiveWalls}
            onToggleArchive={handleToggleArchive}
            onSelectArchiveWall={setViewingArchiveWallId}
            onOpenFilter={() => setFilteringClimbs(true)}
          />
        );
      }
      case "search":
        if (viewingSearchUser) {
          return <UserProfileScreen user={viewingSearchUser} />;
        }
        return (
          <SearchScreen
            climbs={climbs}
            query={searchQuery}
            mode={searchMode}
            userResults={searchUserResults}
            onQueryChange={setSearchQuery}
            onModeChange={setSearchMode}
            onUserResultsChange={setSearchUserResults}
            onSelectClimb={handleSelectSearchClimb}
            onSelectUser={handleSelectSearchUser}
          />
        );
      case "profile": {
        if (currentUser && showSettings) {
          if (settingsOption === "avatar") {
            return <ChangeAvatarForm currentUser={currentUser} onSave={handleUpdateAvatar} />;
          }
          if (settingsOption === "username") {
            return <ChangeUsernameForm currentUser={currentUser} onSave={handleUpdateUsername} />;
          }
          if (settingsOption === "name") {
            return <ChangeNameForm currentUser={currentUser} onSave={handleUpdateName} />;
          }
          if (settingsOption === "password") {
            return <ChangePasswordForm onSave={handleUpdatePassword} />;
          }
          return <SettingsScreen onSelectOption={setSettingsOption} onLogout={handleLogout} />;
        }
        return (
          <ProfileScreen
            currentUser={currentUser}
            onSignup={handleSignup}
            onLogin={handleLogin}
            onOpenSettings={handleOpenSettings}
            onOpenLogbook={handleOpenLogbook}
            onSetPassword={handleUpdatePassword}
          />
        );
      }
      case "admin":
        return currentUser?.isAdmin ? <ManageRolesScreen /> : null;
      case "approve":
        return currentUser?.isModerator || currentUser?.isSetter ? <ApproveClimbsScreen /> : null;
      default:
        return null;
    }
  }, [
    activeTab,
    currentUser,
    selectedListItem,
    selectedSubItem,
    climbsByWall,
    showComments,
    showSettings,
    settingsOption,
    viewingArchivedClimb,
    archiveExpanded,
    archiveWalls,
    viewingArchiveWallId,
    creatingClimb,
    filteringClimbs,
    climbs,
    viewingSearchUser,
    searchQuery,
    searchMode,
    searchUserResults,
  ]);

  // Approve and Admin only show up in the tab bar (and their titles only
  // resolve) for accounts with the matching role — see APPROVE_TAB/ADMIN_TAB.
  const visibleTabs = [
    ...TABS,
    ...(currentUser?.isModerator || currentUser?.isSetter ? [APPROVE_TAB] : []),
    ...(currentUser?.isAdmin ? [ADMIN_TAB] : []),
  ];
  const tabTitle = visibleTabs.find((tab) => tab.id === activeTab)?.label ?? "";
  let topBarTitle = tabTitle;
  let showBack = false;
  let handleBack = () => {};

  if (activeTab === "list" && creatingClimb) {
    topBarTitle = selectedListItem ? "New Climb" : "New Wall";
    showBack = true;
    handleBack = () => setCreatingClimb(false);
  } else if (activeTab === "list" && filteringClimbs) {
    topBarTitle = "Filter";
    showBack = true;
    handleBack = () => setFilteringClimbs(false);
  } else if (activeTab === "list" && activeClimb && showComments) {
    topBarTitle = "Comments";
    showBack = true;
    handleBack = () => setShowComments(false);
  } else if (activeTab === "list" && viewingArchivedClimb) {
    topBarTitle = "Climb";
    showBack = true;
    handleBack = () => setViewingArchivedClimb(null);
  } else if (activeTab === "list" && viewingArchiveWallId) {
    topBarTitle = WALL_NAME_BY_ID[viewingArchiveWallId] ?? "Archive";
    showBack = true;
    handleBack = () => setViewingArchiveWallId(null);
  } else if (activeTab === "list" && selectedListItem && selectedSubItem) {
    topBarTitle = "Climb";
    showBack = true;
    handleBack = () => setSelectedSubItem(null);
  } else if (activeTab === "list" && selectedListItem) {
    topBarTitle = selectedListItem.title;
    showBack = true;
    handleBack = () => setSelectedListItem(null);
  } else if (activeTab === "search" && viewingSearchUser) {
    topBarTitle = viewingSearchUser.username;
    showBack = true;
    handleBack = () => setViewingSearchUser(null);
  } else if (activeTab === "profile" && showSettings && settingsOption) {
    topBarTitle = SETTINGS_OPTIONS.find((o) => o.id === settingsOption)?.label ?? "Settings";
    showBack = true;
    handleBack = () => setSettingsOption(null);
  } else if (activeTab === "profile" && showSettings) {
    topBarTitle = "Settings";
    showBack = true;
    handleBack = () => setShowSettings(false);
  }

  const showCommentsButton = activeTab === "list" && Boolean(activeClimb) && !showComments;

  const isClimbDetail = activeTab === "list" && Boolean(activeClimb) && !showComments;

  // Root of the Walls tab: no wall/climb drilled into, not inside the
  // Archive's own climb page. Only moderators/setters get the add button
  // here — it opens NewWallForm (a Wall dropdown, and always a new
  // "reset" cycle) rather than NewClimbForm.
  const isWallsRoot =
    activeTab === "list" &&
    !selectedListItem &&
    !viewingArchivedClimb &&
    !viewingArchiveWallId;
  // A wall's Climbs list (selectedListItem set, no climb drilled into yet).
  const isClimbsList =
    activeTab === "list" &&
    Boolean(selectedListItem) &&
    !selectedSubItem &&
    !creatingClimb &&
    !filteringClimbs;
  const showAddButton =
    (isWallsRoot || isClimbsList) && Boolean(currentUser?.isModerator || currentUser?.isSetter);

  return (
    <div style={styles.app}>
      <TopBar
        title={topBarTitle}
        showBack={showBack}
        onBack={handleBack}
        showCommentsButton={showCommentsButton}
        onShowComments={() => setShowComments(true)}
        showAddButton={showAddButton}
        onAdd={() => {
          if (isClimbsList || isWallsRoot) setCreatingClimb(true);
        }}
      />
      <div style={styles.content}>{content}</div>

      {isClimbDetail ? (
        <ClimbActionBar
          attempts={attempts}
          onDecrement={handleDecrementAttempts}
          onIncrement={handleIncrementAttempts}
          onLogAscent={handleLogAscent}
          disabled={Boolean(viewingArchivedClimb) && !viewingArchivedClimb.loggable}
        />
      ) : (
        <nav style={styles.tabBar}>
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabPress(tab.id)}
                style={{
                  ...styles.tabButton,
                  color: isActive ? "var(--color-accent-bright)" : "var(--color-text-inactive)",
                }}
              >
                <Icon size={22} strokeWidth={isActive ? 2.25 : 1.75} />
                <span
                  style={{
                    ...styles.tabLabel,
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {isClimbDetail && (
        <LogAscentSheet
          open={showLogAscentSheet}
          attemptsThisSession={attempts}
          currentGrade={activeClimb?.grade}
          ascentClaims={activeClimb?.ascentClaims}
          onClose={() => setShowLogAscentSheet(false)}
          onSubmit={handleSubmitAscent}
        />
      )}
    </div>
  );
}

const styles = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    maxHeight: "100dvh",
    maxWidth: 420,
    margin: "0 auto",
    background: "var(--color-bg)",
    position: "relative",
    overflow: "hidden",
  },
  content: {
    flex: 1,
    overflowY: "auto",
    paddingBottom: "calc(72px + env(safe-area-inset-bottom))",
  },
  screen: {
    padding: "20px 20px 20px",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "calc(16px + env(safe-area-inset-top)) 12px 16px",
    background: "var(--color-surface-4)",
    borderBottom: "1px solid var(--color-border)",
    flexShrink: 0,
  },
  topBarTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    margin: 0,
    textAlign: "center",
    flex: 1,
  },
  topBarBackButton: {
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "var(--color-text-primary)",
    cursor: "pointer",
    borderRadius: 8,
  },
  topBarSpacer: {
    width: 36,
    height: 36,
    flexShrink: 0,
  },
  secondaryBar: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    padding: "10px 12px",
    background: "var(--color-surface-2)",
    borderBottom: "1px solid var(--color-border)",
  },
  secondaryBarPlaceholder: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.5,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase",
  },
  secondaryBarSubtitle: {
    fontSize: 11,
    color: "var(--color-text-tertiary)",
  },
  // 100vh minus the persistent top bar (~68px), this secondary toolbar
  // (~54px now that it shows two lines), and the climb action bar that
  // replaces the tab bar on this page (~110px, taller than the regular
  // tab bar to fit the attempts counter and log-ascent button) — so the
  // image fills exactly the remaining screen height.
  imageStage: {
    height:
      "calc(100vh - 236px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    background: "var(--color-surface-1)",
    touchAction: "none",
  },
  imagePlaceholder: {
    width: "78%",
    maxWidth: 320,
    aspectRatio: "3 / 4",
    borderRadius: 16,
    background: "linear-gradient(155deg, var(--color-surface-6) 0%, var(--color-surface-3) 100%)",
    border: "1px solid var(--color-border-strong)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    userSelect: "none",
    willChange: "transform",
  },
  climbPhoto: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    userSelect: "none",
    willChange: "transform",
  },
  button: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 10,
    border: "none",
    background: "var(--color-accent)",
    color: "var(--color-text-primary)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  listRow: {
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: "14px 16px",
  },
  listRowLink: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    textAlign: "left",
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    padding: "14px 16px",
    cursor: "pointer",
    font: "inherit",
  },
  wallRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: 72,
    flexShrink: 0,
    textAlign: "left",
    background: "var(--color-surface-5)",
    border: "none",
    borderBottom: "1px solid var(--color-border)",
    borderRadius: 0,
    padding: "14px 16px",
    cursor: "pointer",
    font: "inherit",
  },
  // Two-line variant of wallRow used by ManageRolesScreen: the role select
  // needs room to sit next to the username, and the reset-password action
  // needs its own line below rather than fighting that select for space.
  adminUserRow: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
    textAlign: "left",
    background: "var(--color-surface-5)",
    borderBottom: "1px solid var(--color-border)",
    padding: "14px 16px",
  },
  adminUserRowTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 12,
  },
  resetPasswordButton: {
    alignSelf: "flex-end",
    background: "none",
    border: "none",
    color: "var(--color-danger)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    padding: 0,
  },
  formSuccess: {
    fontSize: 13,
    color: "var(--color-text-secondary)",
    margin: 0,
  },
  archiveBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    flexShrink: 0,
    textAlign: "left",
    background: "var(--color-surface-2)",
    border: "none",
    borderTop: "1px solid var(--color-border)",
    borderRadius: 0,
    padding: "14px 16px",
    color: "var(--color-text-secondary)",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
    font: "inherit",
  },
  archiveSetRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    flexShrink: 0,
    textAlign: "left",
    background: "var(--color-surface-0)",
    border: "none",
    borderTop: "1px solid var(--color-border)",
    borderRadius: 0,
    padding: "12px 20px",
    cursor: "pointer",
    font: "inherit",
  },
  climbRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    textAlign: "left",
    background: "var(--color-surface-5)",
    border: "none",
    borderBottom: "1px solid var(--color-border)",
    borderRadius: 0,
    padding: "14px 16px",
    cursor: "pointer",
    font: "inherit",
  },
  climbRowLeft: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
  },
  climbRowRight: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
  },
  climbDifficulty: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--color-text-primary)",
  },
  climbStars: {
    fontSize: 12,
    lineHeight: 1,
  },
  climbAscents: {
    fontSize: 12,
    color: "var(--color-text-tertiary)",
  },
  climbTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "var(--color-text-primary)",
  },
  climbSetter: {
    fontSize: 12,
    color: "var(--color-text-tertiary)",
  },
  commentHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    margin: 0,
  },
  commentDeleteButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "var(--color-text-tertiary)",
    cursor: "pointer",
    padding: 2,
  },
  commentText: {
    fontSize: 14,
    color: "var(--color-text-secondary)",
    lineHeight: 1.5,
    margin: 0,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: "var(--color-text-primary)",
    margin: "0 0 4px",
  },
  listMeta: {
    fontSize: 13,
    color: "var(--color-text-tertiary)",
    margin: 0,
  },
  placeholderText: {
    fontSize: 15,
    color: "var(--color-text-tertiary)",
    marginBottom: 20,
  },
  profileHeaderRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  profileLeft: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "var(--color-accent)",
    color: "var(--color-text-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 8,
  },
  avatarImage: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    objectFit: "cover",
    marginBottom: 8,
  },
  avatarPreview: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    objectFit: "cover",
    alignSelf: "center",
  },
  avatarPreviewPlaceholder: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  pickImageButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 16px",
    borderRadius: 10,
    border: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-offwhite)",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
  },
  profileUsername: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    margin: 0,
  },
  profileDisplayName: {
    fontSize: 13,
    color: "var(--color-text-tertiary)",
    margin: 0,
  },
  profileRight: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
  },
  profileStatsRow: {
    display: "flex",
    gap: 28,
  },
  settingsButton: {
    width: "100%",
    background: "none",
    border: "none",
    borderBottom: "1px solid var(--color-border)",
    borderRadius: 0,
    padding: "6px 0",
    color: "var(--color-text-secondary)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    font: "inherit",
  },
  profileStat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
  },
  profileStatNumber: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--color-text-primary)",
  },
  profileStatLabel: {
    fontSize: 12,
    color: "var(--color-text-tertiary)",
  },
  gradeChartWrapper: {
    marginBottom: 20,
  },
  gradeChartTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    margin: "0 0 12px",
  },
  gradeChart: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 2,
  },
  leaderboardRow: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 12,
  },
  leaderboardColumn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flex: 1,
  },
  leaderboardUsername: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-primary)",
    margin: 0,
  },
  leaderboardName: {
    fontSize: 11,
    color: "var(--color-text-tertiary)",
    margin: 0,
  },
  leaderboardAscents: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--color-text-secondary)",
    margin: "4px 0 8px",
  },
  leaderboardPodiumBlock: {
    width: "100%",
    borderRadius: "8px 8px 0 0",
    border: "1px solid var(--color-border-strong)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  leaderboardPodiumRank: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--color-text-primary)",
  },
  gradeBarColumn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  gradeBarCount: {
    fontSize: 9,
    color: "var(--color-text-tertiary)",
    lineHeight: 1,
    minHeight: 9,
  },
  gradeBarsRow: {
    flex: 1,
    position: "relative",
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
  },
  gradeGridlines: {
    position: "absolute",
    top: 13,
    left: 0,
    right: 0,
    height: 80,
    pointerEvents: "none",
    // Solid horizontal lines at 0/25/50/75/100% of the track height,
    // drawn once across the full width so they read as continuous lines
    // rather than being broken up by the gaps between bars.
    backgroundImage:
      "linear-gradient(var(--color-border), var(--color-border)), linear-gradient(var(--color-border), var(--color-border)), linear-gradient(var(--color-border), var(--color-border)), linear-gradient(var(--color-border), var(--color-border))",
    backgroundSize: "100% 1px",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "top 0 left 0, bottom 25% left 0, bottom 50% left 0, bottom 75% left 0",
  },
  gradeBarTrack: {
    height: 80,
    width: "100%",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    position: "relative",
  },
  gradeBar: {
    width: "70%",
    background: "var(--color-accent)",
    borderRadius: "3px 3px 0 0",
  },
  gradeBarLabel: {
    fontSize: 9,
    color: "var(--color-text-tertiary)",
    lineHeight: 1,
    minHeight: 9,
  },
  gradeAxisColumn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
    paddingRight: 6,
    flexShrink: 0,
  },
  gradeAxisSpacer: {
    minHeight: 9,
  },
  gradeAxisTrack: {
    height: 80,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  gradeAxisLabel: {
    fontSize: 9,
    color: "var(--color-text-muted)",
    lineHeight: 1,
  },
  logbookButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "12px 16px",
    borderRadius: 0,
    border: "none",
    borderTop: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-offwhite)",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
  },
  logoutButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "12px 16px",
    borderRadius: 0,
    border: "none",
    borderBottom: "1px solid var(--color-border)",
    background: "transparent",
    color: "var(--color-text-offwhite)",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  modeToggle: {
    display: "flex",
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    padding: 4,
    marginBottom: 20,
    gap: 4,
  },
  modeButton: {
    flex: 1,
    padding: "8px 0",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "var(--color-text-tertiary)",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  modeButtonActive: {
    background: "var(--color-surface-7)",
    color: "var(--color-text-primary)",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    color: "var(--color-text-tertiary)",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "var(--color-text-tertiary)",
  },
  checkboxInput: {
    width: 18,
    height: 18,
    accentColor: "var(--color-accent)",
  },
  input: {
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "var(--color-text-primary)",
    outline: "none",
  },
  searchInput: {
    display: "block",
    width: "calc(100% + 40px)",
    boxSizing: "border-box",
    marginLeft: -20,
    marginRight: -20,
    borderRadius: 0,
    borderLeft: "none",
    borderRight: "none",
  },
  climbsFilterRow: {
    display: "flex",
    gap: 8,
    marginBottom: 20,
  },
  climbsFilterInput: {
    flex: 1,
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "var(--color-text-primary)",
    outline: "none",
  },
  climbsFilterButton: {
    width: 42,
    height: 42,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    color: "var(--color-text-secondary)",
    cursor: "pointer",
  },
  inputInvalid: {
    border: "1px solid var(--color-danger)",
  },
  inputDisabled: {
    color: "var(--color-text-muted)",
    cursor: "not-allowed",
  },
  formError: {
    fontSize: 13,
    color: "var(--color-danger)",
    margin: 0,
  },
  tabBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-around",
    alignItems: "center",
    background: "var(--color-surface-4)",
    borderTop: "1px solid var(--color-border)",
    padding: "10px 0 calc(14px + env(safe-area-inset-bottom))",
  },
  tabButton: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
  },
  tabLabel: {
    fontSize: 11,
  },
  climbActionBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    background: "var(--color-surface-4)",
    borderTop: "1px solid var(--color-border)",
    padding: "18px 20px calc(22px + env(safe-area-inset-bottom))",
  },
  climbActionSideButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 52,
    height: 52,
    flexShrink: 0,
    borderRadius: 12,
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-5)",
    color: "var(--color-text-primary)",
    cursor: "pointer",
  },
  climbActionSideButtonDisabled: {
    color: "var(--color-text-disabled)",
    cursor: "not-allowed",
  },
  climbActionCenter: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  },
  attemptsCounter: {
    fontSize: 15,
    fontWeight: 600,
    color: "var(--color-text-tertiary)",
  },
  attemptsCounterDisabled: {
    color: "var(--color-text-disabled)",
  },
  logAscentButton: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 10,
    border: "none",
    background: "var(--color-accent)",
    color: "var(--color-text-primary)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  logAscentButtonDisabled: {
    background: "var(--color-border)",
    color: "var(--color-text-muted)",
    cursor: "not-allowed",
  },
  sheetBackdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.5)",
    transition: "opacity 0.25s ease",
    zIndex: 20,
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    maxHeight: "85%",
    overflowY: "auto",
    background: "var(--color-surface-4)",
    borderTop: "1px solid var(--color-border)",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: "10px 20px calc(24px + env(safe-area-inset-bottom))",
    transition: "transform 0.28s ease",
    zIndex: 21,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    background: "var(--color-border-subtle)",
    margin: "0 auto 16px",
  },
  sheetForm: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  sheetSessionAttempts: {
    fontSize: 13,
    color: "var(--color-text-tertiary)",
    margin: "-6px 0 0",
  },
  starRow: {
    display: "flex",
    gap: 6,
    padding: "8px 10px",
    border: "1px solid transparent",
    borderRadius: 10,
    touchAction: "none",
    userSelect: "none",
    cursor: "pointer",
    width: "fit-content",
  },
  starRowInvalid: {
    border: "1px solid var(--color-danger)",
  },
  textarea: {
    background: "var(--color-surface-5)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "var(--color-text-primary)",
    outline: "none",
    resize: "none",
    font: "inherit",
  },
};
