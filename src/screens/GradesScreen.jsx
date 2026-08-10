import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { GRADE_OPTIONS } from "../../shared/grades.js";
import { WALL_NAME_BY_ID } from "../constants.js";
import { apiSend, useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";

// Opened from the Grades tab (admin only). Lists every climb that's been
// superseded by a newer reset on its wall (see currentClimbsOnly
// server-side) but doesn't have a confirmed grade yet — i.e. exactly the
// climbs an admin is now allowed to lock in a final grade for, per the gate
// on POST /api/climbs/grade. Picking a grade and tapping the checkmark
// confirms it and drops the row from this list.
export function GradesScreen() {
  const { data: climbsData, loading, error: fetchError, retry } = useFetch("/api/climbs/needs-grade");
  const [climbs, setClimbs] = useState(null);
  const [error, setError] = useState("");
  const [gradeByKey, setGradeByKey] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    if (climbsData) setClimbs(climbsData.climbs || []);
  }, [climbsData]);

  const handleConfirmGrade = async (climb, key, grade) => {
    setSavingKey(key);
    setError("");
    const result = await apiSend("/api/climbs/grade", {
      body: { wallId: climb.wallId, setterName: climb.setterName, grade },
    });
    if (!result.success) {
      setError(result.error);
    } else {
      setClimbs((prev) =>
        prev.filter((c) => c.wallId !== climb.wallId || c.setterName !== climb.setterName)
      );
    }
    setSavingKey(null);
  };

  return (
    <div style={styles.screen}>
      {(error || fetchError) && <p style={styles.formError} role="alert">{error || fetchError}</p>}
      {climbs === null && loading && <p style={styles.placeholderText}>Loading…</p>}
      {climbs === null && fetchError && (
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      )}
      {climbs !== null && climbs.length === 0 && (
        <p style={styles.placeholderText}>No climbs waiting on a final grade.</p>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {(climbs || []).map((climb) => {
          const key = `${climb.wallId}::${climb.setterName}`;
          // A reasonable starting point for the dropdown: the bottom end of
          // the setter's original guess (e.g. "V2" out of "V2-4").
          const grade = gradeByKey[key] ?? climb.setterGrade.split("-")[0];

          return (
            <div key={key} style={styles.climbRow}>
              <div style={styles.climbRowLeft}>
                <span style={styles.climbTitle}>{climb.name}</span>
                <span style={styles.climbSetter}>
                  {WALL_NAME_BY_ID[climb.wallId] ?? `Wall ${climb.wallId}`} · Set by {climb.setter}
                </span>
                <span style={styles.climbSetter}>Setter grade: {climb.setterGrade}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <select
                  style={{ ...styles.input, width: "auto" }}
                  value={grade}
                  disabled={savingKey === key}
                  onChange={(e) =>
                    setGradeByKey((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                >
                  {GRADE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingKey === key}
                  aria-label={`Confirm grade for ${climb.name}`}
                  onClick={() => handleConfirmGrade(climb, key, grade)}
                >
                  <Check size={20} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
