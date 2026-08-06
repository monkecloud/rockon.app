import { fork } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Entry point / process manager. The actual Express API lives in worker.js,
// forked below as an independent child process — this file never touches
// climbs.json or users.json itself. All it does is:
//
//   1. Own the real PORT and proxy every request to whichever worker
//      process is currently "active".
//   2. Fork a worker on startup and wait for it to report it's listening
//      (on its own OS-assigned port) before routing any traffic to it.
//   3. Whenever a worker writes to climbs.json (see writeClimbs() in
//      worker.js, which pings us over IPC), fork a *new* worker, wait for
//      *it* to report ready, then atomically swap it in as active, tell
//      the old worker to shut down, and give it a grace period to finish
//      any in-flight requests before force-killing it.
//
// Workers are spawned with plain child_process.fork() rather than the
// cluster module on purpose: cluster transparently shares/round-robins the
// listening socket across workers bound to the same port (including
// port 0), which fights this file's "exactly one active worker, chosen by
// us" design. Plain child processes just get an IPC channel, nothing more.
//
// Because the primary keeps the real port open the entire time and workers
// only ever listen on throwaway ports, there's never a moment where the
// port is closed — restarts triggered by a climbs.json update are invisible
// to clients (no dropped connections, no "connection refused" blip).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, "worker.js");
const PORT = process.env.PORT || 25100;
// If a retiring worker hasn't finished its in-flight requests and exited on
// its own within this long, force it closed rather than leak it forever.
const OLD_WORKER_KILL_TIMEOUT_MS = 15000;

let activeWorker = null;
let activeWorkerPort = null;
let pendingWorker = null;
// A climbs-updated message that arrived while a restart was already in
// flight — coalesced into one more restart right after the current one
// finishes, instead of forking a pile of overlapping workers.
let restartQueued = false;

// Snapshot of module state, exported for tests — production code never
// reads this, it uses the closure variables above directly.
export function getState() {
  return { activeWorker, activeWorkerPort, pendingWorker, restartQueued };
}

export function retireWorker(worker) {
  if (!worker) return;
  const killTimer = setTimeout(() => worker.kill(), OLD_WORKER_KILL_TIMEOUT_MS);
  worker.once("exit", () => clearTimeout(killTimer));
  // Ask nicely first: worker.js closes its HTTP server on this message,
  // which stops it accepting new requests but lets in-flight ones finish
  // before it calls process.exit() itself.
  worker.send({ type: "shutdown" });
}

// Attached once per forked worker, for its whole lifetime — not just while
// it's "pending" — since the *active* worker is the one that'll actually
// receive the next climbs.json-writing request and need to send the next
// "climbs-updated" message.
export function handleWorkerMessage(worker, msg) {
  if (msg?.type === "climbs-updated") {
    startWorker();
    return;
  }
  if (msg?.type !== "ready" || worker !== pendingWorker) return;

  const oldWorker = activeWorker;
  activeWorker = pendingWorker;
  activeWorkerPort = msg.port;
  pendingWorker = null;

  retireWorker(oldWorker);

  if (restartQueued) {
    restartQueued = false;
    startWorker();
  }
}

export function startWorker() {
  if (pendingWorker) {
    restartQueued = true;
    return;
  }

  // Captured in a local so the listener below always refers to *this*
  // worker, even after `pendingWorker` (the outer, mutable variable) gets
  // reassigned once this one is promoted to active or a newer one starts.
  const worker = fork(WORKER_PATH);
  pendingWorker = worker;
  worker.on("message", (msg) => handleWorkerMessage(worker, msg));
}

// Skipped under the test runner (NODE_ENV=test) so importing this module for
// unit tests doesn't fork a real worker process — tests drive startWorker()
// explicitly against a mocked child_process.fork instead.
if (process.env.NODE_ENV !== "test") {
  startWorker();
}

export const proxy = http.createServer((clientReq, clientRes) => {
  if (!activeWorkerPort) {
    clientRes.writeHead(503, { "Content-Type": "text/plain" });
    clientRes.end("Server starting, try again in a moment.");
    return;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: activeWorkerPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
    }
  );
  proxyReq.on("error", () => {
    clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end("Bad gateway");
  });
  clientReq.pipe(proxyReq);
});

// child_process.fork()'d workers aren't tied to this process's lifetime on
// their own — without this they'd become orphans (still holding their
// throwaway ports) if the primary is stopped directly (Ctrl+C, kill, etc.).
export function shutdown() {
  if (activeWorker) activeWorker.kill();
  if (pendingWorker) pendingWorker.kill();
  process.exit(0);
}

if (process.env.NODE_ENV !== "test") {
  proxy.listen(PORT, () => {
    console.log(`API proxy running at http://localhost:${PORT}`);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
