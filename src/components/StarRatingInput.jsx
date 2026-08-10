import { useRef } from "react";
import { Star, StarHalf } from "lucide-react";
import { styles } from "../styles.js";

export function StarRatingInput({ value, onChange, invalid, inputRef }) {
  // A precise left-half/right-half tap on a 26px star is too fiddly with a
  // finger, so instead the whole row is a drag surface: press or drag
  // anywhere across it and the rating (in 0.5 steps) tracks the pointer's
  // x position, the way most mobile star pickers work.
  const rowRef = useRef(null);
  const isDragging = useRef(false);

  const valueFromPointer = (clientX) => {
    const el = rowRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(5, Math.max(0, Math.round(ratio * 5 * 2) / 2));
  };

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    onChange(valueFromPointer(e.clientX));
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    onChange(valueFromPointer(e.clientX));
  };

  const stopDragging = () => {
    isDragging.current = false;
  };

  // Arrow keys move in 0.5 steps; Home/End jump to the practical min (a
  // half star — 0 itself is invalid, see LogAscentSheet's ratingInvalid)
  // and max. preventDefault on the arrows, otherwise they scroll the sheet
  // instead of adjusting the rating (§14.13 part 5). The pointer-drag path
  // above is unchanged — this is an alternate input, not a replacement.
  const handleKeyDown = (e) => {
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, value + 0.5);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, value - 0.5);
    else if (e.key === "Home") next = 0.5;
    else if (e.key === "End") next = 5;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div
      ref={(el) => {
        rowRef.current = el;
        if (inputRef) inputRef.current = el;
      }}
      role="slider"
      tabIndex={0}
      aria-label="Rating"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={value}
      aria-valuetext={`${value} out of 5 stars`}
      style={{ ...styles.starRow, ...(invalid ? styles.starRowInvalid : {}) }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onKeyDown={handleKeyDown}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const isFull = value >= n;
        const isHalf = !isFull && value >= n - 0.5;
        const StarIconComponent = isHalf ? StarHalf : Star;

        return (
          <StarIconComponent
            key={n}
            size={30}
            color={isFull || isHalf ? "var(--color-star)" : "var(--color-text-disabled)"}
            fill={isFull || isHalf ? "var(--color-star)" : "none"}
            strokeWidth={1.5}
          />
        );
      })}
    </div>
  );
}
