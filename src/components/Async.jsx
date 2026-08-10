import { styles } from "../styles.js";

// Renders one of three branches consistently, including a retry button on
// error — the single most useful thing this adds over the status quo. A
// phone that briefly drops wifi mid-session used to need a full app reload
// to recover from any failed fetch; now it needs one tap.
export function Async({ loading, error, retry, loadingFallback, children }) {
  if (loading) return loadingFallback ?? <p style={styles.placeholderText}>Loading…</p>;
  if (error) {
    return (
      <div style={styles.asyncError}>
        <p style={styles.formError} role="alert">{error}</p>
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  return children;
}
