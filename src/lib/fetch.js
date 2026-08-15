import { useEffect, useState } from "react";

// Data fetching (§14.9, §14.18). Two helpers, not one: reads go through
// useFetch/<Async> (see components/Async.jsx), writes go through apiSend.
// Before this, every fetch() call in the app ended in .catch(console.error)
// — nothing reached the user, so a downed server, dropped wifi, or a 500
// all rendered as either a blank screen or (worse) a permanently-"loading"
// one. See ListScreen's climbsByWall handling for the specific bug that
// motivated this: `[]` is not a safe "still loading" sentinel because it's
// indistinguishable from a successful fetch that returned nothing.

// A tiny URL-keyed cache so switching tabs and back doesn't re-request data
// that's already in flight or already loaded — e.g. Home -> Walls -> Home
// used to re-fetch the leaderboard and grade pyramid every time, because
// the `content` useMemo in App() unmounts the old screen. Invalidation is
// deliberately coarse: apiSend() below clears the whole cache after any
// successful mutation, rather than tracking which keys a given write
// affects. A precise scheme is where stale-data bugs breed, and at this
// app's scale the extra refetch after a write costs nothing.
const apiCache = new Map(); // url -> { data }

export function clearApiCache() {
  apiCache.clear();
}

// Fetches `url` (GET) on mount and whenever `url`/`skip` changes, exposing
// { data, loading, error, retry }. `data` is null until the first
// successful response — that's the "unknown, not yet fetched" state; once a
// fetch resolves, `data` becomes whatever the server returned (which may
// itself be an empty list — a *known* empty result, not a loading one).
// Never conflate the two, in this hook or in what reads it.
export function useFetch(url, { skip = false } = {}) {
  const cached = apiCache.get(url);
  const [state, setState] = useState(() =>
    cached ? { data: cached.data, loading: false, error: null } : { data: null, loading: !skip, error: null }
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (skip) return;
    // A cache hit on a later mount (e.g. re-visiting a tab) skips the
    // network round-trip entirely rather than showing a loading flash for
    // data already on hand.
    if (nonce === 0 && apiCache.has(url)) {
      setState({ data: apiCache.get(url).data, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then((res) =>
        res.ok ? res.json() : res.json().then((d) => Promise.reject(d.error || `HTTP ${res.status}`))
      )
      .then((data) => {
        apiCache.set(url, { data });
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ data: null, loading: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
    // `nonce` in the deps is what makes retry() actually re-run this effect
    // — setNonce alone only triggers a re-render, not a re-fetch, without
    // it. `skip` has to be in the deps too, for the same reason: a
    // skip:true -> false transition (e.g. ArchiveSection expanding) must
    // re-run the effect to fetch at all, since the mount-time run returned
    // immediately at the `if (skip) return` above and nothing else
    // schedules a fetch afterward. Both were previously omitted — verified
    // via a probe against a mocked fetch that neither retry() nor a skip
    // flip actually issued a second request; every "Retry" button in the
    // app was silently a no-op, and any skip-gated useFetch (ArchiveSection)
    // could never load. A `skip: false -> true` transition still costs
    // nothing extra: the effect just hits the early return again.
  }, [url, skip, nonce]);

  return { ...state, retry: () => setNonce((n) => n + 1) };
}

// Every write (POST/DELETE) in the app goes through this instead of a
// bespoke try/fetch/catch — unifies what callAuthApi/callSettingsApi were
// already informally doing. Returns { success, data, error } and, on
// success, clears the read cache above so the next screen that needs
// affected data refetches it (see the coarse-invalidation note).
export async function apiSend(url, { method = "POST", body, onUnauthorized } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // A 401 here means the session expired *during* use (not at mount —
      // see GET /api/me in App() for that case, §14.8) — the one gap that
      // item's own writeup flagged as still open. Closing it is one line
      // now that every write funnels through here.
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      return { success: false, error: data.error || "Something went wrong." };
    }

    clearApiCache();
    return { success: true, data };
  } catch (err) {
    console.error(`Failed to reach ${url}:`, err);
    return { success: false, error: "Couldn't reach the server. Is it running?" };
  }
}
