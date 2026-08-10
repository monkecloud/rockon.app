import { Home, ListChecks, Search, User, Shield, Check, Tag } from "lucide-react";

export const TABS = [
  { id: "home", label: "Home", icon: Home },
  { id: "list", label: "Walls", icon: ListChecks },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Profile", icon: User },
];

// Appended to TABS (as the rightmost tab) only when currentUser.isAdmin —
// see the visibleTabs computation in App().
export const ADMIN_TAB = { id: "admin", label: "Admin", icon: Shield };

// Appended for admins only — grade confirmation used to be moderator/setter
// facing (under the "Approve" label/slot this now took over), but is now
// gated to admins. See the visibleTabs computation in App().
export const GRADES_TAB = { id: "grades", label: "Grades", icon: Check };

// Appended for moderators/setters (admins too, since they keep every
// moderator/setter capability) — the queue of pending climb-naming-rights
// proposals from ascent claims (see pendingNames in server/worker.js),
// taking over the "Approve" label/slot the grade-confirmation tab used to
// have. See the visibleTabs computation in App().
export const APPROVE_TAB = { id: "approve", label: "Approve", icon: Tag };

// The 4 walls. Climbs themselves (name, grade, comments) are fetched
// from the server at /api/climbs — see server/climbs.json — and grouped by
// wallId; climb counts aren't hardcoded here since which climbs are
// "current" on a wall changes as sets are reset/backfilled server-side.
export const WALLS = [
  { id: 1, name: "Back" },
  { id: 2, name: "Slab" },
  { id: 3, name: "Cave" },
  { id: 4, name: "Front" },
];

export const LIST_ITEMS = WALLS.map((wall) => ({ id: wall.id, title: wall.name }));

export const WALL_NAME_BY_ID = Object.fromEntries(WALLS.map((wall) => [wall.id, wall.name]));

// Podium block heights, tallest in the middle (1st place) — left-to-right
// display order is 2nd/1st/3rd, the standard podium arrangement.
export const PODIUM_HEIGHTS = { 1: 64, 2: 44, 3: 30 };

export const SETTINGS_OPTIONS = [
  { id: "avatar", label: "Change profile picture" },
  { id: "username", label: "Change username" },
  { id: "name", label: "Change name" },
  { id: "password", label: "Change password" },
];

export const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "moderator", label: "Moderator" },
  { value: "setter", label: "Setter" },
  { value: "admin", label: "Admin" },
];
