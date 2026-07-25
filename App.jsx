import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Home,
  ListChecks,
  Search,
  User,
  LogOut,
  ChevronRight,
  ArrowLeft,
  Image as ImageIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Boilerplate mobile-style web app
// - Persistent top bar showing the current screen's title, with a back
//   button when drilled into a list item
// - 4 tabs, persistent bottom bar with icon + label
// - Home tab: shows a random line of text, with a "shuffle" action
// - Walls tab (bottom bar label): a scrollable list of "walls", each
//   drilling into its own "Climbs" list, each of which drills into a
//   "Climb" detail page. Top bar title reflects the current level
//   (Walls / Climbs / Climb); selection persists if you switch tabs away
//   and back. The Climb detail page has a full-height zoomable/pannable
//   placeholder image (pinch, scroll-wheel, and drag all work), with a
//   secondary bar pinned below the persistent top bar showing a
//   placeholder title ("V? Climb Name")
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

const RANDOM_LINES = [
  "The tide only tells half the story.",
  "Somewhere, a kettle is about to whistle.",
  "Good ideas arrive disguised as distractions.",
  "Every map is a little bit of fiction.",
  "The quiet room remembers every conversation.",
  "Start before you feel ready.",
  "A shortcut is just a risk with confidence.",
  "Most doors open if you actually push.",
];

const LIST_ITEMS = [
  { id: 1, title: "Design the onboarding flow", meta: "Due tomorrow" },
  { id: 2, title: "Review pull request #128", meta: "Waiting on you" },
  { id: 3, title: "Write release notes", meta: "Due Friday" },
  { id: 4, title: "Sync with design team", meta: "Thu, 2:00 PM" },
  { id: 5, title: "Update dependency versions", meta: "No due date" },
  { id: 6, title: "Prep quarterly summary", meta: "Due next week" },
];

// Sample "detail" list shown when a list item is tapped. In a real app this
// would come from an API call keyed by the selected item's id.
const SUB_ITEMS_BY_ID = {
  1: [
    { id: "1-1", title: "Sketch welcome screen", meta: "In progress" },
    { id: "1-2", title: "Draft empty states", meta: "Not started" },
    { id: "1-3", title: "Get feedback from PM", meta: "Blocked" },
  ],
  2: [
    { id: "2-1", title: "Check test coverage", meta: "Done" },
    { id: "2-2", title: "Confirm naming conventions", meta: "In progress" },
    { id: "2-3", title: "Approve and merge", meta: "Waiting" },
  ],
  3: [
    { id: "3-1", title: "Collect changelog entries", meta: "Done" },
    { id: "3-2", title: "Write summary paragraph", meta: "In progress" },
    { id: "3-3", title: "Proofread", meta: "Not started" },
  ],
  4: [
    { id: "4-1", title: "Share latest mockups", meta: "Done" },
    { id: "4-2", title: "Walk through open questions", meta: "In progress" },
    { id: "4-3", title: "Agree on next steps", meta: "Not started" },
  ],
  5: [
    { id: "5-1", title: "Audit outdated packages", meta: "In progress" },
    { id: "5-2", title: "Run test suite", meta: "Not started" },
    { id: "5-3", title: "Deploy to staging", meta: "Not started" },
  ],
  6: [
    { id: "6-1", title: "Pull metrics from dashboard", meta: "Done" },
    { id: "6-2", title: "Draft summary slide", meta: "In progress" },
    { id: "6-3", title: "Share with team", meta: "Not started" },
  ],
};

