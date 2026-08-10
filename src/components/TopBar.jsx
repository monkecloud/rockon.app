import { ArrowLeft, Info, Plus } from "lucide-react";
import { styles } from "../styles.js";

export function TopBar({
  title,
  showBack,
  onBack,
  showInfoButton,
  onShowInfo,
  showAddButton,
  addButtonLabel,
  onAdd,
}) {
  return (
    <header style={styles.topBar}>
      {showBack ? (
        <button style={styles.topBarBackButton} onClick={onBack} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
      ) : (
        <div style={styles.topBarSpacer} />
      )}
      <h1 style={styles.topBarTitle}>{title}</h1>
      {showInfoButton ? (
        <button style={styles.topBarBackButton} onClick={onShowInfo} aria-label="Climb info">
          <Info size={20} />
        </button>
      ) : showAddButton ? (
        // addButtonLabel is context-dependent (New Climb vs. New Wall) — the
        // caller knows which, TopBar doesn't (§14.13 part 1).
        <button style={styles.topBarBackButton} onClick={onAdd} aria-label={addButtonLabel}>
          <Plus size={20} />
        </button>
      ) : (
        <div style={styles.topBarSpacer} />
      )}
    </header>
  );
}
