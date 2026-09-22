import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import './lib/env';
import { getTradingMode } from './lib/tradingMode';
import { startCore } from './core';
import { marketRoutes } from './routes/market';
import { portfolioRoutes } from './routes/portfolio';
import { ollamaRoutes } from './routes/ollama';
import { infraRoutes } from './routes/infra';
import { controlRoutes } from './routes/control';
import { MarketStreamManager } from './ws/marketStream';
import { dbMode } from './db';
import { eventBus } from './services/eventBus';
import { journal } from './services/journal';
import { moduleLogger, logError } from './lib/logger';
import { requestLogger, errorHandler, notFoundHandler } from './lib/requestLogger';
import { attachBusLoggerBridge } from './lib/busLoggerBridge';
import { clientLogsRoutes } from './routes/clientLogs';
import { researchRoutes } from './routes/research';
import { scalpRoutes } from './routes/scalp';
import { expertTradesRoutes } from './routes/expertTrades';
import { extractBearer, safeTokenCompare } from './lib/authToken';
import { writeLimiter, agentRunLimiter } from './lib/rateLimiters';


const PORT = Number(process.env.PORT) || 3003;
const HOST = process.env.CONTROL_PLANE_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.CONTROL_PLANE_ORIGIN || 'http://localhost:5175';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN || '';
// In production, the control plane MUST NOT accept the loose
// `http://(localhost|127.0.0.1):<any-port>` origin allowlist — any local
// process or webpage could then POST to /api/control/kill. Dev mode keeps
// the regex for the convenience of running Vite on arbitrary ports.
const IS_PROD = process.env.NODE_ENV === 'production';
const isLoopbackHost = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const log = moduleLogger('server');

// The autonomous trading server must NEVER crash on an async surprise —
// a crashed backend leaves live positions unmonitored.
process.on('uncaughtException', (e) => {
  log.fatal({ err: { name: e.name, message: e.message, stack: e.stack } }, 'Uncaught exception');
  eventBus.log('ERROR', `Uncaught exception: ${e.message}`, 'server');
});
process.on('unhandledRejection', (e: any) => {
  log.fatal({ err: { name: e?.name, message: e?.message || String(e), stack: e?.stack } }, 'Unhandled rejection');
  eventBus.log('ERROR', `Unhandled rejection: ${e?.message || e}`, 'server');
});

