// Walls come from GET /api/walls now (§13.8-e), not a hardcoded constant —
// this is the one derivation every screen that labels a wallId needs, kept
// in one place rather than duplicated in each of them.
export function buildWallNameById(walls) {
  return Object.fromEntries((walls || []).map((wall) => [wall.id, wall.name]));
}
