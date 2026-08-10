import { afterEach, vi } from "vitest";

// This setup file loads for every test file, including server/*.test.js,
// which runs in the plain node environment (see vite.config.js's
// environmentMatchGlobs) — no `Element`/`localStorage`/DOM. Guard
// everything below on jsdom actually being present, rather than trying to
// scope setupFiles itself (vitest applies setupFiles globally, not per
// environmentMatchGlobs entry).
if (typeof Element !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");

  // jsdom doesn't implement the Pointer Events API — StarRatingInput and
  // ZoomableImageViewer call setPointerCapture/releasePointerCapture, which
  // throw ("not implemented") without these stubs (§14.11).
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();

  // App() reads localStorage at startup (loadFromStorage) — without
  // clearing between tests, whichever test runs first "wins" the cached
  // session for every test after it, producing confusing cross-test
  // failures.
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
}
