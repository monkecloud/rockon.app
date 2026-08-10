import { climbBucketGrade } from "../../shared/grades.js";

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
