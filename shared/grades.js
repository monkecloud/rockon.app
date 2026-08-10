// Canonical V-grade definitions, shared between src/App.jsx and
// server/worker.js so the two never drift apart — see APP_REFERENCE.md
// §14.19 for why this module exists. The dangerous drift this closes: the
// client's composeSetterGrade *writes* the "V2-4" range format and the
// server's climbBucketGrade *parses* it back apart; before this module
// those were two independent implementations with nothing tying them
// together.
//
// Node ESM needs the explicit ".js" extension on relative imports; Vite
// tolerates its absence, so always import this as "shared/grades.js" (or
// "../shared/grades.js" etc.), never without the extension.

// The pickable list for grade dropdowns (New Climb, Log Ascent, grade
// confirmation, ...) — VB through V11, single grades only (no "V10+").
export const GRADE_OPTIONS = ["VB", ...Array.from({ length: 12 }, (_, n) => `V${n}`)];

// The chart-bucket list — VB through V9, then a "V10+" catch-all bucket for
// anything at or above V10. Used by every grade-pyramid/distribution chart.
export const GRADE_BUCKETS = ["VB", ...Array.from({ length: 10 }, (_, n) => `V${n}`), "V10+"];

// Buckets a grade string ("V4", "vb", "V11") into one of GRADE_BUCKETS, or
// null if it doesn't parse as a V-grade. The single primitive every other
// bucketing helper below is built on.
export function gradeToBucket(grade) {
  if (!grade) return null;
  const trimmed = grade.trim().toUpperCase();
  if (trimmed === "VB") return "VB";

  const match = trimmed.match(/^V(\d+)$/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  return n >= 10 ? "V10+" : `V${n}`;
}

// Buckets a list of raw grade strings into GRADE_BUCKETS counts, in bucket
// order — the shape every grade-pyramid chart wants. Unparseable/blank
// grades are silently skipped.
export function bucketCounts(grades) {
  const counts = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));
  for (const raw of grades) {
    const bucket = gradeToBucket(raw);
    if (bucket) counts[bucket] += 1;
  }
  return GRADE_BUCKETS.map((grade) => ({ grade, count: counts[grade] }));
}

// A climb's grade for pyramid-bucketing purposes: the confirmed grade if it
// has one, otherwise its setterGrade — bucketed by the top end of a range
// (e.g. "V2-4" buckets as V4) since that's the harder, more conservative
// read of the setter's guess.
export function climbBucketGrade(climb) {
  if (climb.grade) return climb.grade;
  const setterGrade = climb.setterGrade || "";
  const dashIndex = setterGrade.indexOf("-");
  return dashIndex === -1 ? setterGrade : `V${setterGrade.slice(dashIndex + 1)}`;
}

// The grade text a climb row shows: confirmed grade if set, otherwise its
// setterGrade range/guess as-is (e.g. "V2-4", not collapsed to one end).
export function climbDisplayGrade(climb) {
  return climb.grade || climb.setterGrade;
}

// A setter's rough grade guess at set time is a bottom/top pair (e.g. "V2"
// to "V4") — collapsed into the single string stored as a climb's
// setterGrade: just the grade itself when bottom and top match ("V6"), or
// "V2-4"/"V3-4" style when they don't. Inverse of parseSetterGrade below.
export function composeSetterGrade(bottom, top) {
  if (bottom === top) return bottom;
  return `${bottom}-${top.replace(/^V/, "")}`;
}

// Parses a setterGrade string back into its {bottom, top} GRADE_OPTIONS
// pair, or null if it isn't a well-formed single grade or "V<n>-<n>" range
// (unknown grade, top < bottom, garbage input, ...). Inverse of
// composeSetterGrade — used to validate POST /api/climbs's setterGrade
// server-side (§14.17e).
export function parseSetterGrade(s) {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  const dashIndex = trimmed.indexOf("-");

  if (dashIndex === -1) {
    return GRADE_OPTIONS.includes(trimmed) ? { bottom: trimmed, top: trimmed } : null;
  }

  const bottom = trimmed.slice(0, dashIndex);
  const top = `V${trimmed.slice(dashIndex + 1)}`;
  if (!GRADE_OPTIONS.includes(bottom) || !GRADE_OPTIONS.includes(top)) return null;
  if (GRADE_OPTIONS.indexOf(bottom) > GRADE_OPTIONS.indexOf(top)) return null;

  return { bottom, top };
}
