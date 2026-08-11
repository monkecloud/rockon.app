import { climbDisplayGrade } from "../../shared/grades.js";
import { WALL_NAME_BY_ID } from "../constants.js";
import { styles } from "../styles.js";
import { StarRatingDisplay } from "../components/StarRatingDisplay.jsx";

// Static placeholder rows — there's no "save a climb" action anywhere yet
// (this is just the destination for the Profile tab's new Saved climbs
// button), so nothing here is fetched or backed by real data.
const PLACEHOLDER_SAVED_CLIMBS = [
  { wallId: 2, setterName: "placeholder-1", name: "Sunny Side Up", setterGrade: "V4", averageStars: 3.5 },
  { wallId: 3, setterName: "placeholder-2", name: "Night Crawler", setterGrade: "V6", averageStars: 4 },
  { wallId: 1, setterName: "placeholder-3", name: "Gecko Traverse", setterGrade: "V2-3", averageStars: 2.5 },
];

export function SavedClimbsScreen() {
  return (
    <div style={styles.screen}>
      <p style={styles.placeholderText}>Saving a climb isn't wired up yet — here's what this'll look like.</p>
      <div style={{ ...styles.list, gap: 0, marginLeft: -20, marginRight: -20 }}>
        {PLACEHOLDER_SAVED_CLIMBS.map((climb) => (
          <div key={climb.setterName} style={styles.climbRow}>
            <div style={styles.climbRowLeft}>
              <span style={styles.climbDifficulty}>{climbDisplayGrade(climb)}</span>
              <StarRatingDisplay value={climb.averageStars} />
            </div>
            <div style={styles.climbRowRight}>
              <span style={styles.climbTitle}>{climb.name}</span>
              <span style={styles.climbSetter}>{WALL_NAME_BY_ID[climb.wallId]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
