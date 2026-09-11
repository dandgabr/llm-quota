/**
 * llm-quota API process entrypoint.
 *
 * Boots the HTTP server (TLS 1.3 policy, CORS, audit logging) from the
 * environment. This is what the Docker/compose `api` service runs.
 */
import { start } from "./server.js";

const started = start();

// Graceful shutdown on SIGTERM/SIGINT (containers).
function shutdown() {
  started.close().then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
