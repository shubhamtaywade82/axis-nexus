# Axis Nexus — Autonomous Options Trading System (DhanHQ)

A Node.js **autonomous options trading backend** + **control-plane frontend** for
[DhanHQ v2](https://dhanhq.co/docs/v2/), built on
[`@nemesis-oss/dhanhq-sdk`](https://github.com/shubhamtaywade82/dhanhq-sdk).

The backend runs **free of the frontend**: market data ingestion, risk
evaluation, strategy supervision, EOD square-off and the agentic AI loop all
execute server-side on their own timers. The frontend is a **control plane** —
a read-mostly window that issues control commands (kill switch, autonomy
toggle, risk limits, agent runs) over REST and receives telemetry over a
WebSocket stream.

```
┌───────────────────────────── Backend (autonomous core) ─────────────────────────────┐
│                                                                                     │
│  MarketDataService ──── DhanHQ binary WS (ticks) + REST fallback, always-on         │
│        │                                                                            │
│  EventBus ──────────── central bus: tick/log/alert/telemetry/risk/portfolio/order    │
│        │                              │                                             │
│  RiskEngine ────────── real circuit breakers, kill switch (paper + broker-side)      │
│        │                                                                            │
│  AutonomyEngine ────── mark-to-market, exit signals, strategy guardrails,           │
│        │               EOD square-off (15:20 IST) — runs with zero UI clients       │
│        │                                                                            │
│  AgentOrchestrator ─── 6-persona ReAct loop (Ollama reasoning + 44 SDK tools,        │
│                        deterministic fallback that is explicitly labeled)            │
│                                                                                     │
│  Persistence: PostgreSQL (paper wallet/orders/positions/strategies, alerts,          │
│               agent events, risk state) — in-memory fallback when PG is down        │
└────────────┬────────────────────────────────────────────────────────────────────────┘
             │ REST /api/*          WebSocket /ws (channel envelopes)
┌────────────┴────────────────────────────────────────────────────────────────────────┐
│  Frontend (Vite + React) — Dashboard, Options Chain, Greeks, Positions, Orders,      │
│  Agent Console (live telemetry), Risk & Margin, Infra health, Config, Logs, Alerts   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# Backend (needs Node 20+; PostgreSQL/Redis optional, degrades gracefully)
cp .env.example .env          # add DHAN_CLIENT_ID + DHAN_ACCESS_TOKEN (or TOTP secrets)
npm install
npm run dev:server            # http://localhost:3003

# Frontend control plane
npm run dev:frontend          # http://localhost:5173

# Tests (work without any external service)
npm test
```

## Modes

| `TRADING_MODE` | Behavior |
|---|---|
| `paper` (default) | Orders fill against **live market LTP** (+ slippage model) into the PostgreSQL paper wallet. Unpriceable orders are rejected, never filled at invented prices. |
| `live` | Real orders through DhanHQ v2 with settlement resolved from the order-update WebSocket. Additionally gated by the SDK's own write policy (`DHANHQ_MCP_ENABLE_WRITES=true`). |

## Architecture guarantees

1. **No fabricated data.** Quotes, option chains, Greeks, infra stats, agent
   output — every value comes from a live DhanHQ call or real runtime state.
   When data is unavailable the API returns an explicit error/stale marker.
2. **Backend autonomy.** Kill the frontend and the backend keeps marking
   positions, enforcing breakers, closing positions on stop-loss/target
   signals and squaring off at EOD.
3. **Risk gates everything.** The kill switch and EOD window block the paper
   engine, the live engine, manual control-plane orders, strategy deploys
   and agent runs alike. Breaching the daily loss limit arms the kill switch
   autonomously and squares off every position.
4. **Honest agent fallback.** With Ollama unreachable, agent runs continue in
   deterministic mode — same real tool calls, template reasoning explicitly
   labeled `deterministic`. No fake "analysis" text is ever emitted.

## REST surface

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` — mode, persistence, kill state, market source |
| Market | `GET /api/market/indices`, `/option-chain/:symbol`, `/quote/:id`, `/greeks`, `/options-analysis` |
| Portfolio | `GET /api/portfolio/positions·orders·trades·funds·holdings·profile·strategies` |
| Paper | `POST /api/portfolio/paper/order·positions/close·wallet/reset·strategy/*` |
| Control | `GET /api/control/state`, `POST /api/control/kill`, `/kill/reset`, `/autonomy`, `/square-off`, `GET/POST /api/control/risk-limits` |
| Agent | `POST /api/control/agent/run`, `GET /api/control/agent/status·events·tools` |
| Alerts | `GET /api/control/alerts` |
| Infra | `GET /api/infra/stats` — real service telemetry |
| LLM | `POST /api/ollama/chat`, `GET /api/ollama/health·models` |

## WebSocket protocol (`/ws`)

Server → client envelopes: `{ channel, ts, payload }` with channels
`tick | log | alert | telemetry | risk | portfolio | order | system`.
Client → server: `{ "type": "subscribe", "channels": [...] }` (default all),
`{ "type": "ping" }`. On connect the server hydrates recent history — no
seeded/fabricated state exists anywhere.

## Redis intent bridge (legacy sidecar)

`src/index.ts` is a headless entry that boots the same autonomous core and
additionally subscribes to `dhan:execution:intents` (the original Rails
bridge). Core events are mirrored to `dhan:events:*` channels when Redis is
available.

## Configuration

See `.env.example`. Key variables: `TRADING_MODE`, `DHAN_ACCESS_TOKEN` (or
`DHAN_PIN`+`DHAN_TOTP_SECRET` for TOTP), `DATABASE_URL`, `REDIS_URL`,
`OLLAMA_BASE_URL`/`OLLAMA_MODEL`, risk limits (`RISK_DAILY_MAX_LOSS`,
`RISK_MAX_QUANTITY`).

Risk limits are also live-tunable from the Config page via
`POST /api/control/risk-limits` and are enforced by the backend engine on
every order path.

## Observability & logging

Structured logging spans both sides of the stack with one vocabulary and
one searchable stream — query by `requestId` or `sessionId` and you see
the frontend event *and* every backend line it triggered.

**Backend (Pino + pino-http)** — machine-queryable JSON on stdout in
production, `pino-pretty` in development.

- Every line carries `service`, `env`, `version`, `mode` plus a `module`
  (`server` / `auth` / `db` / `ws` / `bus` / `portfolio` / `client-logs`).
- ISO 8601 timestamps; levels `fatal→error→warn→info→debug→trace` via
  `LOG_LEVEL`.
- HTTP access logging with method, URL, status, latency; `/api/health`
  polling is excluded to keep the stream readable.
- Correlation: an inbound `x-request-id` (or `x-correlation-id`) is
  reused, echoed back on the response, and bound to `req.log`; a W3C
  `traceparent` header's `traceId`/`spanId` are folded in for
  OpenTelemetry log↔trace linking without running an OTel SDK.
- Redaction: DhanHQ access tokens, TOTP secrets, PINs, `authorization`/
  `cookie` headers etc. are centrally censored to `[REDACTED]`.
- **EventBus→stdout bridge**: everything the backend already streams to
  the UI (logs, alerts, order fills/rejections, system lifecycle) is
  mirrored into the same structured stream, with a per-minute flood
  budget (`BUS_BRIDGE_BUDGET`) so a runaway loop can't saturate stdout.
- Central error middleware: unhandled route errors are logged with
  request id + stack and answered as `{ error }` JSON; unknown `/api/*`
  paths get a JSON 404.
- `uncaughtException` / `unhandledRejection` are logged at `fatal`
  (and reported on the bus) instead of crashing the autonomous core.

**Frontend (control plane)**

- `services/logger.ts` — structured client logger. Errors always ship;
  other levels are sampled (`VITE_LOG_SAMPLE_RATE`, default 0.2).
  Batches flush every 5s and via `sendBeacon` on page unload.
- `POST /api/client-logs` ingests them (zod-validated, size-capped,
  rate-limited per IP) and writes `source: "frontend"` lines into the
  same Pino stream.
- Every API call sends an `x-request-id`; failures are logged with
  endpoint, status, duration and the correlation id. The WS stream logs
  connect/disconnect/reconnect with backoff attempts.
- `components/ErrorBoundary.tsx` catches render crashes per region
  (a broken panel never takes down the kill-switch UI) and reports them
  with component stacks; `services/globalHandlers.ts` installs
  `window.onerror` + `unhandledrejection` handlers at boot.

**What you get out of the box**

```jsonc
// backend access log (one request, correlated end-to-end)
{"level":30,"time":"2026-08-29T05:20:49.098Z","service":"axis-nexus","env":"production",
 "req":{"id":"test-req-abc12345","method":"POST","url":"/api/control/kill"},
 "responseTime":3,"msg":"POST /api/control/kill → 200"}

// frontend event ingested into the same stream
{"level":50,"time":"...","source":"frontend","sessionId":"…","release":"1.0.0",
 "requestId":"…","msg":"API request failed","status":502,"endpoint":"/api/market/greeks"}
```

Ship stdout to any aggregator (Grafana Loki, Datadog, Axiom, CloudWatch)
and alert on: `level>=50` rate spikes, `channel":"order","kind":"rejection"`
bursts, kill-switch `system` events, or `module":"market_data` staleness
warnings.
