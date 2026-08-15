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