async function main() {
  log.info({ port: PORT }, 'Starting Axis Nexus Autonomous Trading Server');

  // 1. Boot the autonomous core FIRST — it must survive even if the
  //    HTTP layer fails, and it must never depend on a frontend.
  const core = await startCore();

  // 2. Mirror all EventBus telemetry (logs/alerts/orders/lifecycle) into
  //    the structured stdout log — one stream for backend + WS events.
  attachBusLoggerBridge();

  // 3. HTTP + WS control plane (frontend is an observer/controller only).
  //
  // Security posture:
  //   - Loopback (default): CONTROL_PLANE_TOKEN is optional but recommended.
  //     A warning is logged when unset. CORS still allows the regex
  //     `http://(localhost|127.0.0.1):<port>` for dev convenience.
  //   - Non-loopback (HOST != 127.0.0.1, e.g. a Docker `-p 3003:3003`
  //     publish): CONTROL_PLANE_TOKEN is MANDATORY. Boot aborts without it
  //     — an unauthenticated order-placement API on a network-reachable
  //     interface is the single most dangerous misconfiguration for an
  //     autonomous trading server.
  //   - Production (NODE_ENV=production): CORS uses exact-origin matching
  //     only; the localhost:port regex is dropped. A published Docker image
  //     is not a single-laptop dev setup and must not be treated as one.
  //
  // Token comparison is constant-time (lib/authToken.ts) — a plain `!==`
  // short-circuits on the first differing byte and leaks the secret's
  // prefix length through response-time side channels.
  if (!isLoopbackHost && !CONTROL_PLANE_TOKEN) {
    throw new Error(
      'CONTROL_PLANE_TOKEN is required when CONTROL_PLANE_HOST is not loopback — ' +
      'an unauthenticated control plane must never bind to a network interface. ' +
      'Set CONTROL_PLANE_TOKEN or bind to 127.0.0.1.',
    );
  }
  if (!CONTROL_PLANE_TOKEN) {
    log.warn('CONTROL_PLANE_TOKEN not set — order/kill-switch endpoints are unauthenticated (CORS-origin-restricted only). Set it to require a bearer token.');
  } else {
    log.info({ loopback: isLoopbackHost, production: IS_PROD }, 'Control-plane token authentication enabled');
  }

  const app = express();

  // Security headers (helmet). The backend serves JSON only — the React
  // SPA lives on a different origin (Vite :5175 dev / static host in prod)
  // so we don't need a permissive CSP for inline scripts/styles here.
  // Default helmet gives us:
  //   - X-Content-Type-Options: nosniff (MIME sniffing attacks)
  //   - X-Frame-Options: DENY (clickjacking)
  //   - Strict-Transport-Security (when behind HTTPS, ignored on http)
  //   - X-DNS-Prefetch-Control: off
  //   - Referrer-Policy: no-referrer
  //   - Cross-Origin-* Policies
  // We relax only contentSecurityPolicy: the default is too strict for
  // a JSON API that talks to a browser fetch() on a different origin
  // (it would block the very preflight CORS relies on), and the WS
  // upgrade is on a separate path. Set explicit directives rather than
  // disabling entirely.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        // No HTML is served from this origin — connectSrc is irrelevant
        // for the API itself, but explicit 'none' would block a browser
        // preview of a JSON response from fetching its own inline source
        // map. Leave it permissive; the SPA's CSP is its own concern.
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The control plane is its own origin — never renderable in a frame
    // on someone else's page (defense-in-depth against clickjacking even
    // though X-Frame-Options: DENY already covers this).
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  const allowedOrigins = [ALLOWED_ORIGIN, 'http://localhost:5175', 'http://127.0.0.1:5175', 'http://localhost:5173', 'http://127.0.0.1:5173'];
  app.use(cors({
    origin: (origin, cb) => {
      // No Origin header = same-origin or non-browser client (curl, the
      // SDK) — always allow. Browsers always send Origin on cross-site
      // requests; the absence is a permit for tooling, not a hole.
      if (!origin) { cb(null, true); return; }
      if (allowedOrigins.includes(origin)) { cb(null, true); return; }
      // Dev-only convenience: any localhost port. Dropped in production
      // so a hosted image can't be reached by an arbitrary local process.
      if (!IS_PROD && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }));
  // Explicit body-size cap: protects against memory pressure from large
  // malformed payloads. 1 MiB is generous for the JSON the control plane
  // actually receives (largest legit payload is a multi-leg strategy deploy
  // at a few KB); default Express limit (~100 KB) was too tight for some
  // options-chain responses on the read paths.
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger); // access logs + req.log child (requestId/traceId)
  app.use((req, res, next) => {
    if (!CONTROL_PLANE_TOKEN || req.path === '/api/health') return next();
    const presented = extractBearer(req.get('authorization'));
    if (!presented || !safeTokenCompare(presented, CONTROL_PLANE_TOKEN)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  const streamManager = new MarketStreamManager();
  streamManager.attach(); // bind hub to the central event bus

  app.use('/api/market', marketRoutes(core.client, core.market));
  // Rate-limit write routes (POST/PUT/DELETE) — writeLimiter skips GETs
  // internally so dashboard polling never trips it. 60 req/min per IP is
  // generous for any manual operator flow and stops a runaway script.
  app.use('/api/portfolio', writeLimiter, portfolioRoutes(core.client, core.market, core.risk, core.paper, core.agent, core.portfolio, core.sandboxClient));
  app.use('/api/ollama', ollamaRoutes());
  app.use('/api/infra', infraRoutes(streamManager, { market: core.market, risk: core.risk, autonomy: core.autonomy, agent: core.agent, stream: streamManager }));
  // Agent runs get their own tighter cap (6/min) because each run is
  // expensive (10-30s, LLM tokens). The agent's own `running` mutex
  // already rejects concurrent runs with 409; this stops the queue from
  // filling up before the mutex ever sees them.
  app.use('/api/control/agent/run', agentRunLimiter);
  app.use('/api/control', writeLimiter, controlRoutes(core.client, core.risk, core.autonomy, core.agent, core.market, core.sandboxClient));
  app.use('/api/client-logs', clientLogsRoutes());
  app.use('/api/research', researchRoutes(core.research, core.researchScheduler));
  app.use('/api/scalp', writeLimiter, scalpRoutes(core.scalp));
  app.use('/api/expert-trades', writeLimiter, expertTradesRoutes(core.expertTrades));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: getTradingMode(),
      persistence: dbMode(),
      killed: core.risk.isKilled(),
      autonomy: core.autonomy.isEnabled(),
      marketSource: core.market.stats().source,
      uptime: process.uptime(),
    });
  });

  // Central 404 + error handling — MUST come after all routes.
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Same token posture as the HTTP layer — enforced when set, with the
    // same constant-time comparison. The browser can't set Authorization
    // headers on a WebSocket handshake, so the token is passed as a
    // `?token=` query param (over wss:// in production; localhost-only in
    // dev is acceptable).
    verifyClient: CONTROL_PLANE_TOKEN
      ? (info, cb) => {
          const url = new URL(info.req.url || '/ws', 'http://internal');
          const presented = url.searchParams.get('token');
          cb(Boolean(presented) && safeTokenCompare(presented, CONTROL_PLANE_TOKEN));
        }
      : undefined,
  });

  wss.on('connection', (ws) => {
    streamManager.subscribe(ws);
    ws.on('close', () => streamManager.unsubscribe(ws));
    ws.on('error', () => streamManager.unsubscribe(ws));
  });

  // Loopback-only by default — was previously bound to every interface,
  // reachable from anywhere on the local network.
  server.listen(PORT, HOST, () => {
    log.info(
      { host: HOST, port: PORT, http: `http://${HOST}:${PORT}`, ws: `ws://${HOST}:${PORT}/ws`, persistence: dbMode() },
      'Control plane listening (HTTP + WebSocket)',
    );
  });

  // Graceful shutdown — stop services cleanly, keep positions consistent.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown initiated — stopping services cleanly');
    eventBus.log('SYSTEM', `Shutdown initiated (${signal})`, 'server');
    core.autonomy.stop();
    core.risk.stop();
    core.market.stop();
    core.selfHealing.stop();
    // Awaited: stream.end() only SCHEDULES the flush — exiting right after
    // calling it (as this function does next) can race the write and lose
    // the last entries from exactly the shutdown being journaled.
    await journal.close();
    wss.close();
    server.close();
    log.info({ signal }, 'Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logError(log, 'Fatal error during startup', e);
  process.exit(1);
});
