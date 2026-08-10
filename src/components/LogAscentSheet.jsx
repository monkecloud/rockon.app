import { useEffect, useRef, useState } from "react";
import { GRADE_OPTIONS } from "../../shared/grades.js";
import { styles } from "../styles.js";
import { StarRatingInput } from "./StarRatingInput.jsx";

// Up to 5 ascentClaims live on the climb itself (see server/worker.js), one
// slot per ordinal. Whoever logs an ascent while a slot is still open gets
// offered it — a name to credit (defaults to blank, e.g. crediting someone
// else) or a "Pass" to leave it unclaimed. Filling in neither during a
// given ascent just leaves that slot open for the next person to log one.
// Naming rights: a filled-in name also gets queued as a proposal to rename
// the climb itself, awaiting a moderator/setter's approval on the Approve
// tab (see server/worker.js's pendingNames).
const ASCENT_ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];

// Full-width bottom sheet for logging an ascent. Slides up from behind the
// climb action bar. Attempts (total and this session) are always included
// in what gets saved, via POST /api/ascents (see App's handleSubmitAscent).
export function LogAscentSheet({
  open,
  attemptsThisSession,
  currentGrade,
  ascentClaims,
  onClose,
  onSubmit,
}) {
  const [starRating, setStarRating] = useState(0);
  const [attempts, setAttempts] = useState(attemptsThisSession);
  const [grade, setGrade] = useState(currentGrade || "VB");
  const [comment, setComment] = useState("");
  const [showValidation, setShowValidation] = useState(false);
  const [ascentClaimName, setAscentClaimName] = useState("");
  const [ascentClaimPass, setAscentClaimPass] = useState(false);
  const sheetRef = useRef(null);
  const ratingRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (open) {
      setStarRating(0);
      setAttempts(attemptsThisSession);
      setGrade(currentGrade || "VB");
      setComment("");
      setShowValidation(false);
      setAscentClaimName("");
      setAscentClaimPass(false);
    }
  }, [open, attemptsThisSession, currentGrade]);

  // Dialog focus management (§14.13 part 4): move focus into the sheet on
  // open (the rating slider is the first real field) and restore it to
  // whatever had focus before — normally the "Log ascent" button — on
  // close. Without the restore, a keyboard user who closes the sheet is
  // dumped back at the top of the page with no indication where they
  // landed.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement;
      // The sheet's own `visibility: hidden -> visible` is a *transitioned*
      // property (see styles.sheet), and focus() on an element that still
      // computes as visibility:hidden is a silent no-op. Right after this
      // effect commits, the browser hasn't applied the new computed style
      // yet (verified: still "hidden" even one rAF later) — it takes a
      // second frame for the transitioned value to actually land, a known
      // browser quirk with transitioning styles set in the same tick as a
      // React commit. Double-rAF is the standard workaround.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => ratingRef.current?.focus());
      });
    } else {
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    }
  }, [open]);

  // Escape closes; Tab/Shift+Tab wrap within the sheet instead of leaking
  // into the page behind it (the sheet stays in the DOM/tab-order-capable
  // even while closed — see styles.sheet's visibility toggle — so without
  // a trap, tabbing from the last field would walk into whatever's behind
  // the backdrop).
  const handleKeyDown = (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !sheetRef.current) return;
    const focusable = Array.from(
      sheetRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const claimedCount = ascentClaims?.length ?? 0;
  const showAscentClaim = claimedCount < 5;

  const attemptsValue = Number(attempts) || 0;
  const ratingInvalid = showValidation && starRating < 0.5;
  const attemptsInvalid = showValidation && attemptsValue < 1;

  const handleSubmit = (e) => {
    e.preventDefault();

    if (starRating < 0.5 || attemptsValue < 1) {
      setShowValidation(true);
      return;
    }

    setShowValidation(false);
    onSubmit({
      starRating,
      grade,
      comment,
      logAttempts: true,
      attempts: attemptsValue,
      attemptsThisSession,
      ascentClaim:
        showAscentClaim && (ascentClaimName.trim() || ascentClaimPass)
          ? { name: ascentClaimName.trim(), pass: ascentClaimPass }
          : null,
    });
  };

  return (
    <>
      <div
        style={{
          ...styles.sheetBackdrop,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Log ascent"
        onKeyDown={handleKeyDown}
        style={{
          ...styles.sheet,
          transform: open ? "translateY(0)" : "translateY(100%)",
          visibility: open ? "visible" : "hidden",
        }}
      >
        <div style={styles.sheetHandle} />
        <form style={styles.sheetForm} onSubmit={handleSubmit} noValidate>
          <label style={styles.label}>
            Rating
            <StarRatingInput
              value={starRating}
              onChange={setStarRating}
              invalid={ratingInvalid}
              inputRef={ratingRef}
            />
          </label>

          <label style={styles.label}>
            Grade
            <select
              style={styles.input}
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
            >
              {GRADE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.label}>
            Comment
            <textarea
              style={styles.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </label>

          <label style={styles.label}>
            Attempts
            <input
              style={{ ...styles.input, ...(attemptsInvalid ? styles.inputInvalid : {}) }}
              type="number"
              min={1}
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
            />
          </label>

          {showAscentClaim && (
            <>
              <label style={styles.label}>
                {ASCENT_ORDINALS[claimedCount]} ascent
                <input
                  style={
                    ascentClaimPass ? { ...styles.input, ...styles.inputDisabled } : styles.input
                  }
                  type="text"
                  placeholder="name"
                  value={ascentClaimName}
                  disabled={ascentClaimPass}
                  onChange={(e) => setAscentClaimName(e.target.value)}
                />
              </label>
              <label style={styles.checkboxRow}>
                <input
                  style={styles.checkboxInput}
                  type="checkbox"
                  checked={ascentClaimPass}
                  onChange={(e) => setAscentClaimPass(e.target.checked)}
                />
                Pass
              </label>
            </>
          )}

          <button type="submit" style={styles.button}>
            Save ascent
          </button>
        </form>
      </div>
    </>
  );
}
