import { GRADE_OPTIONS } from "../../shared/grades.js";
import { styles } from "../styles.js";

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
