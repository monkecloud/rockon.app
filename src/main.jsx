import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Belt-and-suspenders against page-level pinch-zoom on iOS Safari: some
// versions still fire these non-standard gesture events even with
// user-scalable=no set in the viewport meta tag and touch-action:
// manipulation in CSS.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());

// The equivalent two-finger-pinch-via-touchmove block used to live here too,
// document-wide — but the only place it's needed is the image viewer's pinch
// stage, so it's scoped there now (ZoomableImageViewer in
// src/components/ZoomableImageViewer.jsx) rather than running on every
// touchmove anywhere in the app (§14.22).

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
