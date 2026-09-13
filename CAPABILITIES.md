# Capabilities — What This System Does Autonomously

Status of the autonomous options-trading system on `main`. Everything in
**Fully autonomous** runs with zero humans and zero frontend attached.

## Legend

| Mark | Meaning |
|---|---|
| 🤖 | Fully autonomous — runs headless, no human input |
| 🛡️ | Autonomous self-protection — acts without asking |
| 🎛️ | Human-in-the-loop control (control plane) |
| 📊 | Observable via WS / logs / REST |

---

## 1. Autonomous operation

| Capability | How | Mark |
|---|---|---|
| Headless long-run | HTTP server **or** pure sidecar entry; frontend optional | 🤖 |
| Crash survival | `uncaughtException` / `unhandledRejection` caught, logged `fatal`, process continues | 🤖 |
| Graceful degradation | Postgres → memory; Redis → no-op; Ollama → deterministic agent; WS → REST polling | 🤖 |
| Market-hours awareness | Pure IST clock: pre-open / 09:15–15:30 / post-close / weekends | 🤖 |
| Clean shutdown | SIGTERM/SIGINT → engines stop, WS/HTTP close, final logs | 🤖 |

## 2. Market data

| Capability | Detail | Mark |
|---|---|---|
| Real-time index ticks | DhanHQ binary WS: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, INDIAVIX | 🤖 |
| REST polling fallback | 3s cadence while WS is down; source tracked (`ws/rest/none`) | 🤖 |
| Tick staleness tracking | Feed age feeds the Stale Market Tick breaker | 🤖 🛡️ |
| Live option chains | Full strike ladder by symbol + expiry | 📊 |
| Black-Scholes Greeks | Delta/gamma/theta/vega computed from the live chain | 📊 |
| Rolling/expired options | Historical rolling-option candles via SDK | 📊 |
| On-demand instrument subscribe | Extra LTP subscriptions over the same WS | 🤖 |

## 3. Position management (the heart of autonomy)

| Capability | Trigger | Mark |
|---|---|---|
| Mark-to-market | Every 2s during market hours, from live ticks | 🤖 |
| Stop-loss exit | PositionMonitor signal → position closed autonomously | 🤖 |
| Target exit | same | 🤖 |
| Trailing-stop exit | same | 🤖 |
| Per-strategy loss guardrail | Strategy PnL ≤ −limit → legs squared off | 🤖 🛡️ |
| EOD square-off | 15:20 IST one-shot daily, all positions closed | 🤖 🛡️ |
| Portfolio snapshots | Published to UI + logs every cycle | 📊 |

## 4. Risk supervision (always on)

| Breaker | Effect | Mark |
|---|---|---|
| Daily loss limit | **Hard** — auto-arms kill switch | 🛡️ |
| Margin utilization | Hard-cap alerting | 🛡️ |
| Consecutive losses | Throttle | 🛡️ |
| Order rejection rate | Throttle (≥5 orders) | 🛡️ |
| Stale market tick | Blocks new entries via `canTrade()` | 🛡️ |
| EOD proximity | De-risk warning | 🛡️ |
| **Kill switch** | Squares off all paper positions; engages DhanHQ Trader's Control kill switch in live mode; halts all order paths | 🛡️ 🎛️ |

- Every order path — manual UI, strategy deploy, agent, Redis intent —
  funnels through the same `canTrade()` gate.
- Risk limits live-tunable via REST, no restart. Persistent across restarts.
- Alerts fire on **state transitions only** (no storms), persisted to DB.

## 5. Agentic trading (optional brain)

