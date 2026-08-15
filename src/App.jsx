import { useEffect, useMemo, useState } from "react";
import { TABS, LOGGED_OUT_PROFILE_TAB, ADMIN_TAB, GRADES_TAB, APPROVE_TAB, SETTINGS_OPTIONS } from "./constants.js";
import { STORAGE_KEYS, loadFromStorage, saveToStorage } from "./lib/storage.js";
import { apiSend, useFetch } from "./lib/fetch.js";
import { buildWallNameById } from "./lib/walls.js";
import { styles } from "./styles.js";
import { TopBar } from "./components/TopBar.jsx";
import { ClimbActionBar } from "./components/ClimbActionBar.jsx";
import { ZoomableImageViewer } from "./components/ZoomableImageViewer.jsx";
import { climbTitleNode } from "./components/ClimbGradeLabel.jsx";
import { LogAscentSheet } from "./components/LogAscentSheet.jsx";
import { HomeScreen } from "./screens/HomeScreen.jsx";
import { ListScreen, ArchiveWallScreen } from "./screens/ListScreen.jsx";
import { SearchScreen } from "./screens/SearchScreen.jsx";
import { UserProfileScreen } from "./screens/UserProfileScreen.jsx";
import { FollowListScreen } from "./screens/FollowListScreen.jsx";
import { ClimbInfoScreen } from "./screens/ClimbInfoScreen.jsx";
import { ClimbsFilterForm } from "./screens/ClimbsFilterForm.jsx";
import { NewClimbForm } from "./screens/NewClimbForm.jsx";
import { NewWallForm } from "./screens/NewWallForm.jsx";
import { ProfileScreen } from "./screens/ProfileScreen.jsx";
import { SavedClimbsScreen } from "./screens/SavedClimbsScreen.jsx";
import {
  SettingsScreen,
  ChangeAvatarForm,
  ChangeUsernameForm,
  ChangeNameForm,
  ChangePasswordForm,
} from "./screens/SettingsScreen.jsx";
import { ManageRolesScreen } from "./screens/ManageRolesScreen.jsx";
import { GradesScreen } from "./screens/GradesScreen.jsx";
import { ApproveClimbsScreen } from "./screens/ApproveClimbsScreen.jsx";

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
//
// Screens/components live in src/screens/ and src/components/; shared
// state/constants in src/constants.js, src/lib/, src/styles.js (§14.16).
// This file is App() only: navigation state, handlers, and the persistent
// chrome (top bar, tab bar, climb action bar, log-ascent sheet).
// ---------------------------------------------------------------------------

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
  const [showSavedClimbs, setShowSavedClimbs] = useState(false);
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
  // any backfills on top of it — see currentClimbsOnly in server/worker.js)
  // and merges in ascent-derived stats and user comments. Climbs have no
  // id of their own, so climbsByWall groups them by wallId, and a climb is
  // looked up within that group by its (wall-unique) name. Re-fetched after
  // logging an ascent so a newly-added comment shows up immediately (see
  // handleSubmitAscent below).
  const climbsFetch = useFetch("/api/climbs");
  const climbs = climbsFetch.data?.climbs ?? null;

  // Walls (§13.8-e) — the walls table replaced the hardcoded WALLS constant
  // server-side back in §14.3, but the frontend kept its own copy in
  // src/constants.js until now. Fetched once here, same as climbs, and
  // threaded down to whatever needs a wall's name from its id.
  const wallsFetch = useFetch("/api/walls");
  const walls = wallsFetch.data?.walls ?? null;
  const wallNameById = useMemo(() => buildWallNameById(walls), [walls]);

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

  const handleOpenSavedClimbs = () => setShowSavedClimbs(true);

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
    setSelectedListItem({ id: climb.wallId, title: wallNameById[climb.wallId] ?? "" });
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
      setShowSavedClimbs(false);
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

    // Most archived climbs are view-only and being signed out both disable
    // the Log Ascent button (see ClimbActionBar's disabled/logDisabled
    // props below), so this shouldn't be reachable, but guard against it as
    // defense in depth. The most recent archived reset+backfill per wall
    // stays loggable (climb.loggable, set by GET /api/archive), same as a
    // current climb.
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
          return <NewWallForm walls={walls} onSave={handleCreateClimb} />;
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
            walls={walls}
            wallsError={wallsFetch.error}
            onRetryWalls={wallsFetch.retry}
            climbsByWall={climbsByWall}
            climbsError={climbsFetch.error}
            onRetryClimbs={climbsFetch.retry}
            onSelectItem={handleSelectListItem}
            onSelectSubItem={handleSelectSubItem}
            archiveExpanded={archiveExpanded}
            archiveWalls={archiveWalls}
            archiveError={archiveFetch.error}
            onRetryArchive={archiveFetch.retry}
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
        if (currentUser && showSavedClimbs) {
          return <SavedClimbsScreen />;
        }
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
            onOpenSavedClimbs={handleOpenSavedClimbs}
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
    walls,
    climbsByWall,
    showInfo,
    showSettings,
    settingsOption,
    showSavedClimbs,
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
  // APPROVE_TAB/GRADES_TAB/ADMIN_TAB. Signed out, the "profile" tab swaps to
  // LOGGED_OUT_PROFILE_TAB ("Login") since there's no profile to show.
  const visibleTabs = [
    ...TABS.map((tab) => (tab.id === "profile" && !currentUser ? LOGGED_OUT_PROFILE_TAB : tab)),
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
    topBarTitle = wallNameById[viewingArchiveWallId] ?? "Archive";
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
  } else if (activeTab === "profile" && showSavedClimbs) {
    topBarTitle = "Saved Climbs";
    showBack = true;
    handleBack = () => setShowSavedClimbs(false);
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
          logDisabled={!currentUser}
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
