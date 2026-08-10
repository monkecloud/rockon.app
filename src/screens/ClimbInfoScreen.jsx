import { Trash2 } from "lucide-react";
import { styles } from "../styles.js";
import { GradeBarChart } from "../components/GradeBarChart.jsx";

export function ClimbInfoScreen({ climb, currentUser, onDeleteComment }) {
  const comments = climb?.comments ?? [];

  return (
    <div style={styles.screen}>
      {climb && (
        <GradeBarChart
          title="Logged grades"
          endpoint={`/api/climbs/grade-distribution?wallId=${climb.wallId}&setterName=${encodeURIComponent(
            climb.setterName
          )}`}
        />
      )}
      {comments.length === 0 ? (
        <p style={styles.placeholderText}>No comments yet.</p>
      ) : (
        <div style={styles.list}>
          {comments.map((comment) => {
            // Only a comment's own author can delete it, and only
            // user-submitted comments (ones tied to a logged ascent) are
            // deletable at all — the seeded sample comments aren't.
            const canDelete =
              Boolean(comment.ascentId) &&
              currentUser &&
              comment.author === currentUser.username;

            return (
              <div key={comment.id} style={styles.listRow}>
                <div style={styles.commentHeader}>
                  <p style={styles.commentAuthor}>{comment.author}</p>
                  {canDelete && (
                    <button
                      type="button"
                      style={styles.commentDeleteButton}
                      onClick={() => onDeleteComment(comment.ascentId)}
                      aria-label="Delete comment"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <p style={styles.commentText}>{comment.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
