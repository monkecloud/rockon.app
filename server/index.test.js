import { EventEmitter } from "events";
import http from "http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

vi.mock("child_process", () => ({ fork: vi.fn() }));

function makeFakeWorker() {
  const worker = new EventEmitter();
  worker.send = vi.fn();
  worker.kill = vi.fn();
  return worker;
}

let fork;
let indexModule;

beforeEach(async () => {
  vi.resetModules();
  const cp = await import("child_process");
  fork = cp.fork;
  fork.mockReset();
  fork.mockImplementation(() => makeFakeWorker());
  indexModule = await import("./index.js");
});

// ---------------------------------------------------------------------------
// startWorker / handleWorkerMessage / getState — the promotion state machine
// ---------------------------------------------------------------------------

describe("startWorker", () => {
  it("forks a worker at worker.js and holds it as pending until it's ready", () => {
    indexModule.startWorker();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork.mock.calls[0][0]).toMatch(/worker\.js$/);

    const state = indexModule.getState();
    expect(state.pendingWorker).toBeDefined();
    expect(state.activeWorker).toBeNull();
    expect(state.activeWorkerPort).toBeNull();
  });

  it("coalesces a second call into restartQueued instead of forking again", () => {
    indexModule.startWorker();
    indexModule.startWorker();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(indexModule.getState().restartQueued).toBe(true);
  });
});

describe("handleWorkerMessage", () => {
  it("promotes a pending worker to active on a 'ready' message", () => {
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;

    pending.emit("message", { type: "ready", port: 4242 });

    const state = indexModule.getState();
    expect(state.activeWorker).toBe(pending);
    expect(state.activeWorkerPort).toBe(4242);
    expect(state.pendingWorker).toBeNull();
  });

  it("retires the previously-active worker once a new one takes over", () => {
    indexModule.startWorker();
    const first = indexModule.getState().pendingWorker;
    first.emit("message", { type: "ready", port: 1111 });

    indexModule.startWorker();
    const second = indexModule.getState().pendingWorker;
    second.emit("message", { type: "ready", port: 2222 });

    expect(first.send).toHaveBeenCalledWith({ type: "shutdown" });
    expect(indexModule.getState().activeWorker).toBe(second);
  });

  it("ignores a 'ready' message from a worker that is no longer the pending one", () => {
    indexModule.startWorker();
    const stale = indexModule.getState().pendingWorker;

    // A second startWorker() call while `stale` is still pending just queues
    // a restart (see the coalescing test above) — `stale` remains pending.
    // Simulate the stale worker reporting ready *after* it's been superseded
    // by forcing pendingWorker to something else via a fresh startWorker
    // flow: promote `stale`, then have its old reference fire again.
    stale.emit("message", { type: "ready", port: 1 });
    expect(indexModule.getState().activeWorker).toBe(stale);

    // A stray second "ready" from the same (now-active, not pending) worker
    // must not re-promote or throw.
    stale.emit("message", { type: "ready", port: 2 });
    expect(indexModule.getState().activeWorkerPort).toBe(1);
  });

  it("ignores unrelated message types", () => {
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;
    expect(() => pending.emit("message", { type: "something-else" })).not.toThrow();
    expect(indexModule.getState().activeWorker).toBeNull();
  });

  it("starts a fresh worker on a 'climbs-updated' message", () => {
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;
    pending.emit("message", { type: "ready", port: 1 });

    pending.emit("message", { type: "climbs-updated" });
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("fires the queued restart once the in-flight promotion completes", () => {
    indexModule.startWorker();
    const first = indexModule.getState().pendingWorker;

    indexModule.startWorker(); // queued, since `first` is still pending
    expect(fork).toHaveBeenCalledTimes(1);

    first.emit("message", { type: "ready", port: 1 });

    // Promoting `first` should have immediately kicked off the queued restart.
    expect(fork).toHaveBeenCalledTimes(2);
    expect(indexModule.getState().restartQueued).toBe(false);
    expect(indexModule.getState().pendingWorker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// retireWorker
// ---------------------------------------------------------------------------

describe("retireWorker", () => {
  it("does nothing for a null worker", () => {
    expect(() => indexModule.retireWorker(null)).not.toThrow();
  });

  it("asks the worker to shut down gracefully", () => {
    const worker = makeFakeWorker();
    indexModule.retireWorker(worker);
    expect(worker.send).toHaveBeenCalledWith({ type: "shutdown" });
  });

  it("force-kills the worker if it hasn't exited within the grace period", () => {
    vi.useFakeTimers();
    const worker = makeFakeWorker();
    indexModule.retireWorker(worker);

    vi.advanceTimersByTime(14999);
    expect(worker.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(worker.kill).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not force-kill a worker that exits on its own in time", () => {
    vi.useFakeTimers();
    const worker = makeFakeWorker();
    indexModule.retireWorker(worker);

    worker.emit("exit");
    vi.advanceTimersByTime(20000);
    expect(worker.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  it("kills whichever workers exist and exits the process", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;
    pending.emit("message", { type: "ready", port: 1 });
    indexModule.startWorker();
    const newPending = indexModule.getState().pendingWorker;

    indexModule.shutdown();

    expect(pending.kill).toHaveBeenCalled();
    expect(newPending.kill).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("does not throw when there is no active/pending worker yet", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    expect(() => indexModule.shutdown()).not.toThrow();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// proxy — the actual reverse-proxy request handler
// ---------------------------------------------------------------------------

describe("proxy", () => {
  let backend;
  let backendPort;

  beforeEach(async () => {
    backend = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "x-from": "backend" });
      res.end(`echo:${req.url}`);
    });
    await new Promise((resolve) => backend.listen(0, resolve));
    backendPort = backend.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => backend.close(resolve));
  });

  it("503s before any worker has reported ready", async () => {
    const res = await request(indexModule.proxy).get("/api/climbs");
    expect(res.status).toBe(503);
  });

  it("forwards requests to the active worker's port once ready", async () => {
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;
    pending.emit("message", { type: "ready", port: backendPort });

    const res = await request(indexModule.proxy).get("/api/climbs?x=1");
    expect(res.status).toBe(200);
    expect(res.headers["x-from"]).toBe("backend");
    expect(res.text).toBe("echo:/api/climbs?x=1");
  });

  it("502s when the active worker's port is unreachable", async () => {
    indexModule.startWorker();
    const pending = indexModule.getState().pendingWorker;
    // Close the backend immediately so the recorded port is dead.
    await new Promise((resolve) => backend.close(resolve));
    pending.emit("message", { type: "ready", port: backendPort });

    const res = await request(indexModule.proxy).get("/api/climbs");
    expect(res.status).toBe(502);
  });
});
