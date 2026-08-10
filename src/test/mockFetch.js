import { vi } from "vitest";

// A route-table fetch mock for App()-level tests. Every GET useFetch call
// in the tree fires on render (Leaderboard, GradeBarChart, /api/archive,
// ...) whether or not a given test cares about it, and each already
// tolerates a missing/empty body gracefully (see useFetch's null-vs-[]
// design, §14.9) — so the default for anything not explicitly listed is a
// harmless empty-body 200, and tests only override the routes the
// scenario actually depends on.
//
// `routes` keys are "METHOD path" (path only implies GET), matched against
// the request URL's pathname (query string ignored) so
// "/api/users/alice/follow" and "/api/users/bob/follow" share one entry.
// A value is either a static { status, body } or a function
// (url, init) => { status, body }.
export function installFetchMock(routes = {}) {
  const calls = [];

  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const pathname = url.split("?")[0];
    calls.push({ url, method, pathname, init });

    const entry = routes[`${method} ${pathname}`] ?? (method === "GET" ? routes[pathname] : undefined);
    const resolved = typeof entry === "function" ? entry(url, init) : entry;
    if (resolved?.networkError) throw new TypeError("Failed to fetch");
    const { status = 200, body = {} } = resolved ?? {};

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}
