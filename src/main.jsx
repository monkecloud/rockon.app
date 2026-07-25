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

// Also block native two-finger pinch via touchmove, without touching
// single-finger touches so normal scrolling inside the app still works.
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false }
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
