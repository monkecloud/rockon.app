import { useMemo, useState } from "react";
import { ChevronRight, Filter } from "lucide-react";
import { bucketCounts, climbBucketGrade, climbDisplayGrade } from "../../shared/grades.js";
import { matchesClimbQuery, sortClimbs } from "../lib/climbs.js";
import { buildWallNameById } from "../lib/walls.js";
import { styles } from "../styles.js";
import { GradeBarChart } from "../components/GradeBarChart.jsx";
import { StarRatingDisplay } from "../components/StarRatingDisplay.jsx";
import { ZoomableImageViewer } from "../components/ZoomableImageViewer.jsx";
import { climbTitleNode } from "../components/ClimbGradeLabel.jsx";

export function ListScreen({
  selectedItem,
  selectedSubItem,
  walls,
  wallsError,
  onRetryWalls,
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
  const wallNameById = useMemo(() => buildWallNameById(walls), [walls]);

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
        {wallsError ? (
          <div style={styles.asyncError}>
            <p style={styles.formError} role="alert">{wallsError}</p>
            <button type="button" style={styles.retryButton} onClick={onRetryWalls}>
              Retry
            </button>
          </div>
        ) : walls === null ? (
          <p style={styles.placeholderText}>Loading walls…</p>
        ) : (
          walls.map((wall) => (
            <button
              key={wall.id}
              style={styles.wallRow}
              onClick={() => onSelectItem({ id: wall.id, title: wall.name })}
            >
              <div>
                <p style={styles.listTitle}>{wall.name}</p>
                <p style={styles.listMeta}>{(climbsByWall?.[wall.id] || []).length} climbs</p>
              </div>
              <ChevronRight size={18} color="var(--color-text-muted)" />
            </button>
          ))
        )}
        <ArchiveSection
          expanded={archiveExpanded}
          walls={archiveWalls}
          wallNameById={wallNameById}
          error={archiveError}
          onRetry={onRetryArchive}
          onToggle={onToggleArchive}
          onSelectWall={onSelectArchiveWall}
        />
      </div>
    </div>
  );
}

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
export function ArchiveSection({ expanded, walls, wallNameById, error, onRetry, onToggle, onSelectWall }) {
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
                  {wallNameById[wall.wallId] ?? `Wall ${wall.wallId}`}
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
