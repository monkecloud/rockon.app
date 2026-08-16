import { useEffect, useRef } from "react";
import { Image as ImageIcon } from "lucide-react";
import { styles } from "../styles.js";
import { ClimbGradeLabel } from "./ClimbGradeLabel.jsx";

// A full-height, zoomable/pannable image area with its own toolbar
// (zoom out / percentage / zoom in / reset) that stays pinned just below
// the persistent top bar. Uses the Pointer Events API so mouse drag,
// touch drag, and two-finger pinch all go through the same code path.
//
// The header is two columns: grade + setter on the left, climb name +
// first ascent on the right, all read straight off `climb`.
export function ZoomableImageViewer({ climb, photoUrl }) {
  const imageRef = useRef(null);
  const stageRef = useRef(null);
  // Mutable, not React state: on mobile, calling setState on every single
  // pointermove event was enough to make pinch/drag feel glitchy, since
  // each update forced a full re-render. Writing the transform straight to
  // the DOM node keeps this at native frame rate.
  const transformState = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map());
  const lastDistance = useRef(null);
  const dragStart = useRef(null);

  const clampScale = (value) => Math.min(4, Math.max(1, value));

  const applyTransform = () => {
    const { scale, x, y } = transformState.current;
    if (imageRef.current) {
      imageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
  };

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      dragStart.current = {
        x: e.clientX - transformState.current.x,
        y: e.clientY - transformState.current.y,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      lastDistance.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const handlePointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDistance.current) {
        transformState.current.scale = clampScale(
          transformState.current.scale * (distance / lastDistance.current)
        );
      }
      lastDistance.current = distance;
    } else if (pointers.current.size === 1 && dragStart.current) {
      transformState.current.x = e.clientX - dragStart.current.x;
      transformState.current.y = e.clientY - dragStart.current.y;
    }

    applyTransform();
  };

  const handlePointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastDistance.current = null;
    if (pointers.current.size === 0) dragStart.current = null;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    transformState.current.scale = clampScale(transformState.current.scale + delta);
    applyTransform();
  };

  // Blocks native two-finger pinch-zoom so it doesn't fight the pointer-
  // based pinch handled above. Used to live as a document-wide listener in
  // main.jsx, running on every touchmove anywhere in the app; scoped here
  // to just the image stage, the only place it's actually needed (§14.22).
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const handleTouchMove = (e) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => node.removeEventListener("touchmove", handleTouchMove);
  }, []);

  return (
    <div>
      <div style={styles.secondaryBar}>
        {climb ? (
          <>
            <div style={styles.secondaryBarLeft}>
              <span style={styles.secondaryBarPlaceholder}>
                <ClimbGradeLabel climb={climb} />
              </span>
              <span style={styles.secondaryBarSubtitle}>Setter: {climb.setter}</span>
              <span style={styles.secondaryBarSubtitle}>{climb.setDate}</span>
            </div>
            <div style={styles.secondaryBarRight}>
              <span style={styles.secondaryBarPlaceholder}>{climb.name}</span>
              <span style={styles.secondaryBarSubtitle}>
                First Ascent: {climb.firstAscentUsername || "None"}
              </span>
            </div>
          </>
        ) : (
          <span style={styles.secondaryBarPlaceholder}>Loading…</span>
        )}
      </div>

      <div
        ref={stageRef}
        style={styles.imageStage}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {photoUrl ? (
          <img ref={imageRef} src={photoUrl} alt="" style={styles.climbPhoto} />
        ) : (
          <div ref={imageRef} style={styles.imagePlaceholder}>
            <ImageIcon size={56} color="var(--color-text-faint)" strokeWidth={1.5} />
          </div>
        )}
      </div>
    </div>
  );
}
