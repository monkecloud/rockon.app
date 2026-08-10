import { useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { WALL_NAME_BY_ID } from "../constants.js";
import { apiSend, useFetch } from "../lib/fetch.js";
import { styles } from "../styles.js";

// Opened from the Approve tab (moderators/setters only). Naming rights: a
// climber who fills in a name for any first-through-fifth ascent claim (see
// LogAscentSheet) is also proposing that name as the climb's new display
// name — queued here (climb.pendingNames, server-side) rather than taking
// effect immediately. Approving one sets the climb's confirmed name and
// clears any other pending proposals for that climb; rejecting just drops
// that one proposal. The climb's setterName (its immutable identity) never
// changes either way.
export function ApproveClimbsScreen() {
  const { data: climbsData, loading, error: fetchError, retry } = useFetch("/api/climbs/needs-name-approval");
  const [climbs, setClimbs] = useState(null);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    if (climbsData) setClimbs(climbsData.climbs || []);
  }, [climbsData]);

  const handleResolveProposal = async (climb, proposal, action) => {
    setSavingId(proposal.id);
    setError("");
    const result = await apiSend("/api/climbs/approve-name", {
      body: { wallId: climb.wallId, setterName: climb.setterName, proposalId: proposal.id, action },
    });
    if (!result.success) {
      setError(result.error);
    } else {
      setClimbs((prev) =>
        action === "approve"
          ? prev.filter((c) => c.wallId !== climb.wallId || c.setterName !== climb.setterName)
          : prev
              .map((c) =>
                c.wallId === climb.wallId && c.setterName === climb.setterName
                  ? { ...c, pendingNames: c.pendingNames.filter((p) => p.id !== proposal.id) }
                  : c
              )
              .filter((c) => c.pendingNames.length > 0)
      );
    }
    setSavingId(null);
  };

  return (
    <div style={styles.screen}>
      {(error || fetchError) && <p style={styles.formError} role="alert">{error || fetchError}</p>}
      {climbs === null && loading && <p style={styles.placeholderText}>Loading…</p>}
      {climbs === null && fetchError && (
        <button type="button" style={styles.retryButton} onClick={retry}>
          Retry
        </button>
      )}
      {climbs !== null && climbs.length === 0 && (
        <p style={styles.placeholderText}>No pending name proposals.</p>
      )}
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {(climbs || []).flatMap((climb) =>
          (climb.pendingNames || []).map((proposal) => (
            <div key={proposal.id} style={styles.climbRow}>
              <div style={styles.climbRowLeft}>
                <span style={styles.climbTitle}>{proposal.name}</span>
                <span style={styles.climbSetter}>
                  {WALL_NAME_BY_ID[climb.wallId] ?? `Wall ${climb.wallId}`} · currently "{climb.name}"
                </span>
                <span style={styles.climbSetter}>Proposed by {proposal.claimedBy}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingId === proposal.id}
                  aria-label={`Reject name "${proposal.name}" for ${climb.name}`}
                  onClick={() => handleResolveProposal(climb, proposal, "reject")}
                >
                  <Trash2 size={20} />
                </button>
                <button
                  type="button"
                  style={styles.commentDeleteButton}
                  disabled={savingId === proposal.id}
                  aria-label={`Approve name "${proposal.name}" for ${climb.name}`}
                  onClick={() => handleResolveProposal(climb, proposal, "approve")}
                >
                  <Check size={20} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
