import { Star } from "lucide-react";
import { styles } from "../styles.js";

// A climb row's star rating, rounded to the nearest whole star. Was
// "⭐".repeat(n) + "☆".repeat(5-n) — read literally by screen readers as
// "star star star...", once per character — replaced with the same lucide
// Star icons StarRatingInput uses, plus one aria-label giving the numeric
// value instead (§14.22).
export function StarRatingDisplay({ value }) {
  const filled = Math.round(value || 0);
  return (
    <span style={styles.climbStars} aria-label={`${filled} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={12}
          color={n <= filled ? "var(--color-star)" : "var(--color-text-disabled)"}
          fill={n <= filled ? "var(--color-star)" : "none"}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
