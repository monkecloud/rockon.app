import { GRADE_OPTIONS } from "../../shared/grades.js";
import { useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";

// Placeholder columns for GradeBarChart's loading skeleton — same count as
// GRADE_OPTIONS so the skeleton's width/gaps match the real chart closely
// enough that nothing visibly reflows once data arrives.
const GRADE_CHART_SKELETON_COLUMNS = Array.from({ length: GRADE_OPTIONS.length }, (_, i) => i);

// A grade pyramid — how many things fall in each V-grade bucket (VB,
// V0-V9, V10+). Takes either pre-computed `counts` (when the data is
// already in memory, e.g. a wall's climbs) or an `endpoint` to fetch them
// from. The Home tab points this at GET /api/climbs/grade-counts
// (currently active climbs); the Profile tab points it at
// GET /api/users/:username/grade-counts (that user's logged ascents,
// preferring the grade typed on the ascent and falling back to the
// climb's own bucket grade when that was left blank).
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
