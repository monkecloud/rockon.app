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
  Tag,
} from "lucide-react";
import {
  GRADE_OPTIONS,
  bucketCounts,
  climbBucketGrade,
  climbDisplayGrade,
  composeSetterGrade,
} from "../shared/grades.js";

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
//   showing the climb's grade and name. An info icon in the top-right of
//   the persistent top bar opens that climb's Info page — a grade
//   distribution chart of what climbers logged its grade as, followed by
//   comments left when logging an ascent.
// - Profile tab: sign up / log in against a small Express server that
//   stores users in server/users.json — shared across everyone hitting
//   this server, not just the local browser. Passwords are bcrypt-hashed
//   before they ever touch disk, and auth is an httpOnly session cookie
//   resolved server-side on every request (see server/worker.js).
// - Search tab: query + Climbs/Users mode toggle (see SearchScreen) —
//   climbs filter client-side against the in-memory climbs list, users
//   hit /api/users/search.
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

// Appended for admins only — grade confirmation used to be moderator/setter
// facing (under the "Approve" label/slot this now took over), but is now
// gated to admins. See the visibleTabs computation in App().
const GRADES_TAB = { id: "grades", label: "Grades", icon: Check };

// Appended for moderators/setters (admins too, since they keep every
// moderator/setter capability) — the queue of pending climb-naming-rights
// proposals from ascent claims (see pendingNames in server/worker.js),
// taking over the "Approve" label/slot the grade-confirmation tab used to
// have. See the visibleTabs computation in App().
const APPROVE_TAB = { id: "approve", label: "Approve", icon: Tag };

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

// ---------------------------------------------------------------------------
// Data fetching (§14.9, §14.18). Two helpers, not one: reads go through
// useFetch/<Async>, writes go through apiSend. Before this, every fetch()
// call in this file ended in .catch(console.error) — nothing reached the
// user, so a downed server, dropped wifi, or a 500 all rendered as either a
// blank screen or (worse) a permanently-"loading" one. See the null-vs-[]
// note on ListScreen/App() for the specific bug that motivated this: `[]`
// is not a safe "still loading" sentinel because it's indistinguishable
// from a successful fetch that returned nothing.
// ---------------------------------------------------------------------------

// A tiny URL-keyed cache so switching tabs and back doesn't re-request data
// that's already in flight or already loaded — e.g. Home -> Walls -> Home
// used to re-fetch the leaderboard and grade pyramid every time, because
// the `content` useMemo in App() unmounts the old screen. Invalidation is
// deliberately coarse: apiSend() below clears the whole cache after any
// successful mutation, rather than tracking which keys a given write
// affects. A precise scheme is where stale-data bugs breed, and at this
// app's scale the extra refetch after a write costs nothing.
const apiCache = new Map(); // url -> { data }

export function clearApiCache() {
  apiCache.clear();
}

