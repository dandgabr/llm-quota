/**
 * llm-quota API process entrypoint.
 *
 * Boots the HTTP server (TLS 1.3 policy, CORS, audit logging, collector
 * scheduler) from the environment. This is what the Docker/compose `api`
 * service runs.
 */
import { start } from "./server.js";

const started = start();
let exiting = false;

// Graceful shutdown on SIGTERM/SIGINT (containers): stop the collector, close
// keep-alive sockets + the DB pool, with a hard 10 s force-exit so a hung
// socket can never wedge the container past the orchestrator's kill window.
async function shutdown(): Promise<void> {
  if (exiting) return;
  exiting = true;
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref?.();
  try {
    await started.close();
    process.exit(0);
  } catch (err) {
    console.error("[llm-quota] shutdown error", err);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
