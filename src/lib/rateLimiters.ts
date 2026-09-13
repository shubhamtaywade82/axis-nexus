import rateLimit, { type Options } from 'express-rate-limit';

/**
 * Per-route rate limiters for the control plane.
 *
 * Why this exists: a runaway script, a buggy render loop in the frontend,
 * or a compromised browser tab could otherwise hammer
 *   POST /api/control/kill
 *   POST /api/portfolio/paper/order
 *   POST /api/control/agent/run
 * unbounded. Each of these is a force-multiplier — a kill-switch spam
 * could log-jam the autonomy engine; an order-placement spam could
 * exhaust the paper wallet or trigger the rejection-rate breaker for no
 * real reason.
 *
 * Three presets, sized to actual usage:
 *   - writeLimiter: 60 req/min per IP on order/strategy/kill-switch writes.
 *     A human operator clicks slowly; a script doesn't. 60/min is generous
 *     for any legitimate manual flow and tight enough to stop a flood.
 *   - agentLimiter: 6 req/min per IP on /api/control/agent/run. Each agent
 *     run takes 10-30 seconds and consumes LLM tokens — a flood would
 *     queue dozens of runs and exhaust the Ollama budget. The agent's own
 *     `running` mutex already rejects concurrent runs with a 409; this
 *     limiter stops the queue from filling up in the first place.
 *   - clientLogLimiter: not defined here — /api/client-logs already has
 *     its own per-IP token bucket in routes/clientLogs.ts (it needs a
 *     custom shape to handle batched events, not a per-request limiter).
 *
 * The limiter uses an in-memory store (default) — sufficient for a
 * single-process backend. If the backend is ever scaled horizontally,
 * swap in `rateLimitRedisStore` from `rate-limit-redis` and pass the
 * existing ioredis client; no other changes needed.
 *
 * Behind the loopback boundary the limiters are still useful — a buggy
 * frontend loop is the most likely flood source, not an attacker.
 */

const minute = 60 * 1000;

/** Standard write-rate cap — 60 req/min/IP across all order & control writes. */
export const writeLimiter = rateLimit({
  windowMs: minute,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // 429 with the JSON shape the frontend's error handler already expects.
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many write requests — slow down.',
      retryAfter: Math.ceil(minute / 1000),
    });
  },
  // Skip the health check (it polls continuously) and any GET — the limit
  // is for writes, not reads. Skipping GETs here means a dashboard polling
  // /positions every 2s never trips the limit.
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.path === '/api/health',
} as Partial<Options>);

/** Tighter cap on agent runs — 6/min/IP, since each run is expensive. */
export const agentRunLimiter = rateLimit({
  windowMs: minute,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many agent runs requested — wait a minute and retry.',
      retryAfter: Math.ceil(minute / 1000),
    });
  },
  skip: (req) => req.method !== 'POST',
} as Partial<Options>);