// Sample details shown when a sub-item is tapped for a third level of
// drill-down. Again, stand-in for what a real API response might return.
const SUB_ITEM_DETAILS = {
  "1-1": { assignee: "Priya N.", priority: "High", notes: "Reference the brand style guide for colors and type." },
  "1-2": { assignee: "Priya N.", priority: "Medium", notes: "Cover the zero-results and error states first." },
  "1-3": { assignee: "Marcus T.", priority: "Medium", notes: "Book 30 minutes on the PM's calendar this week." },
  "2-1": { assignee: "Jordan K.", priority: "Low", notes: "Coverage report is in the CI artifacts tab." },
  "2-2": { assignee: "Jordan K.", priority: "Low", notes: "Check against the team's style guide." },
  "2-3": { assignee: "You", priority: "High", notes: "Waiting on one more approval before merging." },
  "3-1": { assignee: "Sam R.", priority: "Medium", notes: "Pull entries from closed PRs since last release." },
  "3-2": { assignee: "Sam R.", priority: "Medium", notes: "Keep it to three sentences, plain language." },
  "3-3": { assignee: "You", priority: "Low", notes: "Read out loud before publishing." },
  "4-1": { assignee: "Alex P.", priority: "Low", notes: "Latest exports are in the shared drive folder." },
  "4-2": { assignee: "Alex P.", priority: "Medium", notes: "Bring the two open spacing questions." },
  "4-3": { assignee: "You", priority: "Medium", notes: "Send a recap after the meeting." },
  "5-1": { assignee: "You", priority: "Medium", notes: "Flag anything with a major version bump." },
  "5-2": { assignee: "You", priority: "High", notes: "Run the full suite, not just changed files." },
  "5-3": { assignee: "You", priority: "Medium", notes: "Confirm staging env vars are up to date." },
  "6-1": { assignee: "Wei L.", priority: "Low", notes: "Export the last 90 days of data." },
  "6-2": { assignee: "Wei L.", priority: "Medium", notes: "Keep it to one slide, headline number first." },
  "6-3": { assignee: "You", priority: "Low", notes: "Post in the team channel, not just email." },
};

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

function HomeScreen() {
  const [line, setLine] = useState(
    () => RANDOM_LINES[Math.floor(Math.random() * RANDOM_LINES.length)]
  );

  const shuffle = () => {
    setLine((current) => {
      let next = current;
      while (next === current) {
        next = RANDOM_LINES[Math.floor(Math.random() * RANDOM_LINES.length)];
      }
      return next;
    });
  };

  return (
    <div style={styles.screen}>
      <div style={styles.quoteCard}>
        <p style={styles.quoteText}>{line}</p>
      </div>
      <button style={styles.button} onClick={shuffle}>
        Shuffle text
      </button>
    </div>
  );
}

