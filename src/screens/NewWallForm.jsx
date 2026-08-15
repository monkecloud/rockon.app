import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { GRADE_OPTIONS, composeSetterGrade } from "../../shared/grades.js";
import { useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";

// Opened from the "+" button on the Walls root list (moderators/setters
// only), where no wall is selected yet — always shows a Wall dropdown.
// Unlike NewClimbForm, this always saves as setType "reset": adding a
// climb here starts (or adds to) a wall's next cycle, which — per
// currentClimbsOnly — supersedes every older climb on that wall as soon as
// it's saved, without anything needing to be deleted from climbs.json.
// There's no Backfill checkbox, since every save here already is the new
// current set; the Date field is plain and always editable (rather than
// locked/toggle-based like NewClimbForm's) so a setter adding several
// climbs to the same new set can give them all the same date and have them
// land in one cycle together.
export function NewWallForm({ walls, onSave }) {
  const [photo, setPhoto] = useState("");
  const [name, setName] = useState("");
  const [gradeBottom, setGradeBottom] = useState("VB");
  const [gradeTop, setGradeTop] = useState("VB");
  const [setter, setSetter] = useState("");
  const { data: settersData } = useFetch("/api/users/setters");
  const setters = settersData?.setters || [];
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedWallId, setSelectedWallId] = useState(walls?.[0]?.id ?? "");
  const [setDate, setSetDate] = useState(() => new Date().toISOString().slice(0, 10));

  // walls is null until GET /api/walls resolves (§13.8-e) — the initial
  // useState above only runs once, so if this form mounted before that
  // fetch settled, nothing would ever be selected. Only fires while nothing
  // has been picked yet, so it can't clobber a user's actual choice.
  useEffect(() => {
    if (!selectedWallId && walls?.length) setSelectedWallId(walls[0].id);
  }, [walls, selectedWallId]);

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
      wallId: selectedWallId,
      name: name.trim(),
      setterGrade: composeSetterGrade(gradeBottom, gradeTop),
      setter: setter.trim(),
      setDate,
      photoUrl: photo,
      setType: "reset",
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
          Wall
          <select
            style={styles.input}
            value={selectedWallId}
            onChange={(e) => setSelectedWallId(Number(e.target.value))}
          >
            {(walls || []).map((wall) => (
              <option key={wall.id} value={wall.id}>
                {wall.name}
              </option>
            ))}
          </select>
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
        <label style={styles.label}>
          Date
          <input
            style={styles.input}
            type="date"
            value={setDate}
            onChange={(e) => setSetDate(e.target.value)}
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
