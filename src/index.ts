import './lib/env';
import { startCore, resolveExecutionEngine } from "./core";
import { getTradingMode } from "./lib/tradingMode";
import Redis from "ioredis";
import type { Core } from "./core";
import { moduleLogger, logError } from "./lib/logger";
import { attachBusLoggerBridge } from "./lib/busLoggerBridge";

const log = moduleLogger("sidecar");

// Default Node behavior is to crash the process on these, which kills the whole `bin/dev`
// foreman group (any Procfile process exiting triggers SIGTERM to all). This is an auxiliary
// execution sidecar — it must never take the Rails trading daemon down with it.
process.on("uncaughtException", (e) =>
  log.fatal({ err: { name: e.name, message: e.message, stack: e.stack } }, "Uncaught exception"));
process.on("unhandledRejection", (e: any) =>
  log.fatal({ err: { name: e?.name, message: e?.message || String(e), stack: e?.stack } }, "Unhandled rejection"));

/**
 * Headless sidecar entry (no HTTP server).
 *
 * Boots the SAME autonomous core as the API server — market data feed,
 * risk engine, autonomy loop, agent orchestrator — and additionally
 * listens for execution intents on Redis (`dhan:execution:intents`),
 * the legacy Rails bridge. The system runs and trades autonomously
 * whether or not anything else is attached.
 */
async function main() {
  log.info({ mode: getTradingMode() }, "Starting DhanHQ-TS Execution Sidecar (headless)");

  let intentSubscriber: Redis | null = null;
  try {
    const core = await startCore();
    // Mirror EventBus telemetry into the structured stdout log — same
    // unified stream as the HTTP server variant.
    attachBusLoggerBridge();
    intentSubscriber = await listenForIntents(core);
    log.info("Process ready — autonomous stack running; listening for Rails Redis intents");
  } catch (e) {
    logError(log, "Initialization error", e);
  }

  // Graceful shutdown — the sidecar has no HTTP server to close, but the
  // Redis subscriber and the autonomous core must still stop cleanly so
  // in-flight intents aren't orphaned mid-execution and the journal closes
  // before the process exits. Mirrors server.ts's shutdown() handler.
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Sidecar shutdown initiated");
    try {
      if (intentSubscriber) {
        await intentSubscriber.quit().catch(() => {});
      }
      // journal.close() schedules a final flush; awaiting it prevents a
      // race where the process exits before the last entries land on disk.
      const { journal } = await import("./services/journal");
      await journal.close();
    } catch (e: any) {
      log.warn({ err: { message: e?.message || String(e) } }, "Sidecar shutdown cleanup error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function listenForIntents(core: Core): Promise<Redis> {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379/0";
  const intentSubscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 1000, 10000)),
  });
  intentSubscriber.on('error', () => { /* Redis optional in headless mode */ });

  intentSubscriber.subscribe("dhan:execution:intents", (err) => {
    if (err) {
      log.error({ err: { message: err.message }, channel: "dhan:execution:intents" }, "Subscribe error");
      return;
    }
    log.info({ channel: "dhan:execution:intents" }, "Subscribed to execution intents");
  });

  intentSubscriber.on("message", async (channel, message) => {
    if (channel !== "dhan:execution:intents") return;
    try {
      const intent = JSON.parse(message);
      log.info({ intentId: intent.intent_id, strategy: intent.strategy }, "Processing execution intent");
      const engine = resolveExecutionEngine(core, getTradingMode());
      await engine.placeOrder(intent);
    } catch (e: any) {
      logError(log, "Execution failed", e);
    }
  });
  return intentSubscriber;
}

main();