// A full-height, zoomable/pannable image area with its own toolbar
// (zoom out / percentage / zoom in / reset) that stays pinned just below
// the persistent top bar. Uses the Pointer Events API so mouse drag,
// touch drag, and two-finger pinch all go through the same code path.
function ZoomableImageViewer() {
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
        <span style={styles.secondaryBarPlaceholder}>V? CLIMB NAME</span>
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

function ListScreen({ selectedItem, selectedSubItem, onSelectItem, onSelectSubItem }) {
  if (selectedItem && selectedSubItem) {
    const details = SUB_ITEM_DETAILS[selectedSubItem.id] || {};

    return (
      <div>
        <ZoomableImageViewer />
        <div style={styles.screen}>
          <p style={styles.listMeta}>{selectedSubItem.meta}</p>
          <div style={styles.detailCard}>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Assigned to</span>
              <span style={styles.detailValue}>{details.assignee ?? "Unassigned"}</span>
            </div>
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Priority</span>
              <span style={styles.detailValue}>{details.priority ?? "—"}</span>
            </div>
            <div style={styles.detailRowStacked}>
              <span style={styles.detailLabel}>Notes</span>
              <span style={{ ...styles.detailValue, textAlign: "left" }}>{details.notes ?? "No notes yet."}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (selectedItem) {
    const subItems = SUB_ITEMS_BY_ID[selectedItem.id] || [];

    return (
      <div style={styles.screen}>
        <p style={styles.listMeta}>{selectedItem.meta}</p>
        <div style={{ ...styles.list, marginTop: 16 }}>
          {subItems.map((sub) => (
            <button
              key={sub.id}
              style={styles.listRowLink}
              onClick={() => onSelectSubItem(sub)}
            >
              <div>
                <p style={styles.listTitle}>{sub.title}</p>
                <p style={styles.listMeta}>{sub.meta}</p>
              </div>
              <ChevronRight size={18} color="#6A6A66" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      <div style={styles.list}>
        {LIST_ITEMS.map((item) => (
          <button
            key={item.id}
            style={styles.listRowLink}
            onClick={() => onSelectItem(item)}
          >
            <div>
              <p style={styles.listTitle}>{item.title}</p>
              <p style={styles.listMeta}>{item.meta}</p>
            </div>
            <ChevronRight size={18} color="#6A6A66" />
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

function ProfileScreen({ currentUser, onSignup, onLogin, onLogout }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

    const action = mode === "signup" ? onSignup : onLogin;
    const result = await action({ username: trimmedUsername, password });

    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setUsername("");
    setPassword("");
  };

  if (currentUser) {
    const initials = currentUser.username.slice(0, 2).toUpperCase();

    return (
      <div style={styles.screen}>
        <div style={styles.profileCard}>
          <div style={styles.avatar}>{initials}</div>
          <p style={styles.profileName}>{currentUser.username}</p>
        </div>
        <button style={styles.logoutButton} onClick={onLogout}>
          <LogOut size={16} />
          Log out
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

function TopBar({ title, showBack, onBack }) {
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
      <div style={styles.topBarSpacer} />
    </header>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("home");
  const [selectedListItem, setSelectedListItem] = useState(null);
  const [selectedSubItem, setSelectedSubItem] = useState(null);

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
      return { success: true };
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

  const handleSelectListItem = (item) => {
    setSelectedListItem(item);
    setSelectedSubItem(null);
  };

  const content = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeScreen />;
      case "list":
        return (
          <ListScreen
            selectedItem={selectedListItem}
            selectedSubItem={selectedSubItem}
            onSelectItem={handleSelectListItem}
            onSelectSubItem={setSelectedSubItem}
          />
        );
      case "search":
        return <PlaceholderScreen title="Search" />;
      case "profile":
        return (
          <ProfileScreen
            currentUser={currentUser}
            onSignup={handleSignup}
            onLogin={handleLogin}
            onLogout={handleLogout}
          />
        );
      default:
        return null;
    }
  }, [activeTab, currentUser, selectedListItem, selectedSubItem]);

  const tabTitle = TABS.find((tab) => tab.id === activeTab)?.label ?? "";
  let topBarTitle = tabTitle;
  let showBack = false;
  let handleBack = () => {};

  if (activeTab === "list" && selectedListItem && selectedSubItem) {
    topBarTitle = "Climb";
    showBack = true;
    handleBack = () => setSelectedSubItem(null);
  } else if (activeTab === "list" && selectedListItem) {
    topBarTitle = "Climbs";
    showBack = true;
    handleBack = () => setSelectedListItem(null);
  }

  return (
    <div style={styles.app}>
      <TopBar
        title={topBarTitle}
        showBack={showBack}
        onBack={handleBack}
      />
      <div style={styles.content}>{content}</div>

      <nav style={styles.tabBar}>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
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
    background: "#121212",
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
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
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
  // 100vh minus the persistent top bar (~68px), this secondary toolbar
  // (~56px), and the bottom tab bar (~64px) — so the image fills exactly
  // the remaining screen height.
  imageStage: {
    height:
      "calc(100vh - 188px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
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
  quoteCard: {
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 14,
    padding: "28px 20px",
    marginBottom: 16,
    minHeight: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
  },
  quoteText: {
    fontSize: 17,
    lineHeight: 1.5,
    color: "#E4E3DF",
    margin: 0,
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
  detailCard: {
    marginTop: 16,
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 12,
    padding: "4px 16px",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 0",
    borderBottom: "1px solid #2E2E2C",
  },
  detailRowStacked: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "14px 0",
  },
  detailLabel: {
    fontSize: 13,
    color: "#8F8F8A",
  },
  detailValue: {
    fontSize: 14,
    color: "#F2F1EE",
    fontWeight: 500,
    textAlign: "right",
    lineHeight: 1.5,
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
  profileCard: {
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 14,
    padding: "28px 20px",
    marginBottom: 16,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
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
  profileName: {
    fontSize: 16,
    fontWeight: 600,
    color: "#F2F1EE",
    margin: 0,
  },
  profileEmail: {
    fontSize: 13,
    color: "#8F8F8A",
    margin: 0,
  },
  logoutButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "12px 16px",
    borderRadius: 10,
    border: "1px solid #2E2E2C",
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
  input: {
    background: "#1C1C1C",
    border: "1px solid #2E2E2C",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 15,
    color: "#F2F1EE",
    outline: "none",
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
};
