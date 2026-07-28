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
//   and back. Climb data (name, difficulty, comments) is fetched from the
//   server (GET /api/climbs, backed by server/climbs.json — see that file
//   to add/edit climbs). The Climb detail page has a full-height
//   zoomable/pannable placeholder image (pinch, scroll-wheel, and drag all
//   work), with a secondary bar pinned below the persistent top bar
//   showing the climb's difficulty and name. A message-circle icon in the
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

// The 4 walls. Climbs themselves (name, difficulty, comments) are fetched
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

function HomeScreen() {
  return (
    <div style={styles.screen}>
      <GradeBarChart title="Climbs on the wall" endpoint="/api/climbs/grade-counts" />
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
function ZoomableImageViewer({ title, subtitle }) {
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
        <div ref={imageRef} style={styles.imagePlaceholder}>
          <ImageIcon size={56} color="#5A5A56" strokeWidth={1.5} />
        </div>
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
}) {
  const [climbSearch, setClimbSearch] = useState("");

  if (selectedItem && selectedSubItem) {
    const climb = (climbsByWall[selectedItem.id] || []).find((c) => c.name === selectedSubItem);
    const title = climb ? `${climb.difficulty} · ${climb.name}` : "Loading…";
    const subtitle = climb ? `Set by ${climb.setter}` : undefined;

    return <ZoomableImageViewer title={title} subtitle={subtitle} />;
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
            counts={bucketGradeCounts(climbs.map((c) => c.difficulty))}
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
          <button type="button" style={styles.climbsFilterButton}>
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
                  <span style={styles.climbDifficulty}>{climb.difficulty}</span>
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
            <ChevronRight size={18} color="#6A6A66" />
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
          color="#6A6A66"
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
              <ChevronRight size={18} color="#6A6A66" />
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
              <span style={styles.climbDifficulty}>{climb.difficulty}</span>
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

// Opened from the "+" button on the Climbs page (moderators only). Not
// wired up to anything yet — just the page shell and placeholder fields
// for whatever a real create-a-climb form ends up needing.
function NewClimbForm({ resetDate }) {
  const [photo, setPhoto] = useState("");
  const [isBackfill, setIsBackfill] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(todayStr);
  // Not backfilling: the climb is part of the wall's current reset, so its
  // date is that reset's date, not user-editable — hence no Date field.
  const effectiveDate = isBackfill ? date : resetDate;

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setPhoto(reader.result);
    reader.readAsDataURL(file);
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={(e) => e.preventDefault()}>
        {photo ? (
          <img src={photo} alt="" style={styles.avatarPreview} />
        ) : (
          <div style={styles.avatarPreviewPlaceholder}>
            <Camera size={28} color="#5A5A56" strokeWidth={1.5} />
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
          <input style={styles.input} type="text" placeholder="e.g. Golden Overhang" />
        </label>
        <label style={styles.label}>
          Grade
          <input style={styles.input} type="text" placeholder="e.g. V4" />
        </label>
        <label style={styles.label}>
          Setter
          <input style={styles.input} type="text" placeholder="e.g. Alex" />
        </label>
        <label style={styles.checkboxRow}>
          <input
            style={styles.checkboxInput}
            type="checkbox"
            checked={isBackfill}
            onChange={(e) => {
              const checked = e.target.checked;
              setIsBackfill(checked);
              if (checked) setDate(todayStr);
            }}
          />
          Backfill
        </label>
        <label style={styles.label}>
          Date
          <input
            style={isBackfill ? styles.input : { ...styles.input, ...styles.inputDisabled }}
            type="date"
            value={effectiveDate || ""}
            disabled={!isBackfill}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button type="button" style={styles.button}>
          Save
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

// A grade pyramid — how many things fall in each V-grade bucket (VB,
// V0-V9, V10+). Takes either pre-computed `counts` (when the data is
// already in memory, e.g. a wall's climbs) or an `endpoint` to fetch them
// from. The Home tab points this at GET /api/climbs/grade-counts
// (currently active climbs); the Profile tab points it at
// GET /api/users/:username/grade-counts (that user's logged ascents,
// preferring the grade typed on the ascent and falling back to the
// climb's own difficulty when that was left blank).
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
            <ChevronRight size={18} color="#6A6A66" />
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
            <Camera size={28} color="#5A5A56" strokeWidth={1.5} />
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
            color={isFull || isHalf ? "#F5C518" : "#4A4A46"}
            fill={isFull || isHalf ? "#F5C518" : "none"}
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

function LogAscentSheet({ open, attemptsThisSession, currentGrade, onClose, onSubmit }) {
  const [starRating, setStarRating] = useState(0);
  const [attempts, setAttempts] = useState(attemptsThisSession);
  const [grade, setGrade] = useState(currentGrade || "VB");
  const [comment, setComment] = useState("");
  const [showValidation, setShowValidation] = useState(false);

  useEffect(() => {
    if (open) {
      setStarRating(0);
      setAttempts(attemptsThisSession);
      setGrade(currentGrade || "VB");
      setComment("");
      setShowValidation(false);
    }
  }, [open, attemptsThisSession, currentGrade]);

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
  const [attempts, setAttempts] = useState(0);
  const [showLogAscentSheet, setShowLogAscentSheet] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOption, setSettingsOption] = useState(null);

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
  const handleLogout = () => setCurrentUser(null);

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
  };

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
      return;
    }
    if (tabId === activeTab && tabId === "profile") {
      setShowSettings(false);
      setSettingsOption(null);
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
          username: currentUser.username,
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
          // The reset date for the wall being added to — every current
          // climb on that wall shares the same setDate for its "reset"
          // entry, so the first one found is enough.
          const wallClimbs = climbsByWall[selectedListItem?.id] || [];
          const resetDate =
            wallClimbs.find((c) => c.setType === "reset")?.setDate ??
            wallClimbs[0]?.setDate ??
            "";
          return <NewClimbForm resetDate={resetDate} />;
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
          const title = `${viewingArchivedClimb.difficulty} · ${viewingArchivedClimb.name}`;
          const subtitle = `Set by ${viewingArchivedClimb.setter}`;
          return <ZoomableImageViewer title={title} subtitle={subtitle} />;
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
          />
        );
      }
      case "search":
        return <PlaceholderScreen title="Search" />;
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
  ]);

  const tabTitle = TABS.find((tab) => tab.id === activeTab)?.label ?? "";
  let topBarTitle = tabTitle;
  let showBack = false;
  let handleBack = () => {};

  if (activeTab === "list" && creatingClimb) {
    topBarTitle = "New Climb";
    showBack = true;
    handleBack = () => setCreatingClimb(false);
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
  // Archive's own climb page. Only moderators get the add button here —
  // there's no create-a-wall/reset flow wired up behind it yet.
  const isWallsRoot =
    activeTab === "list" &&
    !selectedListItem &&
    !viewingArchivedClimb &&
    !viewingArchiveWallId;
  // A wall's Climbs list (selectedListItem set, no climb drilled into yet).
  const isClimbsList =
    activeTab === "list" && Boolean(selectedListItem) && !selectedSubItem && !creatingClimb;
  const showAddButton = (isWallsRoot || isClimbsList) && Boolean(currentUser?.isModerator);

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
          if (isClimbsList) setCreatingClimb(true);
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
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabPress(tab.id)}
                style={{
                  ...styles.tabButton,
                  color: isActive ? "#3ECFA0" : "#7A7A76",
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
          currentGrade={activeClimb?.difficulty}
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
    background: "#000000",
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
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
    background: "#181818",
    borderBottom: "1px solid #2E2E2C",
    flexShrink: 0,
  },
  topBarTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: "#F2F1EE",
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
    color: "#F2F1EE",
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
    background: "#151515",
    borderBottom: "1px solid #2E2E2C",
  },
  secondaryBarPlaceholder: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.5,
    color: "#C9C9C4",
    textTransform: "uppercase",
  },
  secondaryBarSubtitle: {
    fontSize: 11,
    color: "#8F8F8A",
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
    background: "#141414",
    touchAction: "none",
  },
  imagePlaceholder: {
    width: "78%",
    maxWidth: 320,
    aspectRatio: "3 / 4",
    borderRadius: 16,
    background: "linear-gradient(155deg, #232320 0%, #181816 100%)",
    border: "1px solid #33332F",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    userSelect: "none",
    willChange: "transform",
  },
  button: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 10,
    border: "none",
    background: "#1D9E75",
    color: "#0B0B0A",
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
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 12,
    padding: "14px 16px",
  },
  listRowLink: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    textAlign: "left",
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
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
    background: "#1C1C1C",
    border: "none",
    borderBottom: "1px solid #2E2E2C",
    borderRadius: 0,
    padding: "14px 16px",
    cursor: "pointer",
    font: "inherit",
  },
  archiveBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    flexShrink: 0,
    textAlign: "left",
    background: "#151515",
    border: "none",
    borderTop: "1px solid #2E2E2C",
    borderRadius: 0,
    padding: "14px 16px",
    color: "#C9C9C4",
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
    background: "#101010",
    border: "none",
    borderTop: "1px solid #2E2E2C",
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
    background: "#1C1C1C",
    border: "none",
    borderBottom: "1px solid #2E2E2C",
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
    color: "#F2F1EE",
  },
  climbStars: {
    fontSize: 12,
    lineHeight: 1,
  },
  climbAscents: {
    fontSize: 12,
    color: "#8F8F8A",
  },
  climbTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "#F2F1EE",
  },
  climbSetter: {
    fontSize: 12,
    color: "#8F8F8A",
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
    color: "#F2F1EE",
    margin: 0,
  },
  commentDeleteButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "#8F8F8A",
    cursor: "pointer",
    padding: 2,
  },
  commentText: {
    fontSize: 14,
    color: "#C9C9C4",
    lineHeight: 1.5,
    margin: 0,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: "#F2F1EE",
    margin: "0 0 4px",
  },
  listMeta: {
    fontSize: 13,
    color: "#8F8F8A",
    margin: 0,
  },
  placeholderText: {
    fontSize: 15,
    color: "#8F8F8A",
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
    background: "#1D9E75",
    color: "#0B0B0A",
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
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
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
    border: "1px solid #2E2E2C",
    background: "transparent",
    color: "#E4E3DF",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
  },
  profileUsername: {
    fontSize: 16,
    fontWeight: 600,
    color: "#F2F1EE",
    margin: 0,
  },
  profileDisplayName: {
    fontSize: 13,
    color: "#8F8F8A",
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
    borderBottom: "1px solid #2E2E2C",
    borderRadius: 0,
    padding: "6px 0",
    color: "#C9C9C4",
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
    color: "#F2F1EE",
  },
  profileStatLabel: {
    fontSize: 12,
    color: "#8F8F8A",
  },
  gradeChartWrapper: {
    marginBottom: 20,
  },
  gradeChartTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#C9C9C4",
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
  gradeBarColumn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  gradeBarCount: {
    fontSize: 9,
    color: "#8F8F8A",
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
      "linear-gradient(#2E2E2C, #2E2E2C), linear-gradient(#2E2E2C, #2E2E2C), linear-gradient(#2E2E2C, #2E2E2C), linear-gradient(#2E2E2C, #2E2E2C)",
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
    background: "#1D9E75",
    borderRadius: "3px 3px 0 0",
  },
  gradeBarLabel: {
    fontSize: 9,
    color: "#8F8F8A",
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
    color: "#6A6A66",
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
    borderTop: "1px solid #2E2E2C",
    background: "transparent",
    color: "#E4E3DF",
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
    borderBottom: "1px solid #2E2E2C",
    background: "transparent",
    color: "#E4E3DF",
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
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
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
    color: "#8F8F8A",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  modeButtonActive: {
    background: "#2A2A28",
    color: "#F2F1EE",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    color: "#8F8F8A",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#8F8F8A",
  },
  checkboxInput: {
    width: 18,
    height: 18,
    accentColor: "#1D9E75",
  },
  input: {
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "#F2F1EE",
    outline: "none",
  },
  climbsFilterRow: {
    display: "flex",
    gap: 8,
    marginBottom: 20,
  },
  climbsFilterInput: {
    flex: 1,
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "#F2F1EE",
    outline: "none",
  },
  climbsFilterButton: {
    width: 42,
    height: 42,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 10,
    color: "#C9C9C4",
    cursor: "pointer",
  },
  inputInvalid: {
    border: "1px solid #E4685C",
  },
  inputDisabled: {
    color: "#6A6A66",
    cursor: "not-allowed",
  },
  formError: {
    fontSize: 13,
    color: "#E4685C",
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
    background: "#181818",
    borderTop: "1px solid #2E2E2C",
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
    background: "#181818",
    borderTop: "1px solid #2E2E2C",
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
    border: "1px solid #2E2E2C",
    background: "#1C1C1C",
    color: "#F2F1EE",
    cursor: "pointer",
  },
  climbActionSideButtonDisabled: {
    color: "#4A4A46",
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
    color: "#8F8F8A",
  },
  attemptsCounterDisabled: {
    color: "#4A4A46",
  },
  logAscentButton: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 10,
    border: "none",
    background: "#1D9E75",
    color: "#0B0B0A",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  logAscentButtonDisabled: {
    background: "#2E2E2C",
    color: "#6A6A66",
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
    background: "#181818",
    borderTop: "1px solid #2E2E2C",
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
    background: "#3A3A36",
    margin: "0 auto 16px",
  },
  sheetForm: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  sheetSessionAttempts: {
    fontSize: 13,
    color: "#8F8F8A",
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
    border: "1px solid #E4685C",
  },
  textarea: {
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "#F2F1EE",
    outline: "none",
    resize: "none",
    font: "inherit",
  },
};
