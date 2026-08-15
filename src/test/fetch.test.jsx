// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFetch, clearApiCache } from "../lib/fetch.js";
import { installFetchMock } from "./mockFetch.js";

// Regression coverage for a bug found 2026-08-15 verifying an unrelated
// change in a real browser: useFetch's effect depended on [url] only, so
// neither retry() nor a skip:true->false transition ever re-ran it — every
// "Retry" button in the app was a no-op, and ArchiveSection (skip:
// !archiveExpanded) could never load. Nothing here exercised the real hook
// before this file; every other test either mocks useFetch's return value
// or drives a component's onRetry prop directly, never the hook itself.

function Probe({ url, skip }) {
  const { data, loading, error, retry } = useFetch(url, { skip });
  return (
    <div>
      <span data-testid="state">{loading ? "loading" : error ? `error:${error}` : JSON.stringify(data)}</span>
      <button onClick={retry}>Retry</button>
    </div>
  );
}

beforeEach(() => {
  clearApiCache();
});

describe("useFetch — retry()", () => {
  it("re-issues the request and recovers after a failed fetch", async () => {
    let calls = 0;
    installFetchMock({
      "/api/probe": () =>
        ++calls === 1 ? { status: 500, body: { error: "boom" } } : { status: 200, body: { ok: true } },
    });

    const user = userEvent.setup();
    render(<Probe url="/api/probe" skip={false} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("error:boom"));
    expect(calls).toBe(1);

    await user.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent('{"ok":true}'));
    expect(calls).toBe(2);
  });
});

describe("useFetch — skip", () => {
  it("fetches once skip flips from true to false", async () => {
    const { calls } = installFetchMock({ "/api/probe2": { body: { ok: true } } });

    const { rerender } = render(<Probe url="/api/probe2" skip={true} />);
    expect(screen.getByTestId("state")).toHaveTextContent("null");
    expect(calls.length).toBe(0);

    rerender(<Probe url="/api/probe2" skip={false} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent('{"ok":true}'));
    expect(calls.length).toBe(1);
  });

  it("does not fetch again when skip flips back to true", async () => {
    const { calls } = installFetchMock({ "/api/probe3": { body: { ok: true } } });

    const { rerender } = render(<Probe url="/api/probe3" skip={false} />);
    await waitFor(() => expect(calls.length).toBe(1));

    rerender(<Probe url="/api/probe3" skip={true} />);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.length).toBe(1);
  });

  it("serves from cache, not a new request, on a later unskip once already loaded", async () => {
    const { calls } = installFetchMock({ "/api/probe4": { body: { ok: true } } });

    const { rerender } = render(<Probe url="/api/probe4" skip={false} />);
    await waitFor(() => expect(calls.length).toBe(1));

    rerender(<Probe url="/api/probe4" skip={true} />);
    rerender(<Probe url="/api/probe4" skip={false} />);
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByTestId("state")).toHaveTextContent('{"ok":true}');
    expect(calls.length).toBe(1);
  });
});
