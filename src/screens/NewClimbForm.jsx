import { useState } from "react";
import { Camera } from "lucide-react";
import { GRADE_OPTIONS, composeSetterGrade } from "../../shared/grades.js";
import { useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";

// Opened from the "+" button on a wall's Climbs page (moderators/setters
// only) — wallId/resetDate are fixed, no wall picker. Every climb saved
// here is stored server-side as a "backfill" (see POST /api/climbs) — the
// Backfill checkbox only decides which date it's dated: today's/the
// current reset's date, or a picked date in the past for logging a climb
// that's been up for a while already. Compare with NewWallForm below,
// opened from the Walls root list's "+" instead — similar fields, but for
// starting a wall's next "reset" rather than adding to its current set.
export function NewClimbForm({ wallId, resetDate, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const { data: settersData } = useFetch("/api/users/setters");
  const setters = settersData?.setters || [];
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [isBackfill, setIsBackfill] = useState(false);
  const [backfillDate, setBackfillDate] = useState(() => new Date().toISOString().slice(0, 10));

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setPhoto(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    if (!name.trim() || !setter.trim()) {
      setError("Climb name and setter are required.");
      return;
    }
    if (GRADE_OPTIONS.indexOf(gradeBottom) > GRADE_OPTIONS.indexOf(gradeTop)) {
      setError("Bottom grade must be the same as or easier than top grade.");
      return;
    }

    setError("");
    setSaving(true);
    const result = await onSave({
      wallId,
      name: name.trim(),
      setterGrade: composeSetterGrade(gradeBottom, gradeTop),
      setter: setter.trim(),
      setDate: isBackfill ? backfillDate : resetDate,
      photoUrl: photo,
    });
    setSaving(false);

    if (!result.success) {
      setError(result.error || "Something went wrong.");
    }
  };

  return (
    <div style={styles.screen}>
      <form style={styles.form} onSubmit={handleSubmit}>
        {photo ? (
          <img src={photo} alt="" style={styles.avatarPreview} />
        ) : (
          <div style={styles.avatarPreviewPlaceholder}>
            <Camera size={28} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}
        <label style={styles.pickImageButton}>
          Choose photo
          <input
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
        </label>

        <label style={styles.label}>
          Climb name
          <input
            style={styles.input}
            type="text"
            placeholder="e.g. Golden Overhang"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Bottom grade
          <select style={styles.input} value={gradeBottom} onChange={(e) => setGradeBottom(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Top grade
          <select style={styles.input} value={gradeTop} onChange={(e) => setGradeTop(e.target.value)}>
            {GRADE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Setter
          <select style={styles.input} value={setter} onChange={(e) => setSetter(e.target.value)}>
            <option value="">Select a setter</option>
            {setters.map((s) => (
              <option key={s.username} value={s.username}>
                {s.name ? `${s.name} (${s.username})` : s.username}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.checkboxRow}>
          <input
            style={styles.checkboxInput}
            type="checkbox"
            checked={isBackfill}
            onChange={(e) => setIsBackfill(e.target.checked)}
          />
          Backfill (pick a past date)
        </label>
        <label style={styles.label}>
          Date
          <input
            style={isBackfill ? styles.input : { ...styles.input, ...styles.inputDisabled }}
            type="date"
            value={isBackfill ? backfillDate : resetDate || ""}
            onChange={(e) => setBackfillDate(e.target.value)}
            disabled={!isBackfill}
          />
        </label>
        {error && <p style={styles.formError} role="alert">{error}</p>}
        <button type="submit" style={styles.button} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
