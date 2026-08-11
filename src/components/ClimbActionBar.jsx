import { Minus, Plus } from "lucide-react";
import { styles } from "../styles.js";

// Replaces the persistent tab bar while viewing a Climb detail page: an
// attempts counter (with -/+ buttons on either side) above a center button
// to log an ascent (see LogAscentSheet). `disabled` covers the whole bar
// (a view-only archived climb); `logDisabled` additionally covers just the
// center button (signed-out — the attempts counter is harmless local-only
// state, but submitting an ascent requires an account).
export function ClimbActionBar({ attempts, onDecrement, onIncrement, onLogAscent, disabled, logDisabled }) {
  const logAscentDisabled = disabled || logDisabled;
  return (
    <nav style={styles.climbActionBar}>
      <button
        style={{
          ...styles.climbActionSideButton,
          ...(disabled ? styles.climbActionSideButtonDisabled : {}),
        }}
        onClick={disabled ? undefined : onDecrement}
        disabled={disabled}
        aria-label="Decrease attempts"
      >
        <Minus size={22} />
      </button>
      <div style={styles.climbActionCenter}>
        <span
          style={{ ...styles.attemptsCounter, ...(disabled ? styles.attemptsCounterDisabled : {}) }}
        >
          {attempts}
        </span>
        <button
          style={{
            ...styles.logAscentButton,
            ...(logAscentDisabled ? styles.logAscentButtonDisabled : {}),
          }}
          onClick={logAscentDisabled ? undefined : onLogAscent}
          disabled={logAscentDisabled}
        >
          Log ascent
        </button>
      </div>
      <button
        style={{
          ...styles.climbActionSideButton,
          ...(disabled ? styles.climbActionSideButtonDisabled : {}),
        }}
        onClick={disabled ? undefined : onIncrement}
        disabled={disabled}
        aria-label="Increase attempts"
      >
        <Plus size={22} />
      </button>
    </nav>
  );
}