| Capability | Detail | Mark |
|---|---|---|
| Six-persona ReAct loop | planner → analyst → strategy → risk → execution → critic | 🤖 |
| 44 real DhanHQ tools | SDK `AgentToolRegistry`, policy-gated (market data, funds, positions, orders) | 🤖 |
| LLM reasoning | Ollama when reachable; otherwise labeled deterministic mode | 🤖 |
| Objective parsing | Detects symbols + trade intent from natural language | 🤖 |
| ATM resolution | From the live chain — no chain, no trade | 🤖 |
| Risk-gated execution | Trades only when `canTrade()` passes and zero breakers tripped | 🤖 🛡️ |
| Run telemetry | Every step/tool call streamed + persisted (`agent_events`) | 📊 |
| Never fabricates | No chain/LTP ⇒ honest "NO TRADE"; deterministic mode always labeled | 🤖 |

Trigger: `POST /api/control/agent/run {objective}` — or let it run and
read the events later.

## 6. Execution engines

| Capability | Paper | Live |
|---|---|---|
| Fill pricing | Live LTP ± slippage; unpriceable ⇒ **rejected** | Real exchange fills via order-update WS |
| Order lifecycle telemetry | fill / rejection envelopes on the bus | same |
| SL/target/trail monitoring | PositionMonitor | PositionMonitor |
| Redis fill broadcast | `dhan:execution:fills` | same |
| Mode switch | `TRADING_MODE=paper\|live` — one env, whole system | |

## 7. Control plane (human surface)

| Control | Endpoint |
|---|---|
| System state | `GET /api/control/state` |
| Arm kill switch | `POST /api/control/kill {confirm:"CONFIRM"}` |
| Disarm | `POST /api/control/kill/reset` |
| Toggle autonomy | `POST /api/control/autonomy {enabled}` |
| Square off everything | `POST /api/control/square-off` |
| Read / tune risk limits | `GET/POST /api/control/risk-limits` |
| Run the agent | `POST /api/control/agent/run {objective}` |
| Agent status / events / tools | `GET /api/control/agent/*` |
| Alerts | `GET /api/control/alerts` (+ test) |

Plus live telemetry over `/ws` with history hydration, and portfolio /
market REST. **None of it is required for the system to trade.**

## 8. Observability

| Capability | Detail |
|---|---|
| Structured JSON logs | Pino stdout: service/env/version/mode + module |
| Request correlation | `x-request-id` reuse + echo; OTel `traceparent` binding |
| Secret redaction | Tokens/TOTP/PINs/auth headers `[REDACTED]` centrally |
| Unified event stream | Bus→stdout bridge mirrors all UI events into logs |
| Frontend ingest | `POST /api/client-logs` (validated, rate-limited) |
| Error capture | Per-region ErrorBoundary + global handlers (frontend); central error middleware + fatal guards (backend) |
| Flood guard | Per-minute budget on bridge output |
| Health | `GET /api/health` — mode, persistence, kill/autonomy, tick source, uptime |

## 9. What it will NOT do

- **Go live implicitly** — default is paper; `TRADING_MODE=live` is an
  explicit operator decision.
- **Trade through tripped breakers** — risk gate outranks everything,
  including the agent.
- **Trade on stale data** — stale-tick breaker blocks entries.
- **Fake a fill** — no live LTP ⇒ rejection, always.
- **Invent analysis** — unreachable LLM ⇒ labeled deterministic mode;
  unreachable market ⇒ honest errors.
- **Depend on the frontend** — the UI can stay closed for days; the
  backend boots, trades, protects itself and logs everything regardless.

## 10. Requirements to run

| Needed for | Requirement |
|---|---|
| Trading (mandatory) | `DHAN_CLIENT_ID` + (`DHAN_ACCESS_TOKEN` or `DHAN_PIN`+`DHAN_TOTP_SECRET`, or Redis-held token) |
| Durability (optional) | `DATABASE_URL` (PostgreSQL) |
| Rails bridge (optional) | `REDIS_URL` |
| LLM reasoning (optional) | `OLLAMA_BASE_URL` + `OLLAMA_MODEL` |
| Deploy artifact | Docker image: `ghcr.io/shubhamtaywade82/axis-nexus:main` (CI-built) |
