import { climbDisplayGrade } from "../../shared/grades.js";

export function ClimbGradeLabel({ climb }) {
  const confirmed = Boolean(climb.grade);
  return (
    <span
      style={{ color: confirmed ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
    >
      {climbDisplayGrade(climb)}
    </span>
  );
}

// "V4 · Climb Name" title shown atop the Climb detail page's image, for
// both current and archived climbs — the grade colored per ClimbGradeLabel.
export function climbTitleNode(climb) {
  return (
    <>
      <ClimbGradeLabel climb={climb} />
      {` · ${climb.name}`}
    </>
  );
}