// Fetches `url` (GET) on mount and whenever `url`/`skip` changes, exposing
// { data, loading, error, retry }. `data` is null until the first
// successful response — that's the "unknown, not yet fetched" state; once a
// fetch resolves, `data` becomes whatever the server returned (which may
// itself be an empty list — a *known* empty result, not a loading one).
// Never conflate the two, in this hook or in what reads it.
export function useFetch(url, { skip = false } = {}) {
  const cached = apiCache.get(url);
  const [state, setState] = useState(() =>
    cached ? { data: cached.data, loading: false, error: null } : { data: null, loading: !skip, error: null }
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (skip) return;
    // A cache hit on a later mount (e.g. re-visiting a tab) skips the
    // network round-trip entirely rather than showing a loading flash for
    // data already on hand.
    if (nonce === 0 && apiCache.has(url)) {
      setState({ data: apiCache.get(url).data, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then((res) =>
        res.ok ? res.json() : res.json().then((d) => Promise.reject(d.error || `HTTP ${res.status}`))
      )
      .then((data) => {
        apiCache.set(url, { data });
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ data: null, loading: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `skip` and
    // `nonce` are read above but only `url` should re-trigger the base
    // fetch; `nonce` incrementing (via retry()) is what re-runs it on
    // demand, and including `skip` would refetch on every skip toggle.
  }, [url]);

  return { ...state, retry: () => setNonce((n) => n + 1) };
}

// Renders one of three branches consistently, including a retry button on
// error — the single most useful thing this adds over the status quo. A
// phone that briefly drops wifi mid-session used to need a full app reload
// to recover from any failed fetch; now it needs one tap.
export function Async({ loading, error, retry, loadingFallback, children }) {
  if (loading) return loadingFallback ?? <p style={styles.placeholderText}>Loading…</p>;
  if (error) {
    return (
      <div style={styles.asyncError}>
        <p style={styles.formError} role="alert">{error}</p>
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  return children;
}

// Every write (POST/DELETE) in the app goes through this instead of a
// bespoke try/fetch/catch — unifies what callAuthApi/callSettingsApi were
// already informally doing. Returns { success, data, error } and, on
// success, clears the read cache above so the next screen that needs
// affected data refetches it (see the coarse-invalidation note).
export async function apiSend(url, { method = "POST", body, onUnauthorized } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // A 401 here means the session expired *during* use (not at mount —
      // see GET /api/me in App() for that case, §14.8) — the one gap that
      // item's own writeup flagged as still open. Closing it is one line
      // now that every write funnels through here.
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      return { success: false, error: data.error || "Something went wrong." };
    }

    clearApiCache();
    return { success: true, data };
  } catch (err) {
    console.error(`Failed to reach ${url}:`, err);
    return { success: false, error: "Couldn't reach the server. Is it running?" };
  }
}

const RECENT_ACTIVITY_PLACEHOLDERS = [1, 2, 3, 4, 5];

// Podium block heights, tallest in the middle (1st place) — left-to-right
// display order is 2nd/1st/3rd, the standard podium arrangement.
const PODIUM_HEIGHTS = { 1: 64, 2: 44, 3: 30 };

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

// A full-height, zoomable/pannable image area with its own toolbar
// (zoom out / percentage / zoom in / reset) that stays pinned just below
// the persistent top bar. Uses the Pointer Events API so mouse drag,
// touch drag, and two-finger pinch all go through the same code path.
export function ZoomableImageViewer({ title, subtitle, photoUrl }) {
  const imageRef = useRef(null);
  const stageRef = useRef(null);
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

  // Blocks native two-finger pinch-zoom so it doesn't fight the pointer-
  // based pinch handled above. Used to live as a document-wide listener in
  // main.jsx, running on every touchmove anywhere in the app; scoped here
  // to just the image stage, the only place it's actually needed (§14.22).
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const handleTouchMove = (e) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => node.removeEventListener("touchmove", handleTouchMove);
  }, []);

  return (
    <div>
      <div style={styles.secondaryBar}>
        <span style={styles.secondaryBarPlaceholder}>{title}</span>
        {subtitle && <span style={styles.secondaryBarSubtitle}>{subtitle}</span>}
      </div>

      <div
        ref={stageRef}
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

export function ClimbInfoScreen({ climb, currentUser, onDeleteComment }) {
  const comments = climb?.comments ?? [];

  return (
    <div style={styles.screen}>
      {climb && (
        <GradeBarChart
          title="Logged grades"
          endpoint={`/api/climbs/grade-distribution?wallId=${climb.wallId}&setterName=${encodeURIComponent(
            climb.setterName
          )}`}
        />
      )}
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

export function ListScreen({
  selectedItem,
  selectedSubItem,
  climbsByWall,
  climbsError,
  onRetryClimbs,
  onSelectItem,
  onSelectSubItem,
  archiveExpanded,
  archiveWalls,
  archiveError,
  onRetryArchive,
  onToggleArchive,
  onSelectArchiveWall,
  onOpenFilter,
  climbSortBy,
  showResetClimbs,
  showBackfillClimbs,
}) {
  const [climbSearch, setClimbSearch] = useState("");

  if (selectedItem && selectedSubItem) {
    const climb = (climbsByWall?.[selectedItem.id] || []).find((c) => c.setterName === selectedSubItem);
    const title = climb ? climbTitleNode(climb) : "Loading…";
    const subtitle = climb ? `Set by ${climb.setter}` : undefined;

    // key forces a remount (resetting pan/zoom) whenever the climb changes,
    // rather than relying on an intermediate unmount elsewhere in the tree
    // to do it implicitly (§14.21f).
    return (
      <ZoomableImageViewer
        key={`${selectedItem.id}::${selectedSubItem}`}
        title={title}
        subtitle={subtitle}
        photoUrl={climb?.photoUrl}
      />
    );
  }

  if (selectedItem) {
    // climbsByWall is null until GET /api/climbs resolves at all (see
    // App()); climbsByWall[id] being undefined vs [] then distinguishes
    // "this wall genuinely has no current climbs" from "haven't fetched
    // yet" — conflating the two (both used to read as climbs.length === 0)
    // made a wall with zero current climbs show "Loading climbs…" forever
    // (§14.9).
    const wallClimbs = climbsByWall ? climbsByWall[selectedItem.id] || [] : null;
    const visibleClimbs = (wallClimbs || []).filter((climb) =>
      climb.setType === "reset"
        ? showResetClimbs
        : climb.setType === "backfill"
          ? showBackfillClimbs
          : true
    );
    const sortedClimbs = sortClimbs(visibleClimbs, climbSortBy);
    const filteredClimbs = sortedClimbs.filter((climb) => matchesClimbQuery(climb, climbSearch));

    return (
      <div style={styles.screen}>
        {visibleClimbs.length > 0 && (
          <GradeBarChart
            title={`${visibleClimbs.length} climbs`}
            counts={bucketCounts(visibleClimbs.map(climbBucketGrade))}
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
          <button
            type="button"
            style={styles.climbsFilterButton}
            onClick={onOpenFilter}
            aria-label="Filter climbs"
          >
            <Filter size={18} />
          </button>
        </div>
        {climbsError ? (
          <div style={styles.asyncError}>
            <p style={styles.formError} role="alert">{climbsError}</p>
            <button type="button" style={styles.retryButton} onClick={onRetryClimbs}>
              Retry
            </button>
          </div>
        ) : wallClimbs === null ? (
          <p style={styles.placeholderText}>Loading climbs…</p>
        ) : filteredClimbs.length === 0 ? (
          <p style={styles.placeholderText}>
            {climbSearch.trim()
              ? `No climbs match "${climbSearch}".`
              : wallClimbs.length === 0
                ? "No climbs on this wall yet."
                : "No climbs match your filters."}
          </p>
        ) : (
          <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
            {filteredClimbs.map((climb) => (
              <button
                key={`${climb.setId}::${climb.setterName}`}
                style={styles.climbRow}
                onClick={() => onSelectSubItem(climb.setterName)}
              >
                <div style={styles.climbRowLeft}>
                  <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
                  <StarRatingDisplay value={climb.averageStars} />
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
              <p style={styles.listMeta}>{(climbsByWall?.[item.id] || []).length} climbs</p>
            </div>
            <ChevronRight size={18} color="var(--color-text-muted)" />
          </button>
        ))}
        <ArchiveSection
          expanded={archiveExpanded}
          walls={archiveWalls}
          error={archiveError}
          onRetry={onRetryArchive}
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
export function ArchiveSection({ expanded, walls, error, onRetry, onToggle, onSelectWall }) {
  return (
    <>
      <button type="button" style={styles.archiveBar} onClick={onToggle}>
        <span>Archive</span>
        <ChevronRight
          size={18}
          color="var(--color-text-muted)"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        />
      </button>

      {expanded &&
        (error ? (
          <div style={{ ...styles.asyncError, padding: "16px 20px" }}>
            <p style={styles.formError} role="alert">{error}</p>
            <button type="button" style={styles.retryButton} onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : walls === null ? (
          <p style={{ ...styles.placeholderText, padding: "16px 20px" }}>Loading…</p>
        ) : walls.length === 0 ? (
          <p style={{ ...styles.placeholderText, padding: "16px 20px" }}>No archived climbs yet.</p>
        ) : (
          walls.map((wall) => (
            <button
              type="button"
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
            </button>
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
export function ArchiveWallScreen({ wall, onSelectClimb }) {
  if (!wall) return null;

  return (
    <div style={styles.screen}>
      <p style={styles.listMeta}>{wall.climbs.length} climbs</p>
      <div style={{ ...styles.list, marginTop: 16, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {wall.climbs.map((climb) => (
          <button
            key={`${climb.setterName}-${climb.setDate}`}
            style={styles.climbRow}
            onClick={() => onSelectClimb(climb)}
          >
            <div style={styles.climbRowLeft}>
              <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
              <StarRatingDisplay value={climb.averageStars} />
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

export function PlaceholderScreen({ title }) {
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

// Opened from the filter button on a wall's Climbs page. Sort by/Reset/
// Backfill are wired up to ListScreen's climb list (see App's climbSortBy/
// showResetClimbs/showBackfillClimbs); the grade range and setter fields
// below are still just placeholders for whatever a real climb filter ends
// up needing there.
export function ClimbsFilterForm({
  sortBy,
  onSortByChange,
  showResetClimbs,
  onShowResetClimbsChange,
  showBackfillClimbs,
  onShowBackfillClimbsChange,
}) {
  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={(e) => e.preventDefault()}>
        <label style={styles.label}>
          Sort by
          <select style={styles.input} value={sortBy} onChange={(e) => onSortByChange(e.target.value)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.checkboxRow}>
          <input
            style={styles.checkboxInput}
            type="checkbox"
            checked={showResetClimbs}
            onChange={(e) => onShowResetClimbsChange(e.target.checked)}
          />
          Reset
        </label>
        <label style={styles.checkboxRow}>
          <input
            style={styles.checkboxInput}
            type="checkbox"
            checked={showBackfillClimbs}
            onChange={(e) => onShowBackfillClimbsChange(e.target.checked)}
          />
          Backfill
        </label>
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

// Opened from the "+" button on a wall's Climbs page (moderators/setters
// only) — wallId/resetDate are fixed, no wall picker. Every climb saved
// here is stored server-side as a "backfill" (see POST /api/climbs) — the
// Backfill checkbox only decides which date it's dated: today's/the
// current reset's date, or a picked date in the past for logging a climb
// that's been up for a while already. Compare with NewWallForm below,
// opened from the Walls root list's "+" instead — similar fields, but for
// starting a wall's next "reset" rather than adding to its current set.
export function NewClimbForm({ wallId, resetDate, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const { data: settersData } = useFetch("/api/users/setters");
  const setters = settersData?.setters || [];
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [isBackfill, setIsBackfill] = useState(false);
  const [backfillDate, setBackfillDate] = useState(() => new Date().toISOString().slice(0, 10));

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
        {error && <p style={styles.formError} role="alert">{error}</p>}
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
export function NewWallForm({ walls, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const { data: settersData } = useFetch("/api/users/setters");
  const setters = settersData?.setters || [];
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedWallId, setSelectedWallId] = useState(walls?.[0]?.id ?? "");
  const [setDate, setSetDate] = useState(() => new Date().toISOString().slice(0, 10));

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
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

// Numeric read of a climb's grade for sorting — VB sorts below V0, and a
// climb with no readable grade at all sorts to the very end regardless of
// ascending/descending (rather than jumping to the top on descending).
// Built on climbBucketGrade so a setter's still-unconfirmed guess sorts the
// same way it buckets everywhere else (top end of a range, e.g. "V2-4" as V4).
export function climbGradeSortValue(climb) {
  const grade = (climbBucketGrade(climb) || "").trim().toUpperCase();
  if (grade === "VB") return -1;
  const match = grade.match(/^V(\d+)$/);
  return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

// Options for the Climbs filter page's "Sort by" dropdown (see
// ClimbsFilterForm/sortClimbs). "Setter" sorts by who set the climb, not the
// confirmed/setter grade.
const SORT_OPTIONS = [
  { id: "gradeAsc", label: "Grade (ascending)" },
  { id: "gradeDesc", label: "Grade (descending)" },
  { id: "nameAsc", label: "Alphabetical (A-Z)" },
  { id: "nameDesc", label: "Alphabetical (Z-A)" },
  { id: "setterAsc", label: "Setter (A-Z)" },
  { id: "setterDesc", label: "Setter (Z-A)" },
];

// Shared by SearchScreen and the in-wall climb search (ListScreen) so
// "search for a setter's name" works the same everywhere — matching on name
// only in one place and name+setter in the other was an inconsistency, not
// a deliberate scoping choice (§14.21c).
export function matchesClimbQuery(climb, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return climb.name.toLowerCase().includes(q) || (climb.setter || "").toLowerCase().includes(q);
}

export function sortClimbs(climbs, sortBy) {
  const sorted = [...climbs];
  switch (sortBy) {
    case "gradeDesc":
      // Plain `climbGradeSortValue(b) - climbGradeSortValue(a)` would put a
      // no-grade climb (Infinity) *first* here, not last — Infinity reads
      // as "highest" under both directions, so simply flipping the
      // subtraction for descending flips it to the front instead of
      // keeping it pinned to the end like gradeAsc naturally does. Handled
      // explicitly so both directions honor the same "no grade sorts last"
      // rule the comment on climbGradeSortValue promises.
      sorted.sort((a, b) => {
        const av = climbGradeSortValue(a);
        const bv = climbGradeSortValue(b);
        if (av === Number.POSITIVE_INFINITY) return bv === Number.POSITIVE_INFINITY ? 0 : 1;
        if (bv === Number.POSITIVE_INFINITY) return -1;
        return bv - av;
      });
      break;
    case "nameAsc":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "nameDesc":
      sorted.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "setterAsc":
      sorted.sort((a, b) => (a.setter || "").localeCompare(b.setter || ""));
      break;
    case "setterDesc":
      sorted.sort((a, b) => (b.setter || "").localeCompare(a.setter || ""));
      break;
    case "gradeAsc":
    default:
      sorted.sort((a, b) => climbGradeSortValue(a) - climbGradeSortValue(b));
      break;
  }
  return sorted;
}

// A climb row's star rating, rounded to the nearest whole star. Was
// "⭐".repeat(n) + "☆".repeat(5-n) — read literally by screen readers as
// "star star star...", once per character — replaced with the same lucide
// Star icons StarRatingInput uses, plus one aria-label giving the numeric
// value instead (§14.22).
export function StarRatingDisplay({ value }) {
  const filled = Math.round(value || 0);
  return (
    <span style={styles.climbStars} aria-label={`${filled} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={12}
          color={n <= filled ? "var(--color-star)" : "var(--color-text-disabled)"}
          fill={n <= filled ? "var(--color-star)" : "none"}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

// The colored grade shown in a climb's title (see climbTitleNode below) —
// gray for a setter's still-unconfirmed guess, white once an admin has
// locked in the final grade (see the Grades tab).
export function ClimbGradeLabel({ climb }) {
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
export function climbTitleNode(climb) {
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
// Placeholder columns for GradeBarChart's loading skeleton — same count as
// GRADE_OPTIONS so the skeleton's width/gaps match the real chart closely
// enough that nothing visibly reflows once data arrives.
const GRADE_CHART_SKELETON_COLUMNS = Array.from({ length: GRADE_OPTIONS.length }, (_, i) => i);

export function GradeBarChart({ title, endpoint, counts: providedCounts }) {
  const { data, error, retry } = useFetch(endpoint, { skip: !endpoint });
  const counts = providedCounts ?? data?.counts ?? null;

  if (!counts) {
    // A real fetch failure (endpoint mode only — in-memory `counts` can't
    // fail) gets a visible retry instead of the chart just never appearing.
    if (endpoint && error) {
      return (
        <div style={styles.gradeChartWrapper}>
          {title && <p style={styles.gradeChartTitle}>{title}</p>}
          <div style={styles.asyncError}>
            <p style={styles.formError} role="alert">{error}</p>
            <button type="button" style={styles.retryButton} onClick={retry}>
              Retry
            </button>
          </div>
        </div>
      );
    }
    // Same-dimensioned skeleton rather than `null` — the chart used to
    // vanish entirely while loading, so everything below it (leaderboard,
    // activity list) jumped up and then back down once data arrived (§14.21d).
    return (
      <div style={styles.gradeChartWrapper}>
        {title && <p style={styles.gradeChartTitle}>{title}</p>}
        <div style={styles.gradeChart}>
          <div style={styles.gradeAxisColumn}>
            <span style={styles.gradeAxisSpacer} />
            <div style={styles.gradeAxisTrack} />
            <span style={styles.gradeAxisSpacer} />
          </div>
          <div style={styles.gradeBarsRow}>
            <div style={styles.gradeGridlines} />
            {GRADE_CHART_SKELETON_COLUMNS.map((i) => (
              <div key={i} style={styles.gradeBarColumn}>
                <span style={styles.gradeBarCount} />
                <div style={styles.gradeBarTrack}>
                  <div style={{ ...styles.gradeBar, ...styles.gradeBarSkeleton, height: 3 }} />
                </div>
                <span style={styles.gradeBarLabel} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

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

const SETTINGS_OPTIONS = [
  { id: "avatar", label: "Change profile picture" },
  { id: "username", label: "Change username" },
  { id: "name", label: "Change name" },
  { id: "password", label: "Change password" },
];

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

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "moderator", label: "Moderator" },
  { value: "setter", label: "Setter" },
  { value: "admin", label: "Admin" },
];

// Moderator and setter are peers (same permission level, different label);
// admin implies both, so it's checked first.
export function roleOf(user) {
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

// Opened from the Grades tab (admin only). Lists every climb that's been
// superseded by a newer reset on its wall (see currentClimbsOnly
// server-side) but doesn't have a confirmed grade yet — i.e. exactly the
// climbs an admin is now allowed to lock in a final grade for, per the gate
// on POST /api/climbs/grade. Picking a grade and tapping the checkmark
// confirms it and drops the row from this list.
export function GradesScreen() {
  const { data: climbsData, loading, error: fetchError, retry } = useFetch("/api/climbs/needs-grade");
  const [climbs, setClimbs] = useState(null);
  const [error, setError] = useState("");
  const [gradeByKey, setGradeByKey] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    if (climbsData) setClimbs(climbsData.climbs || []);
  }, [climbsData]);

  const handleConfirmGrade = async (climb, key, grade) => {
    setSavingKey(key);
    setError("");
    const result = await apiSend("/api/climbs/grade", {
      body: { wallId: climb.wallId, setterName: climb.setterName, grade },
    });
    if (!result.success) {
      setError(result.error);
    } else {
      setClimbs((prev) =>
        prev.filter((c) => c.wallId !== climb.wallId || c.setterName !== climb.setterName)
      );
    }
    setSavingKey(null);
  };

  return (
    <div style={styles.screen}>
      {(error || fetchError) && <p style={styles.formError} role="alert">{error || fetchError}</p>}
      {climbs === null && loading && <p style={styles.placeholderText}>Loading…</p>}
      {climbs === null && fetchError && (
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      )}
      {climbs !== null && climbs.length === 0 && (
        <p style={styles.placeholderText}>No climbs waiting on a final grade.</p>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {(climbs || []).map((climb) => {
          const key = `${climb.wallId}::${climb.setterName}`;
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
                <span style={styles.climbSetter}>Setter grade: {climb.setterGrade}</span>
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

// Opened from the Approve tab (moderators/setters only). Naming rights: a
// climber who fills in a name for any first-through-fifth ascent claim (see
// LogAscentSheet) is also proposing that name as the climb's new display
// name — queued here (climb.pendingNames, server-side) rather than taking
// effect immediately. Approving one sets the climb's confirmed name and
// clears any other pending proposals for that climb; rejecting just drops
// that one proposal. The climb's setterName (its immutable identity) never
// changes either way.
export function ApproveClimbsScreen() {
  const { data: climbsData, loading, error: fetchError, retry } = useFetch("/api/climbs/needs-name-approval");
  const [climbs, setClimbs] = useState(null);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    if (climbsData) setClimbs(climbsData.climbs || []);
  }, [climbsData]);

  const handleResolveProposal = async (climb, proposal, action) => {
    setSavingId(proposal.id);
    setError("");
    const result = await apiSend("/api/climbs/approve-name", {
      body: { wallId: climb.wallId, setterName: climb.setterName, proposalId: proposal.id, action },
    });
    if (!result.success) {
      setError(result.error);
    } else {
      setClimbs((prev) =>
        action === "approve"
          ? prev.filter((c) => c.wallId !== climb.wallId || c.setterName !== climb.setterName)
          : prev
              .map((c) =>
                c.wallId === climb.wallId && c.setterName === climb.setterName
                  ? { ...c, pendingNames: c.pendingNames.filter((p) => p.id !== proposal.id) }
                  : c
              )
              .filter((c) => c.pendingNames.length > 0)
      );
    }
    setSavingId(null);
  };

  return (
    <div style={styles.screen}>
      {(error || fetchError) && <p style={styles.formError} role="alert">{error || fetchError}</p>}
      {climbs === null && loading && <p style={styles.placeholderText}>Loading…</p>}
      {climbs === null && fetchError && (
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      )}
      {climbs !== null && climbs.length === 0 && (
        <p style={styles.placeholderText}>No pending name proposals.</p>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {(climbs || []).flatMap((climb) =>
          (climb.pendingNames || []).map((proposal) => (
            <div key={proposal.id} style={styles.climbRow}>
              <div style={styles.climbRowLeft}>
                <span style={styles.climbTitle}>{proposal.name}</span>
                <span style={styles.climbSetter}>
                  {WALL_NAME_BY_ID[climb.wallId] ?? `Wall ${climb.wallId}`} · currently "{climb.name}"
                </span>
                <span style={styles.climbSetter}>Proposed by {proposal.claimedBy}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingId === proposal.id}
                  aria-label={`Reject name "${proposal.name}" for ${climb.name}`}
                  onClick={() => handleResolveProposal(climb, proposal, "reject")}
                >
                  <Trash2 size={20} />
                </button>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingId === proposal.id}
                  aria-label={`Approve name "${proposal.name}" for ${climb.name}`}
                  onClick={() => handleResolveProposal(climb, proposal, "approve")}
                >
                  <Check size={20} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function TopBar({
  title,
  showBack,
  onBack,
  showInfoButton,
  onShowInfo,
  showAddButton,
  addButtonLabel,
  onAdd,
}) {
  return (
    <header style={styles.topBar}>
      {showBack ? (
        <button style={styles.topBarBackButton} onClick={onBack} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
      ) : (
        <div style={styles.topBarSpacer} />
      )}
      <h1 style={styles.topBarTitle}>{title}</h1>
      {showInfoButton ? (
        <button style={styles.topBarBackButton} onClick={onShowInfo} aria-label="Climb info">
          <Info size={20} />
        </button>
      ) : showAddButton ? (
        // addButtonLabel is context-dependent (New Climb vs. New Wall) — the
        // caller knows which, TopBar doesn't (§14.13 part 1).
        <button style={styles.topBarBackButton} onClick={onAdd} aria-label={addButtonLabel}>
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
export function ClimbActionBar({ attempts, onDecrement, onIncrement, onLogAscent, disabled }) {
  return (
    <nav style={styles.climbActionBar}>
      <button
        style={{
          ...styles.climbActionSideButton,
          ...(disabled ? styles.climbActionSideButtonDisabled : {}),
        }}
        onClick={disabled ? undefined : onDecrement}
        disabled={disabled}
        aria-label="Decrease attempts"
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
        aria-label="Increase attempts"
      >
        <Plus size={22} />
      </button>
    </nav>
  );
}

export function StarRatingInput({ value, onChange, invalid, inputRef }) {
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

  // Arrow keys move in 0.5 steps; Home/End jump to the practical min (a
  // half star — 0 itself is invalid, see LogAscentSheet's ratingInvalid)
  // and max. preventDefault on the arrows, otherwise they scroll the sheet
  // instead of adjusting the rating (§14.13 part 5). The pointer-drag path
  // above is unchanged — this is an alternate input, not a replacement.
  const handleKeyDown = (e) => {
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, value + 0.5);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, value - 0.5);
    else if (e.key === "Home") next = 0.5;
    else if (e.key === "End") next = 5;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div
      ref={(el) => {
        rowRef.current = el;
        if (inputRef) inputRef.current = el;
      }}
      role="slider"
      tabIndex={0}
      aria-label="Rating"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={value}
      aria-valuetext={`${value} out of 5 stars`}
      style={{ ...styles.starRow, ...(invalid ? styles.starRowInvalid : {}) }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onKeyDown={handleKeyDown}
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

// Up to 5 ascentClaims live on the climb itself (see server/worker.js), one
// slot per ordinal. Whoever logs an ascent while a slot is still open gets
// offered it — a name to credit (defaults to blank, e.g. crediting someone
// else) or a "Pass" to leave it unclaimed. Filling in neither during a
// given ascent just leaves that slot open for the next person to log one.
// Naming rights: a filled-in name also gets queued as a proposal to rename
// the climb itself, awaiting a moderator/setter's approval on the Approve
// tab (see server/worker.js's pendingNames).
const ASCENT_ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];

export function LogAscentSheet({
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
  const sheetRef = useRef(null);
  const ratingRef = useRef(null);
  const previouslyFocused = useRef(null);

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

  // Dialog focus management (§14.13 part 4): move focus into the sheet on
  // open (the rating slider is the first real field) and restore it to
  // whatever had focus before — normally the "Log ascent" button — on
  // close. Without the restore, a keyboard user who closes the sheet is
  // dumped back at the top of the page with no indication where they
  // landed.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement;
      // The sheet's own `visibility: hidden -> visible` is a *transitioned*
      // property (see styles.sheet), and focus() on an element that still
      // computes as visibility:hidden is a silent no-op. Right after this
      // effect commits, the browser hasn't applied the new computed style
      // yet (verified: still "hidden" even one rAF later) — it takes a
      // second frame for the transitioned value to actually land, a known
      // browser quirk with transitioning styles set in the same tick as a
      // React commit. Double-rAF is the standard workaround.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => ratingRef.current?.focus());
      });
    } else {
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    }
  }, [open]);

  // Escape closes; Tab/Shift+Tab wrap within the sheet instead of leaking
  // into the page behind it (the sheet stays in the DOM/tab-order-capable
  // even while closed — see styles.sheet's visibility toggle — so without
  // a trap, tabbing from the last field would walk into whatever's behind
  // the backdrop).
  const handleKeyDown = (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !sheetRef.current) return;
    const focusable = Array.from(
      sheetRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Log ascent"
        onKeyDown={handleKeyDown}
        style={{
          ...styles.sheet,
          transform: open ? "translateY(0)" : "translateY(100%)",
          visibility: open ? "visible" : "hidden",
        }}
      >
        <div style={styles.sheetHandle} />
        <form style={styles.sheetForm} onSubmit={handleSubmit} noValidate>
          <label style={styles.label}>
            Rating
            <StarRatingInput
              value={starRating}
              onChange={setStarRating}
              invalid={ratingInvalid}
              inputRef={ratingRef}
            />
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
  const [showInfo, setShowInfo] = useState(false);
  const [viewingArchivedClimb, setViewingArchivedClimb] = useState(null);
  // Lifted out of ArchiveSection so it survives that component unmounting
  // (tab switches, drilling into a wall/climb and back) instead of
  // resetting. viewingArchiveWallId is which wall's archived-climbs page
  // (ArchiveWallScreen) is currently open, if any.
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  // Lazy — only actually fetches once the section is first expanded
  // (skip: !archiveExpanded), and useFetch's own cache means re-collapsing
  // and re-expanding doesn't re-request it.
  const archiveFetch = useFetch("/api/archive", { skip: !archiveExpanded });
  const archiveWalls = archiveFetch.data?.walls ?? null;
  const [viewingArchiveWallId, setViewingArchiveWallId] = useState(null);
  // Moderator-only "add" flow from the Climbs page — not wired up to
  // anything yet, just the page shell and a placeholder form.
  const [creatingClimb, setCreatingClimb] = useState(false);
  // "Filter" flow from the Climbs page. sortBy/showReset/showBackfill drive
  // ListScreen's climb list (see ClimbsFilterForm) — the rest of the form is
  // still just a placeholder shell. Reset/backfill both default to shown,
  // and climbs sort by grade ascending (easiest first) by default.
  const [filteringClimbs, setFilteringClimbs] = useState(false);
  const [climbSortBy, setClimbSortBy] = useState("gradeAsc");
  const [showResetClimbs, setShowResetClimbs] = useState(true);
  const [showBackfillClimbs, setShowBackfillClimbs] = useState(true);
  const [attempts, setAttempts] = useState(0);
  const [showLogAscentSheet, setShowLogAscentSheet] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOption, setSettingsOption] = useState(null);
  // Stack of screens drilled into from the Search tab — a profile
  // ({ kind: "profile", user }, user in search-result shape: username/
  // name/avatarUrl/counts) or a followers/following list
  // ({ kind: "list", username, listType }). The last entry is what's
  // currently shown. A real stack, rather than one slot per screen type,
  // so profile -> followers list -> another profile -> back -> back
  // retraces each step instead of popping straight to Search results —
  // a follow/following list can lead to viewing yet another profile on
  // top of the one you were already on.
  const [searchStack, setSearchStack] = useState([]);
  // Set only when the search stack's bottom entry came from the Leaderboard
  // (see handleSelectLeaderboardUser) rather than the Search tab itself, so
  // backing out of it returns to the tab it was opened from instead of
  // landing on an empty Search tab.
  const [leaderboardReturnTab, setLeaderboardReturnTab] = useState(null);
  const topSearchEntry = searchStack[searchStack.length - 1] ?? null;
  const viewingSearchUser = topSearchEntry?.kind === "profile" ? topSearchEntry.user : null;
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
  const climbsFetch = useFetch("/api/climbs");
  const climbs = climbsFetch.data?.climbs ?? null;

  const climbsByWall = useMemo(() => {
    if (!climbs) return null;
    const map = {};
    climbs.forEach((climb) => {
      if (!map[climb.wallId]) map[climb.wallId] = [];
      map[climb.wallId].push(climb);
    });
    return map;
  }, [climbs]);

  const selectedClimb =
    selectedListItem && selectedSubItem
      ? (climbsByWall?.[selectedListItem.id] || []).find((c) => c.setterName === selectedSubItem)
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

  // Verifies the cached session against the cookie (the actual source of
  // truth, see the comment above) on mount, rather than trusting whatever
  // was cached at last page load forever — a session that's expired, been
  // reset by an admin, or had a role change since only self-corrects here
  // (§14.8). A brief flash of stale cached state before this resolves is
  // acceptable.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (!cancelled) setCurrentUser(data.user);
      })
      .catch((err) => {
        // Only an explicit 401 ("the cookie says you're logged out") clears
        // the cached session. A network error — dropped wifi, the server
        // restarting — must NOT: on a phone at a climbing gym with patchy
        // signal, that would log people out constantly. This is the one
        // detail that makes this safe to ship; get it wrong and every wifi
        // blip becomes a surprise logout.
        if (!cancelled && err === 401) setCurrentUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const callAuthApi = async (endpoint, credentials) => {
    const result = await apiSend(`/api/${endpoint}`, { body: credentials });
    if (!result.success) return result;
    setCurrentUser(result.data.user);
    return { success: true, needsPasswordReset: !!result.data.needsPasswordReset };
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
    const result = await apiSend(`/api/users/${encodeURIComponent(currentUser.username)}${path}`, {
      body,
      // A 401 here means the session cookie no longer checks out (expired,
      // reset, etc. — see the /api/me verification effect above) — close
      // the gap that left the UI showing a stale logged-in Settings form
      // against a session the server no longer honors (§14.8/§14.9).
      onUnauthorized: () => setCurrentUser(null),
    });
    if (!result.success) return result;
    if (result.data.user) setCurrentUser(result.data.user);
    setSettingsOption(null);
    return { success: true };
  };

  // Used by NewClimbForm's Save button (see the "+" flow on a wall's Climbs
  // page). On success, refetches the wall's climbs so the new one shows up
  // immediately and pops back out of the creation form.
  const handleCreateClimb = async (fields) => {
    const result = await apiSend("/api/climbs", { body: fields });
    if (!result.success) return result;
    climbsFetch.retry();
    setCreatingClimb(false);
    return { success: true };
  };

  const handleUpdateAvatar = (avatarUrl) => callSettingsApi("/avatar", { avatarUrl });
  const handleUpdateUsername = (newUsername) => callSettingsApi("/username", { newUsername });
  const handleUpdateName = (name) => callSettingsApi("/name", { name });
  const handleUpdatePassword = ({ currentPassword, newPassword }) =>
    callSettingsApi("/password", { currentPassword, newPassword });

  const handleSelectListItem = (item) => {
    setSelectedListItem(item);
    setSelectedSubItem(null);
    setShowInfo(false);
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
    setSelectedSubItem(climb.setterName);
    setShowInfo(false);
    setCreatingClimb(false);
    setFilteringClimbs(false);
    setViewingArchivedClimb(null);
    setViewingArchiveWallId(null);
    setAttempts(0);
    setShowLogAscentSheet(false);
  };

  // Starts a fresh Search-tab navigation stack from a Search result — any
  // previously drilled-into profiles/lists are discarded, same as picking
  // a new destination rather than continuing down the same path. A fresh
  // pick from Search always means "back" should land on an empty Search
  // tab, so this cancels any pending Leaderboard return.
  const handleSelectSearchUser = (user) => {
    setLeaderboardReturnTab(null);
    setSearchStack([{ kind: "profile", user }]);
  };

  // Opened from the Home tab's Leaderboard — same destination as tapping a
  // Search result, just also switches to the Search tab to get there since
  // the podium lives on Home. Remembers the tab it was opened from so
  // backing all the way out returns there instead of stranding the user on
  // an empty Search tab.
  const handleSelectLeaderboardUser = (user) => {
    const originTab = activeTab;
    handleSelectSearchUser(user);
    setLeaderboardReturnTab(originTab);
    setActiveTab("search");
  };

  // Opened from a followers/following list row (see FollowListScreen) —
  // pushes onto the stack rather than replacing it, so back retraces
  // through each screen visited rather than popping straight to Search.
  const handlePushProfile = (user) => setSearchStack((prev) => [...prev, { kind: "profile", user }]);

  // Opened from UserProfileScreen's tappable follower/following counts.
  const handlePushFollowList = (username, listType) =>
    setSearchStack((prev) => [...prev, { kind: "list", username, listType }]);

  // Popping the last entry off a stack that was opened from the Leaderboard
  // returns to the tab it was opened from rather than landing on an empty
  // Search tab (see handleSelectLeaderboardUser).
  const handlePopSearchStack = () => {
    setSearchStack((prev) => {
      const next = prev.slice(0, -1);
      if (next.length === 0 && leaderboardReturnTab) {
        setActiveTab(leaderboardReturnTab);
        setLeaderboardReturnTab(null);
      }
      return next;
    });
  };

  // Shared by UserProfileScreen's Follow/Unfollow button — hits whichever
  // endpoint matches the requested direction, then patches every stacked
  // profile entry for that user (there's no single "get this user's
  // profile" endpoint; the stack entry is the same search-result-shaped
  // object this patches) rather than refetching.
  const handleFollowToggle = async (targetUsername, follow) => {
    if (!currentUser) return;
    const result = await apiSend(
      `/api/users/${encodeURIComponent(targetUsername)}/${follow ? "follow" : "unfollow"}`,
      {}
    );
    if (!result.success) return;
    const data = result.data;
    setSearchStack((prev) =>
      prev.map((entry) =>
        entry.kind === "profile" && entry.user.username === targetUsername
          ? {
              ...entry,
              user: { ...entry.user, isFollowing: data.isFollowing, followersCount: data.followersCount },
            }
          : entry
      )
    );
  };

  const handleViewArchivedClimb = (climb) => {
    setViewingArchivedClimb(climb);
    setShowInfo(false);
    setAttempts(0);
    setShowLogAscentSheet(false);
  };

  const handleToggleArchive = () => {
    setArchiveExpanded((prev) => !prev);
  };

  // Tapping the Walls tab while already on it pops all the way back to the
  // top-level Walls list, same as re-tapping the current tab in most apps.
  const handleTabPress = (tabId) => {
    if (tabId === activeTab && tabId === "list") {
      setSelectedListItem(null);
      setSelectedSubItem(null);
      setShowInfo(false);
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
      setSearchStack([]);
      setLeaderboardReturnTab(null);
      return;
    }
    setActiveTab(tabId);
  };

  const handleSelectSubItem = (climbName) => {
    setSelectedSubItem(climbName);
    setShowInfo(false);
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

    await apiSend("/api/ascents", {
      body: { wallId: activeClimb.wallId, climbName: activeClimb.setterName, ...fields },
    });
    climbsFetch.retry();
  };

  const handleDeleteComment = async (ascentId) => {
    if (!currentUser) return;

    await apiSend(`/api/users/${encodeURIComponent(currentUser.username)}/ascents/${ascentId}/comment`, {
      method: "DELETE",
    });
    climbsFetch.retry();
  };

  const content = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeScreen onSelectUser={handleSelectLeaderboardUser} />;
      case "list": {
        if (creatingClimb) {
          if (selectedListItem) {
            // The reset date for the wall being added to — every current
            // climb on that wall shares the same setDate for its "reset"
            // entry, so the first one found is enough.
            const wallClimbs = climbsByWall?.[selectedListItem.id] || [];
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
          return (
            <ClimbsFilterForm
              sortBy={climbSortBy}
              onSortByChange={setClimbSortBy}
              showResetClimbs={showResetClimbs}
              onShowResetClimbsChange={setShowResetClimbs}
              showBackfillClimbs={showBackfillClimbs}
              onShowBackfillClimbsChange={setShowBackfillClimbs}
            />
          );
        }
        if (activeClimb && showInfo) {
          return (
            <ClimbInfoScreen
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
              key={`${viewingArchivedClimb.wallId}::${viewingArchivedClimb.setterName}`}
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
            climbsError={climbsFetch.error}
            onRetryClimbs={climbsFetch.retry}
            onSelectItem={handleSelectListItem}
            onSelectSubItem={handleSelectSubItem}
            archiveExpanded={archiveExpanded}
            archiveWalls={archiveWalls}
            onToggleArchive={handleToggleArchive}
            onSelectArchiveWall={setViewingArchiveWallId}
            onOpenFilter={() => setFilteringClimbs(true)}
            climbSortBy={climbSortBy}
            showResetClimbs={showResetClimbs}
            showBackfillClimbs={showBackfillClimbs}
          />
        );
      }
      case "search":
        if (topSearchEntry?.kind === "list") {
          return (
            <FollowListScreen
              username={topSearchEntry.username}
              type={topSearchEntry.listType}
              onSelectUser={handlePushProfile}
            />
          );
        }
        if (viewingSearchUser) {
          return (
            <UserProfileScreen
              user={viewingSearchUser}
              currentUser={currentUser}
              onFollow={() => handleFollowToggle(viewingSearchUser.username, true)}
              onUnfollow={() => handleFollowToggle(viewingSearchUser.username, false)}
              onViewFollowers={() => handlePushFollowList(viewingSearchUser.username, "followers")}
              onViewFollowing={() => handlePushFollowList(viewingSearchUser.username, "following")}
            />
          );
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
      case "grades":
        return currentUser?.isAdmin ? <GradesScreen /> : null;
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
    showInfo,
    showSettings,
    settingsOption,
    viewingArchivedClimb,
    archiveExpanded,
    archiveWalls,
    viewingArchiveWallId,
    creatingClimb,
    filteringClimbs,
    climbSortBy,
    showResetClimbs,
    showBackfillClimbs,
    climbs,
    searchStack,
    searchQuery,
    searchMode,
    searchUserResults,
  ]);

  // Approve, Grades, and Admin only show up in the tab bar (and their titles
  // only resolve) for accounts with the matching role — see
  // APPROVE_TAB/GRADES_TAB/ADMIN_TAB.
  const visibleTabs = [
    ...TABS,
    ...(currentUser?.isModerator || currentUser?.isSetter ? [APPROVE_TAB] : []),
    ...(currentUser?.isAdmin ? [GRADES_TAB, ADMIN_TAB] : []),
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
  } else if (activeTab === "list" && activeClimb && showInfo) {
    topBarTitle = "Info";
    showBack = true;
    handleBack = () => setShowInfo(false);
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
  } else if (activeTab === "search" && topSearchEntry?.kind === "list") {
    topBarTitle = topSearchEntry.listType === "followers" ? "Followers" : "Following";
    showBack = true;
    handleBack = handlePopSearchStack;
  } else if (activeTab === "search" && viewingSearchUser) {
    topBarTitle = viewingSearchUser.username;
    showBack = true;
    handleBack = handlePopSearchStack;
  } else if (activeTab === "profile" && showSettings && settingsOption) {
    topBarTitle = SETTINGS_OPTIONS.find((o) => o.id === settingsOption)?.label ?? "Settings";
    showBack = true;
    handleBack = () => setSettingsOption(null);
  } else if (activeTab === "profile" && showSettings) {
    topBarTitle = "Settings";
    showBack = true;
    handleBack = () => setShowSettings(false);
  }

  const showInfoButton = activeTab === "list" && Boolean(activeClimb) && !showInfo;

  const isClimbDetail = activeTab === "list" && Boolean(activeClimb) && !showInfo;

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
        showInfoButton={showInfoButton}
        onShowInfo={() => setShowInfo(true)}
        showAddButton={showAddButton}
        addButtonLabel={isWallsRoot ? "Add wall" : "Add climb"}
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
    display: "flex",
    alignItems: "center",
    gap: 1,
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
  followButton: {
    width: "100%",
    background: "none",
    border: "none",
    borderBottom: "1px solid var(--color-accent-bright)",
    borderRadius: 0,
    padding: "6px 0",
    color: "var(--color-accent-bright)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    font: "inherit",
  },
  profileStat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
  },
  profileStatButton: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    font: "inherit",
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
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    font: "inherit",
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
  gradeBarSkeleton: {
    background: "var(--color-border)",
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
  asyncError: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: "24px 20px",
  },
  retryButton: {
    padding: "8px 20px",
    borderRadius: 8,
    border: "1px solid var(--color-border-strong)",
    background: "var(--color-surface-4)",
    color: "var(--color-text-primary)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
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
    // visibility is listed alongside transform so the sheet stays visible
    // for the duration of the close animation instead of vanishing
    // mid-slide, while still leaving the tab order once fully closed
    // (transform alone doesn't remove hidden elements from it — §14.13 part 3).
    transition: "transform 0.28s ease, visibility 0.28s",
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
