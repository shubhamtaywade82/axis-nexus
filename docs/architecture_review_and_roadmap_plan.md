# Architecture Review & Implementation Roadmap: Axis Nexus Options Trading System

## Goal Description

Review the 48 architectural recommendations in [`docs/ARCHITECTURE_IMPROVEMENT.md`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/docs/ARCHITECTURE_IMPROVEMENT.md) alongside the two architecture diagrams (`ChatGPT Image Sep 3, 2026, 11_54_05 PM.png` and `ChatGPT Image Sep 3, 2026, 11_54_10 PM.png`).

The objective is to evaluate:

1. **Feasibility**: What is realistic and doable in the current `axis-nexus` codebase (TypeScript / Node.js / Express / PostgreSQL / Redis).
2. **Pragmatism & Guardrails**: What is high-impact vs. what is speculative enterprise over-engineering (violating the [Code Quality Guide](file:///home/nemesis/.ai/CODE_QUALITY.md) KISS/YAGNI principles) for running an autonomous paper-trading engine on a laptop with live DhanHQ REST & WebSocket feeds.
3. **Execution Plan**: A prioritized, safe, multi-phase roadmap that transforms the prototype into a self-healing, deterministic options trading platform without destabilizing working features.

---

## Executive Architectural Assessment

The current `axis-nexus` codebase is already remarkably well-structured compared to a typical trading prototype:

- **Strengths already present**:
  - Frontend-independent autonomous core ([`src/core.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/core.ts)).
  - Unified [`PortfolioSource`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/portfolioSource.ts) abstraction for Paper and Broker accounts.
  - Active [`RiskEngine`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/riskEngine.ts) with kill-switch, daily loss limits, and position caps.
  - Live DhanHQ binary WebSocket ingestion with REST polling fallback ([`src/services/marketData.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/marketData.ts)).
  - Multi-leg strategy construction for 12+ strategies ([`src/services/strategyConstructor.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/strategyConstructor.ts)).
  - Daily audit journal in NDJSON ([`src/services/journal.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/journal.ts)).
  - 29 test suites passing (213 unit/integration tests).

- **The Core Vulnerabilities**:
  1. **No Order/Strategy State Machine**: Execution is fire-and-forget loops over legs (`for (const leg of strat.legs) await paper.placeOrder(...)`). If Leg 1 fills and Leg 2 rejects, the system holds an unintended naked position with no atomic repair or rollback.
  2. **AI in the Direct Execution Loop**: [`AgentOrchestrator`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/agent.ts) scans, synthesizes, and directly executes orders. If Ollama stalls for 15 seconds, Node's event loop stutters.
  3. **In-Memory Derived Truth**: `PositionMonitor` and `mem` hold active stops and positions. If the Node process crashes, open stops are lost until `seedExistingPositions` rebuilds them, but unconfirmed in-flight orders are orphaned.
  4. **Optimistic Fill Pricing**: Paper execution fills immediately at `LTP ± fixed tick` without bid/ask spread checks, depth exhaustion, or limit order queues.

---

## Comparative Matrix: Diagrams vs Reality vs Recommendations

| Architectural Area | Diagram 1 (Overview) | Diagram 2 (Process Model) | Improvement Doc Recs | Current Code State | Verdict & Pragmatic Stance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Process Topology** | Monolith with layers | 4 OS Processes (Trading, Web, AI, Jobs) | 4 OS processes via Redis/PG | Single Node process (`core.ts`) | **Doable & Essential**: Split into 3-4 distinct tasks (`trading`, `web`, `ai`) to stop AI / HTTP from stalling trading ticks. |
| **Order State Machine** | "Order Manager" | "Order State Machine" | Strict transitions + `UNKNOWN` state | Simple `PENDING` -> `FILLED` / `REJECTED` | **Doable & P0 Priority**: Critical to prevent duplicate fills and handle timeouts safely. |
| **Multi-Leg Atomicity** | Strategy Orchestrator | Execution Planner | `StrategyOrder` with repair engine | Iterative loop over legs | **Doable & P0 Priority**: Add rollback / flattening when legs fail to fill. |
| **AI Role** | Decision Agent | Advisory `TradeProposal` via Redis | AI never executes; only proposes | Agent calls `executeStrategy()` | **Doable & P0 Priority**: Decouple AI to emit `TradeProposal`; deterministic core executes. |
| **Market Data** | REST + WS + Redis | Live feeds + Depth + Stale monitor | Per-instrument health, Bid/Ask | WS + REST fallback, feed-wide health | **Doable & P1 Priority**: Add Bid/Ask capture for realistic market order fills. |
| **Paper Fill Model** | Execution Simulator | Slippage & Latency Model | Full depth simulation, partial fills | `LTP ± fixed tick`, instant fill | **Doable & P1 Priority**: Use Bid/Ask spread and realistic slippage model. |
| **Time-Series DB** | InfluxDB | Mentioned in Diagram 1 | PostgreSQL / Timescale | PostgreSQL (`paper_orders`, etc.) | ❌ **NOT Recommended (YAGNI)**: InfluxDB is excessive for laptop paper trading. PostgreSQL is sufficient. |
| **Observability** | Prometheus + Sentry | Prometheus + Grafana + Sentry | Metrics & Timelines | Pino logger + EventBus + Journal | ❌ **NOT Recommended (YAGNI)**: Running Grafana/Prometheus/Sentry daemons locally wastes RAM/CPU. Use Pino + React UI. |
| **Secret Management** | HashiCorp Vault | Vault in Diagram 1 | Encrypted config | `.env` file | ❌ **NOT Recommended (YAGNI)**: Running Vault locally is overkill. Keep `.env` with file permissions. |
| **Object Storage** | S3 / MinIO | Object Storage in Diagram 1 | File/blob storage | Local `.journal/` + Postgres | ❌ **NOT Recommended (YAGNI)**: Local disk NDJSON and Postgres JSONB are cleaner and zero-maintenance. |

---

## User Review Required

> [!IMPORTANT]
> **Process Architecture Decision**:
> Diagram 2 proposes running 4 separate operating system processes (`trading-daemon`, `web-control`, `ai-worker`, `job-worker`) communicating over Redis Streams / PubSub.
>
> **Our Recommendation**: For local laptop paper-trading, we should implement a **Modular Multi-Process Architecture** managed via npm scripts / `concurrently` (or Node `Worker Threads` for the AI process), backed by Redis if enabled or local IPC fallback. We should **not** build a complex distributed microservices mesh.

> [!WARNING]
> **Decoupling AI from Execution**:
> Currently, the user or autonomous scan can trigger an agent run which calls Ollama and places trades directly. We will convert this into:
> `Market Scanner -> Opportunity -> AI Proposal -> Deterministic Risk Gate -> Order State Machine -> Execution`.
> The AI will **no longer have permission to place orders directly**.

---

## Detailed Analysis: What is Doable vs What is NOT

### 1. What IS Doable and MUST Be Done (P0 - Immediate Safety & Reliability)

#### A. Deterministic Order & Execution State Machine

- **Current problem**: Orders transition immediately from intent to `FILLED` or `REJECTED`. If a timeout happens, the system has no concept of `UNKNOWN` state.
- **Doable solution**:
  - Implement an explicit state transition machine:

    ```
    INTENT_CREATED -> VALIDATED -> RISK_APPROVED -> SUBMITTED -> [ACKNOWLEDGED] -> FILLED
                                                                 -> REJECTED
                                                                 -> UNKNOWN (on timeout)
                                                                 -> CANCELLED
    ```

  - For `UNKNOWN` state: Trigger a query to Dhan / local journal before ever allowing a retry.
  - Add `idempotency_key` (hash of strategy ID, leg index, timestamp window, action) on all orders to prevent double fills.

#### B. Multi-Leg Strategy Execution & Repair Engine

- **Current problem**: In [`src/services/strategyConstructor.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/strategyConstructor.ts), a 4-leg Iron Condor places legs one by one. If Leg 3 fails, Legs 1 and 2 remain open, exposing the account to unlimited naked risk.
- **Doable solution**:
  - Implement a `StrategyExecutionCoordinator`:

    ```
    STRATEGY_ORDER: [Leg 1, Leg 2, Leg 3, Leg 4]
    Status: PLANNED -> SUBMITTING_LEGS -> PARTIALLY_FILLED -> FILLED
                                       -> LEG_FAILED -> REPAIRING / EMERGENCY_FLATTEN
    ```

  - Deterministic repair rule: If hedge leg fails, immediately square off corresponding short leg. **No LLM involved in emergency risk exits**.

#### C. Decouple Agentic AI into Advisory Proposals

- **Current problem**: [`src/services/agent.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/agent.ts) holds the execution keys. If Ollama crashes or hallucinates bad legs, bad orders go to the paper engine.
- **Doable solution**:
  - Introduce `TradeProposal` contract:

    ```typescript
    interface TradeProposal {
      proposalId: string;
      underlying: 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
      strategyType: string;
      legs: Array<{ side: 'BUY' | 'SELL'; strike: number; optionType: 'CE' | 'PE'; expiry: string }>;
      thesis: string;
      confidence: number;
      expectedMaxRisk: number;
      expectedMaxReward: number;
      generatedAt: number;
    }
    ```

  - Trading Core receives proposals via event/queue, validates against live option chain, verifies risk parameters, and executes deterministically.

#### D. Startup Reconciliation & Invariant Verification

- **Current problem**: Booting seeds positions from `paper_positions`, but does not verify invariant consistency with `paper_orders` or broker state.
- **Doable solution**:
  - Implement `ReconciliationEngine`:
    1. Check `net_qty === buy_qty - sell_qty` for every position.
    2. Ensure every open strategy has matching open position legs.
    3. Verify stop-loss and targets are armed in `PositionMonitor`.
    4. Transition system status: `BOOTING -> SYNCING -> RECONCILING -> READY -> TRADING`.

---

### 2. What IS Doable and High-ROI (P1 - Performance & Accuracy)

#### A. Opportunity Engine (Pre-Filter for Agent)

- **Current problem**: Autonomy scans every index every 60s and runs full LLM prompts, burning CPU and tokens.
- **Doable solution**:
  - Pure deterministic scanner detects triggers:
    - PCR OI divergence (>1.2 or <0.8)
    - Supertrend 5m crossover
    - IV Percentile / Skew anomaly
    - Range breakout (ORB)
  - Only when a trigger fires is a candidate emitted to the AI worker to formulate a `TradeProposal`.

#### B. Realistic Paper Fill Model (Bid/Ask & Depth)

- **Current problem**: [`src/engines/paper.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/engines/paper.ts) fills at `LTP ± 0.05`.
- **Doable solution**:
  - When quote has market depth / Bid-Ask:
    - Market Buy fills at `Ask` (plus slippage if quantity > top ask size).
    - Market Sell fills at `Bid` (minus slippage).
    - Limit orders rest in a paper order book until high/low or Bid/Ask crosses limit price.

#### C. Process Separation (Trading vs Web vs AI)

- **Current problem**: Everything runs in `startCore()` in one Node process.
- **Doable solution**:
  - Split entrypoints:
    - `src/daemon.ts`: Trading Core (Dhan WS/REST, Risk, PositionMonitor, Execution, Reconciler).
    - `src/server.ts`: Web Control Server (Express REST, Dashboard WS, Command routing).
    - `src/workers/aiWorker.ts`: Ollama Agent Worker (Consumes opportunities, emits proposals).
  - Backwards-compatible: In single-process mode (`npm run dev`), they can run together via event emitters; in multi-process mode (`npm run start:services`), they communicate over Redis PubSub.

---

### 3. What is NOT Doable or SHOULD NOT Be Done (Anti-Patterns / YAGNI)

> [!CAUTION]
> The following components from the diagrams and improvement documents are **explicitly discouraged** for this stage because they introduce massive maintenance overhead without adding trading alpha or safety:

1. **InfluxDB Time-Series Database**:
   - *Why NOT*: InfluxDB requires running a heavy Go daemon, separate query syntax (Flux/InfluxQL), and schema overhead. PostgreSQL handles tens of thousands of tick rows easily for paper trading, especially with partitioned tables.
2. **Prometheus + Grafana + Sentry Telemetry Stack**:
   - *Why NOT*: Running Prometheus scrapers, Grafana server, and Sentry relay on a developer laptop consumes 1-2 GB of RAM and significant battery. Pino JSON logs + the React dashboard cockpit provide all necessary observability.
3. **HashiCorp Vault Secrets Manager**:
   - *Why NOT*: Vault is enterprise infrastructure for multi-server clusters. A local trading bot on a laptop is completely secure using environment variables and restricted file permissions (`chmod 600 .env`).
4. **Distributed Object Storage (MinIO / S3)**:
   - *Why NOT*: Storing backtest outputs and trade journals in S3 is unnecessary. Fast local NVMe SSD storage with NDJSON and Postgres is simpler, faster, and offline-capable.
5. **LLM Self-Modifying Code / Self-Healing Prompt Hacks**:
   - *Why NOT*: Having an LLM modify trading logic or generate prompt rules on errors is an anti-pattern. System self-healing must be deterministic (reconnect WS, fall back to REST, flatten rogue position, enter SAFE_MODE).

---

## Phased Implementation Roadmap

```mermaid
flowchart TD
    subgraph Phase 1: Core Reliability & Safety [Phase 1: Core Reliability]
        A1[Order & Strategy State Machine] --> A2[Multi-leg Atomic Coordinator]
        A2 --> A3[Idempotency & UNKNOWN State]
        A3 --> A4[System State & Boot Reconciler]
    end

    subgraph Phase 2: Decoupled AI & Opportunity Engine [Phase 2: AI & Scanning]
        B1[Extract Opportunity Scanner] --> B2[AI TradeProposal Interface]
        B2 --> B3[Deterministic Proposal Validator]
    end

    subgraph Phase 3: Execution Realism & Quant Greeks [Phase 3: Execution & Pricing]
        C1[Bid/Ask Depth Paper Fill Model] --> C2[Real IV & Skew Greeks Engine]
        C2 --> C3[Portfolio-Level Risk Aggregation]
    end

    subgraph Phase 4: Process Boundary Separation [Phase 4: Multi-Process Architecture]
        D1[Trading Daemon Extraction] --> D2[Web API Gateway Thinning]
        D2 --> D3[Background AI & Backtest Worker]
    end

    Phase 1 --> Phase 2
    Phase 2 --> Phase 3
    Phase 3 --> Phase 4
```

### Phase 1: Core Reliability & State Safety (P0)

- **Goal**: Guarantee that no failure, disconnect, or partial fill can corrupt position state or leave orphan legs.
- **Actions**:
  1. Create `src/services/orderStateMachine.ts` with explicit states (`CREATED`, `VALIDATED`, `SUBMITTED`, `FILLED`, `REJECTED`, `UNKNOWN`, `CANCELLED`).
  2. Implement `StrategyExecutionCoordinator` in `src/engines/paper.ts` to coordinate multi-leg fills sequentially or concurrently with automatic rollback (flattening filled legs if subsequent legs reject).
  3. Introduce `SystemState` (`BOOTING`, `RECONCILING`, `READY`, `TRADING`, `DEGRADED`, `SAFE_MODE`, `HALTED`).
  4. Strengthen [`crossCheckJournalOnBoot`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/core.ts#L178-L202) into a true reconciliation engine.

### Phase 2: Decoupled AI & Opportunity Engine (P0/P1)

- **Goal**: Prevent LLM latency or errors from impacting the live trading heartbeat.
- **Actions**:
  1. Extract deterministic scanners into `src/services/opportunityEngine.ts` (monitors PCR, Supertrend, IV, VWAP).
  2. Refactor [`AgentOrchestrator`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/agent.ts) to output `TradeProposal` data contracts.
  3. Wire proposal intake through `RiskEngine.canTrade()` and `StrategyValidator` before execution.

### Phase 3: Paper Execution Realism & Quant Greeks (P1)

- **Goal**: Realistic slippage, fill pricing, and accurate portfolio-level risk.
- **Actions**:
  1. Update `PaperExecutionEngine` to fill Market Buys at Ask, Market Sells at Bid from Dhan quote depth.
  2. Improve Black-Scholes Greeks calculations in [`src/services/optionsAnalytics.ts`](file:///home/nemesis/project/trading-workspace/bots/axis-nexus/src/services/optionsAnalytics.ts) to calculate implied volatility from live market prices instead of a hardcoded 15% fallback.
  3. Aggregate Portfolio Greeks (Total Net Delta, Gamma, Theta, Vega) in `RiskEngine`.

### Phase 4: Process Boundary Separation (P2)

- **Goal**: Process isolation so crashes in Web UI or AI do not terminate active trading monitors.
- **Actions**:
  1. Structure npm scripts:
     - `npm run dev:trading` (Core Trading Daemon)
     - `npm run dev:web` (Express API + WebSocket Server)
     - `npm run dev:ai` (Ollama Reasoning Worker)
     - `npm run dev` (Orchestrates all via local IPC or Redis)
  2. Ensure trading daemon runs headlessly and tolerates UI or AI process restarts seamlessly.

---

## Verification Plan

### Automated Unit & Integration Tests

- **Order State Machine Tests**:
  - Test all valid state transitions.
  - Test handling of timeouts transitioning to `UNKNOWN` state without duplicate order submission.
- **Multi-Leg Failure Tests**:
  - Mock Leg 1 FILL, Leg 2 REJECT -> verify Leg 1 is immediately squared off and strategy state is marked `FAILED`.
- **Reconciliation Tests**:
  - Simulate corrupted in-memory position vs Postgres ledger -> verify reconciler detects difference and restores truth.
- **AI Decoupling Tests**:
  - Verify that invalid/hallucinated `TradeProposal` is rejected by `StrategyValidator` without reaching execution engine.
- Command to run:

  ```bash
  npm test
  ```

### Manual Verification

1. Boot system in headless paper mode (`npm run start:headless`).
2. Verify startup sequence logs: `BOOTING` -> `SYNCING` -> `RECONCILING` -> `READY`.
3. Place a 4-leg Iron Condor in paper mode with a simulated rejection on leg 2; confirm automatic emergency hedge liquidation.
4. Stress test Ollama latency (simulate 20s delayed response) and verify DhanHQ WebSocket ticks and trailing stop monitors continue executing without jitter.
