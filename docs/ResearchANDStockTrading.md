Got it. These additional screenshots confirm the **intro and closing slides** of the same 12-slide post.

So the complete framework we have is:

| #      | Analysis module                    | Core purpose                                                                     |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| **1**  | Full Stock Analysis                | Complete business + financial + market overview                                  |
| **2**  | Deep Financial Breakdown           | 5-year revenue, PAT, FCF, margins, debt, ROE/ROCE, cash conversion               |
| **3**  | Competitive Moat                   | Brand, distribution, switching costs, cost advantage, technology, market share   |
| **4**  | Stock Valuation                    | P/E, EV/EBITDA, DCF, historical valuation, sector/peer comparison                |
| **5**  | Risk Analysis                      | Economic, industry, competition, regulatory, debt, promoter and governance risks |
| **6**  | Growth Potential                   | 5–10 year market opportunity, expansion, products, policy, technology/AI         |
| **7**  | Institutional Investor Perspective | FII/DII rationale, catalysts, thesis and institutional red flags                 |
| **8**  | Bull vs Bear Debate                | Data-backed opposing investment cases                                            |
| **9**  | Management Quality                 | Promoters, capital allocation, governance, related parties, pledging, execution  |
| **10** | Buy/Hold/Avoid                     | 1-year + 5-year outlook, catalysts, risks, valuation and final verdict           |

### But there is an important weakness

I **would not use these 10 prompts independently** if our objective is serious Indian-equity research.

They overlap heavily. For example:

* Prompt 1 already covers valuation, risks, promoters and institutional participation.
* Prompt 2 overlaps with Prompt 1 and Prompt 4.
* Prompt 5 overlaps with Prompts 3, 7 and 9.
* Prompt 10 is essentially the **output of all the preceding analyses**, rather than another independent analysis.
* None of them adequately forces **scenario-based financial modelling**, **earnings-quality analysis**, **FCF normalization**, **ROIC**, **working-capital analysis**, or **thesis invalidation conditions**.
* The valuation prompt mentions DCF but doesn't specify the assumptions that make a DCF defensible.
* "Moat 1–10" is subjective unless supported by measurable evidence.
* FII/DII ownership is useful, but **institutional ownership should never be treated as proof of investment quality**.

### The better architecture

I would turn these into a **single institutional-grade Indian Stock Research Engine**:

```text
                    STOCK / TICKER
                         │
                         ▼
              ┌─────────────────────┐
              │ 1. BUSINESS ENGINE  │
              │ Business model      │
              │ Revenue streams     │
              │ TAM / industry      │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 2. FINANCIAL ENGINE │
              │ 5–10Y financials    │
              │ Growth / margins    │
              │ FCF / ROIC          │
              │ Debt / WC           │
              │ Earnings quality    │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 3. MOAT ENGINE      │
              │ Competition         │
              │ Market share        │
              │ Pricing power       │
              │ Switching costs     │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 4. MANAGEMENT       │
              │ Promoters           │
              │ Governance          │
              │ Capital allocation  │
              │ Pledging / RPT      │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 5. GROWTH ENGINE    │
              │ TAM / CAGR          │
              │ Expansion           │
              │ New products        │
              │ Policy / technology │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 6. VALUATION ENGINE │
              │ DCF                 │
              │ P/E / EV/EBITDA     │
              │ Historical bands    │
              │ Peer valuation      │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 7. RISK ENGINE      │
              │ Business            │
              │ Financial           │
              │ Regulatory          │
              │ Governance          │
              │ Competition         │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 8. BULL/BASE/BEAR   │
              │ Scenario modelling  │
              │ EPS / FCF           │
              │ Target valuation    │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 9. INSTITUTIONAL    │
              │ INVESTMENT THESIS   │
              └──────────┬──────────┘
                         ▼
              ┌─────────────────────┐
              │ 10. FINAL DECISION  │
              │ BUY / HOLD / AVOID  │
              │ Expected return     │
              │ Risk/reward         │
              │ Thesis breakers     │
              └─────────────────────┘
```

**That is much stronger than simply copying the Instagram prompts.**

If your intention is to use this for **actual Indian stock investing**, I would go one step further and build a **Master Prompt v2** that incorporates all 10 prompts plus the missing institutional-grade checks, with mandatory source verification, calculations, scoring, bull/base/bear valuation, and a final **Buy/Hold/Avoid + expected CAGR + downside risk** decision.

Yes. The correct move is **not** to turn the Instagram prompts into one giant prompt. We should convert them into an **agentic equity-research skill system** where each skill has a bounded responsibility, produces structured evidence, and an orchestrator synthesizes the final investment thesis.

## Proposed Agentic AI Stock Research System

```text
                         ┌───────────────────────┐
                         │   STOCK RESEARCH USER  │
                         │ "Analyze RELIANCE"     │
                         └───────────┬───────────┘
                                     │
                                     ▼
                       ┌─────────────────────────┐
                       │   RESEARCH ORCHESTRATOR  │
                       │ Plan → Delegate → Verify │
                       │ → Reconcile → Synthesize │
                       └───────────┬─────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
 ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
 │ Business Skill │      │ Financial Skill│      │  Moat Skill    │
 └────────────────┘      └────────────────┘      └────────────────┘
          │                        │                        │
          ▼                        ▼                        ▼
 ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
 │Management Skill│      │ Growth Skill   │      │Valuation Skill │
 └────────────────┘      └────────────────┘      └────────────────┘
          │                        │                        │
          ▼                        ▼                        ▼
 ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
 │   Risk Skill   │      │Institutional   │      │ Bull/Bear Skill│
 │                │      │    Skill       │      │                │
 └────────────────┘      └────────────────┘      └────────────────┘
          │                        │                        │
          └────────────────────────┼────────────────────────┘
                                   ▼
                       ┌─────────────────────────┐
                       │ Evidence / Fact Checker │
                       │ Source + Date + Claim   │
                       └───────────┬─────────────┘
                                   ▼
                       ┌─────────────────────────┐
                       │ Investment Synthesis     │
                       │ Bull / Base / Bear      │
                       │ Valuation / Risk        │
                       └───────────┬─────────────┘
                                   ▼
                       ┌─────────────────────────┐
                       │ FINAL INVESTMENT OUTPUT │
                       │ BUY / HOLD / AVOID      │
                       └─────────────────────────┘
```

# 1. Core Skills

I would create **12 skills**, not merely the original 10.

### `stock-research-orchestrator`

Responsible for:

* identifying the stock
* determining required research
* creating the research plan
* delegating to specialist skills
* detecting missing evidence
* requesting additional research
* resolving conflicting conclusions
* triggering final synthesis

It should **never invent financial data**.

---

### `business-analysis`

Based on Prompt 1.

Responsibilities:

```text
Business model
Revenue streams
Segments
Geographic exposure
Customers
Value chain
Industry structure
Addressable market
Competitive positioning
Key earnings drivers
```

Output:

```json
{
  "business_quality": 0,
  "business_model": "...",
  "revenue_drivers": [],
  "industry": "...",
  "key_earnings_drivers": [],
  "structural_tailwinds": [],
  "structural_headwinds": []
}
```

---

### `financial-analysis`

Based on Prompt 2.

Must analyze preferably 5–10 years rather than blindly using five.

```text
Revenue
EBITDA
EBIT
PAT
EPS
Operating margin
FCF
CFO
Capex
Working capital
Debt
Cash
Net debt
ROE
ROCE
ROIC
Asset turnover
Interest coverage
Cash conversion
```

Critical addition:

```text
PAT growth ≠ quality growth
```

The skill must explicitly compare:

```text
CFO vs PAT
FCF vs PAT
Receivables growth vs revenue
Inventory growth vs revenue
Debt growth vs EBITDA
Capex vs depreciation
```

---

### `moat-analysis`

Based on Prompt 3.

Score:

```text
Brand                 /10
Distribution          /10
Switching costs       /10
Cost advantage        /10
Technology            /10
Network effects       /10
Market position       /10
Pricing power         /10
```

Then calculate:

```text
MOAT SCORE = weighted aggregate
```

But the agent must distinguish:

```text
Current moat
versus
Potential future moat
```

That distinction is essential.

---

### `valuation-analysis`

Based on Prompt 4.

This should become a **multi-model valuation engine**.

```text
P/E
EV/EBITDA
P/B where applicable
FCF yield
Dividend yield where relevant
Historical valuation
Peer valuation
DCF
Reverse DCF
Growth-adjusted valuation
```

DCF should expose assumptions:

```text
Revenue CAGR
EBIT margin
Tax rate
Capex
Working capital
Terminal growth
WACC
Share count
Net debt
```

The agent must output:

```text
Bear value
Base value
Bull value
Current price
Upside/downside
Margin of safety
```

---

### `risk-analysis`

Based on Prompt 5.

Create a ranked risk register:

```text
Risk
Probability
Impact
Time horizon
Early warning indicator
Mitigation
Thesis impact
```

Categories:

```text
Macroeconomic
Industry
Competition
Regulatory / SEBI
Financial
Debt
Promoter
Governance
Technology
Execution
Valuation
Liquidity
```

---

### `growth-analysis`

Based on Prompt 6.

Separate:

```text
Industry growth
Company market-share growth
Organic expansion
New products
New geographies
Capacity expansion
Pricing
Operating leverage
Technology / AI
Government policy
M&A
```

And distinguish:

```text
Revenue growth
vs
EPS growth
vs
FCF growth
```

That prevents a classic research error.

---

### `management-analysis`

Based on Prompt 9.

This should be one of the **highest-weighted skills**.

Check:

```text
Promoter background
Promoter ownership
Promoter ownership trend
Share pledging
Related-party transactions
Capital allocation
Acquisitions
Buybacks
Dividends
Debt decisions
Dilution
Governance history
Auditor observations
Regulatory issues
Execution track record
Management guidance
Actual vs promised results
```

A particularly valuable component:

```text
GUIDANCE → ACTUALITY TRACKER
```

For example:

```text
Management promised 20% growth
Actual growth = 11%
Execution gap = -9%
```

---

### `institutional-analysis`

Based on Prompt 7.

Analyze:

```text
FII ownership
DII ownership
Institutional ownership trend
Institutional concentration
Potential reasons institutions buy
Potential reasons institutions avoid
Liquidity
Index inclusion
Free float
Catalysts
Institutional thesis
```

Important:

> Institutional ownership is evidence of positioning, not evidence that the company is good.

---

### `bull-bear-analysis`

Based on Prompt 8.

This should run **after** the other research skills.

Two independent agents:

```text
BULL AGENT
BEAR AGENT
```

Neither is allowed to see the other's conclusion initially.

Each produces:

```text
Thesis
Evidence
Financial assumptions
Catalysts
Risks
Valuation
Invalidation conditions
```

Then a third:

```text
DEBATE JUDGE
```

evaluates both.

---

### `investment-verdict`

Based on Prompt 10.

This is **not another research agent**.

It is the final decision engine.

Inputs:

```text
Business
Financials
Moat
Management
Growth
Valuation
Risks
Institutional view
Bull/Bear debate
```

Outputs:

```text
BUY
HOLD
AVOID
```

with:

```text
1Y thesis
3Y thesis
5Y+ thesis
Expected CAGR
Base-case return
Bull-case return
Bear-case loss
Valuation comfort
Margin of safety
Key catalysts
Key risks
Thesis breakers
```

---

# 2. Two Additional Skills You Need

These are missing from the Instagram framework.

## `source-verification`

Every important claim gets an evidence record.

```json
{
  "claim": "Revenue grew 18% YoY",
  "value": 18,
  "period": "FY2026",
  "source": "Annual Report",
  "source_date": "2026-05-15",
  "confidence": "high"
}
```

Source hierarchy should be roughly:

```text
Annual reports
Exchange filings
Company investor presentations
Earnings calls
Regulatory filings
SEBI disclosures
Credit-rating reports
Peer filings
Reputable financial databases
News / secondary sources
```

The agent should distinguish:

```text
FACT
MANAGEMENT CLAIM
ANALYST INFERENCE
ESTIMATE
```

That distinction is critical.

---

## `research-quality-control`

A final adversarial reviewer.

Checks:

```text
Missing data
Contradictory numbers
Stale information
Unsupported claims
Calculation errors
DCF sensitivity
Peer mismatch
Accounting anomalies
Cherry-picked metrics
Confirmation bias
Bull-case assumptions
Bear-case assumptions
```

It can return:

```json
{
  "research_status": "REQUIRES_MORE_RESEARCH",
  "critical_gaps": [],
  "conflicts": [],
  "confidence": 0.82
}
```

The orchestrator then loops back.

---

# 3. Agentic Execution Loop

This is the part that makes it **agentic**, rather than a collection of prompts.

```text
USER
  │
  ▼
IDENTIFY STOCK
  │
  ▼
CREATE RESEARCH PLAN
  │
  ▼
RUN PARALLEL SKILLS
  │
  ├── Business
  ├── Financial
  ├── Moat
  ├── Management
  ├── Growth
  ├── Valuation
  ├── Risk
  └── Institutional
          │
          ▼
    BUILD EVIDENCE GRAPH
          │
          ▼
    QUALITY CONTROL
          │
     ┌────┴────┐
     │         │
 PASS        FAIL
     │         │
     │      RESEARCH MORE
     │         │
     └────┬────┘
          ▼
   BULL / BEAR DEBATE
          │
          ▼
    SCENARIO MODEL
          │
          ▼
 FINAL INVESTMENT SYNTHESIS
          │
          ▼
 BUY / HOLD / AVOID
```

---

# 4. Shared Research Context

Every skill should receive a common context object.

```json
{
  "instrument": {
    "name": "",
    "ticker": "",
    "exchange": "",
    "sector": "",
    "industry": ""
  },

  "research_date": "",

  "market_data": {},

  "financial_data": {},

  "filings": [],

  "management_commentary": [],

  "peer_data": [],

  "institutional_data": {},

  "news": [],

  "evidence": [],

  "assumptions": [],

  "research_gaps": [],

  "confidence": {}
}
```

This prevents every agent from independently creating incompatible versions of the same company.

---

# 5. Skill Contract

Every skill should follow a strict interface.

```yaml
skill:
  id: financial-analysis
  version: 1.0

input:
  stock: required
  research_context: required

responsibilities:
  - analyze financial performance
  - assess earnings quality
  - evaluate balance sheet
  - evaluate cash generation

must_not:
  - invent financial figures
  - make unsupported forecasts
  - issue final investment verdict

output:
  structured: true
  evidence_required: true
  confidence_required: true
```

This prevents prompt sprawl.

---

# 6. Agent Types

I would use different agent roles rather than one LLM pretending to be ten analysts.

```text
ORCHESTRATOR
     │
     ├── RESEARCH AGENTS
     │
     ├── ANALYTICAL AGENTS
     │
     ├── ADVERSARIAL AGENTS
     │
     └── SYNTHESIS AGENT
```

### Research agents

Retrieve facts.

### Analytical agents

Transform facts into analysis.

### Adversarial agents

Challenge the analysis.

### Synthesis agent

Produces the investment thesis.

---

# 7. Shared Evidence Ledger

This becomes the central memory structure.

```json
{
  "evidence_id": "EV-00123",
  "company": "RELIANCE",
  "category": "financial",
  "claim": "Revenue increased...",
  "metric": "revenue",
  "period": "FY2026",
  "value": 123456,
  "source_type": "annual_report",
  "source_reference": "...",
  "confidence": 0.98
}
```

Every agent references evidence IDs instead of duplicating raw facts.

That gives you:

```text
Claim
   ↓
Evidence
   ↓
Calculation
   ↓
Conclusion
```

instead of:

```text
LLM says something
```

---

# 8. Scoring Framework

The final system can produce a normalized score:

| Dimension         | Weight |
| ----------------- | -----: |
| Business quality  |    10% |
| Financial quality |    20% |
| Moat              |    15% |
| Management        |    15% |
| Growth            |    15% |
| Valuation         |    15% |
| Risk              |    10% |

Then:

```text
TOTAL QUALITY SCORE = 0–100
```

But **valuation should remain separate from quality**.

For example:

```text
Company quality = 91/100
Valuation = 38/100
```

can correctly produce:

```text
Excellent company
Poor current investment
```

That is far more useful than a simplistic "good stock" score.

---

# 9. Final Output Contract

The final agent should produce something like:

```text
RELIANCE INDUSTRIES
────────────────────────────

Investment Rating
BUY

Overall Score
84 / 100

Business Quality
91 / 100

Financial Quality
88 / 100

Moat
82 / 100

Management
86 / 100

Growth
89 / 100

Valuation
67 / 100

Risk
Moderate

────────────────────────────

CURRENT PRICE
₹X

FAIR VALUE

Bear: ₹X
Base: ₹X
Bull: ₹X

Expected 5Y CAGR
X%

Margin of Safety
X%

────────────────────────────

BULL THESIS
...

BASE THESIS
...

BEAR THESIS
...

KEY CATALYSTS
...

KEY RISKS
...

THESIS BREAKERS
...

FINAL VERDICT
BUY / HOLD / AVOID

CONFIDENCE
High / Medium / Low
```

---

# 10. Recommended Skill Directory

For an actual implementation, I would structure it like this:

```text
stock-research-agent/
│
├── agents/
│   ├── orchestrator/
│   ├── business/
│   ├── financial/
│   ├── moat/
│   ├── management/
│   ├── growth/
│   ├── valuation/
│   ├── risk/
│   ├── institutional/
│   ├── bull/
│   ├── bear/
│   ├── debate-judge/
│   ├── source-verifier/
│   ├── quality-control/
│   └── investment-synthesis/
│
├── skills/
│   ├── business-analysis/
│   ├── financial-analysis/
│   ├── moat-analysis/
│   ├── management-analysis/
│   ├── growth-analysis/
│   ├── valuation-analysis/
│   ├── risk-analysis/
│   ├── institutional-analysis/
│   ├── bull-bear-analysis/
│   ├── source-verification/
│   ├── research-qc/
│   └── investment-verdict/
│
├── schemas/
│   ├── stock.json
│   ├── evidence.json
│   ├── financials.json
│   ├── valuation.json
│   ├── risk.json
│   ├── thesis.json
│   └── final-report.json
│
├── memory/
│   ├── evidence/
│   ├── research/
│   └── theses/
│
├── workflows/
│   ├── full-research.yaml
│   ├── quick-analysis.yaml
│   ├── earnings-review.yaml
│   └── thesis-update.yaml
│
└── prompts/
    ├── system.md
    ├── orchestrator.md
    └── synthesis.md
```

## The important architectural decision

Do **not** make the 10 Instagram prompts the architecture.

Use them as the **domain specification** for the skills.

The resulting system is:

```text
Instagram prompts
       ↓
Domain knowledge
       ↓
Specialized skills
       ↓
Agent orchestration
       ↓
Evidence graph
       ↓
Adversarial verification
       ↓
Scenario valuation
       ↓
Investment decision
```

That gives you an actual **agentic Indian-equity research system**, rather than a collection of clever prompts.

### What I would build next

I would turn this into a **complete implementation package** containing the actual `SKILL.md` files, agent system prompts, JSON schemas, orchestration workflow, evidence model, scoring model, and final-report contract for your agent runtime, rather than stopping at the architecture.

Yes. The two SDKs are a strong fit for turning the current **AlgoScalperApi** into an agentic Indian-market research + trading system.

The important architectural decision is this:

> **Do not make the LLM itself the trading strategy.**
> Make the LLM an **agentic research/orchestration layer** that invokes deterministic market-data, technical-analysis, options-analysis, risk, and execution skills.

Your existing application already contains most of the deterministic trading machinery. The missing piece is a disciplined agent layer around it.

Your `dhanhq-sdk` already provides typed DhanHQ v2 access, WebSockets, option chains/Greeks, technical indicators, risk pipelines, composable skills and MCP/agent tooling.  Your `ollama-sdk` provides structured Zod outputs, tool calling, autonomous agent loops, embeddings, vision, reasoning and model failover.

---

# 1. What I would build

### `AlgoScalper AI Research & Trading Agent`

```text
                         USER
                           │
                           ▼
                ┌─────────────────────┐
                │   Trading Copilot   │
                │   Ollama Agent      │
                └──────────┬──────────┘
                           │
                 Agent Orchestrator
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   Research Skills    Trading Skills   Portfolio Skills
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
   │ Market Data │   │ Signal      │   │ Positions    │
   │ Fundamentals│   │ Options     │   │ P&L          │
   │ Technicals  │   │ Entry       │   │ Risk         │
   │ News        │   │ Exit        │   │ Exposure     │
   │ Valuation   │   │ Execution   │   │ Performance  │
   └──────┬──────┘   └──────┬──────┘   └──────┬───────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
                    ┌───────────────┐
                    │ Deterministic │
                    │ Domain Engine │
                    └───────┬───────┘
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
             DhanHQ SDK            Database/Redis
                 │
                 ▼
         NSE / BSE / F&O
```

The LLM **reasons over results**. It doesn't manufacture market facts.

---

# 2. The 10-prompt idea should become 10 Agent Skills

From the carousel concept, I would not simply copy ten giant prompts.

Instead:

```text
Prompt
   ↓
Agent Skill
   ↓
Typed tool calls
   ↓
Deterministic calculations
   ↓
Evidence collection
   ↓
LLM synthesis
   ↓
Structured report
```

That is considerably more robust.

I'd define these initial skills:

| #  | Skill                     | Purpose                            | Risk   |
| -- | ------------------------- | ---------------------------------- | ------ |
| 1  | `stock_research`          | Complete company research          | READ   |
| 2  | `fundamental_analysis`    | Financial quality                  | READ   |
| 3  | `technical_analysis`      | Trend + momentum                   | READ   |
| 4  | `valuation_analysis`      | Fair-value / relative valuation    | READ   |
| 5  | `earnings_analysis`       | Results + earnings trend           | READ   |
| 6  | `news_event_analysis`     | News/catalyst analysis             | READ   |
| 7  | `sector_analysis`         | Sector/peer comparison             | READ   |
| 8  | `options_analysis`        | Chain, IV, Greeks, OI              | READ   |
| 9  | `trade_setup`             | Convert research into trade thesis | REVIEW |
| 10 | `portfolio_risk_analysis` | Existing exposure + risk           | READ   |

And then separately:

```text
11. entry_decision
12. order_preview
13. execute_order
14. manage_position
15. exit_position
16. square_off
```

These **must not be mixed with research skills**.

---

# 3. `stock_research` becomes the flagship skill

For example:

```text
User:
"Analyze RELIANCE"

        ↓

stock_research agent

        ↓
┌──────────────────────────────┐
│ 1. Resolve instrument        │
│ 2. Fetch current quote       │
│ 3. Fetch historical candles  │
│ 4. Calculate technicals      │
│ 5. Fetch fundamentals*       │
│ 6. Analyze valuation*        │
│ 7. Analyze sector            │
│ 8. Analyze recent events*    │
│ 9. Assess risk               │
│10. Produce thesis            │
└──────────────────────────────┘

        ↓

Structured Research Report
```

`*` requires a data source that actually provides the information. DhanHQ alone should not be treated as a magical fundamental/news provider.

That distinction is critical.

---

# 4. Technical Analysis Skill

Your current application already has:

* Supertrend
* ADX
* multi-timeframe analysis
* trend scoring
* confirmation filters
* market regime detection
* candle series
* SMC analysis

And your SDK provides indicators including:

* SMA
* EMA
* WMA
* RSI
* MACD
* Bollinger Bands
* ATR
* ADX
* Stochastic
* Supertrend
* VWAP
* OBV
* multi-timeframe bias

So don't ask the LLM:

> "Calculate RSI and decide if RSI is bullish."

Instead:

```typescript
const analysis = await technicalAnalysisSkill.execute({
  symbol: "RELIANCE",
  timeframes: ["5m", "15m", "1h", "1D"]
});
```

returns:

```json
{
  "trend": {
    "5m": "bullish",
    "15m": "bullish",
    "1h": "bullish",
    "1D": "neutral"
  },
  "momentum": {
    "rsi": 63.4,
    "macd": "bullish",
    "adx": 28.7
  },
  "volatility": {
    "atr": 31.4,
    "regime": "normal"
  },
  "structure": {
    "bias": "bullish",
    "break_of_structure": true
  }
}
```

Then the LLM interprets it.

---

# 5. Options Analysis Skill

This is where the system becomes particularly useful for **your existing AlgoScalperApi**.

The agent should be able to ask:

```text
options_chain
option_greeks
iv_analysis
oi_analysis
pcr_analysis
max_pain
gamma_analysis
strike_selection
expected_move
liquidity_analysis
```

Your SDK already exposes option analytics including Black-Scholes pricing, Greeks, IV, max pain, PCR and OI-wall analysis.

The agent could therefore produce:

```json
{
  "underlying": "NIFTY",
  "spot": 24820,
  "trend": "bullish",
  "expected_move": 145,
  "support": [24700, 24550],
  "resistance": [24900, 25000],
  "preferred_structure": "bull_call_spread",
  "preferred_strike": {
    "buy": 24800,
    "sell": 25000
  },
  "confidence": 0.78
}
```

Notice:

**It produces an intent, not an order.**

---

# 6. Trade Setup Skill

This should be a major boundary.

The agent can synthesize:

```text
Market Structure
       +
Technical Analysis
       +
Options Structure
       +
Volatility
       +
Risk
       ↓
Trade Thesis
```

Example:

```json
{
  "underlying": "NIFTY",
  "direction": "LONG",
  "instrument": "OPTION",
  "structure": "BUY_CALL",
  "strike": 24800,
  "expiry": "2026-09-10",
  "entry_zone": [72, 78],
  "stop_loss": 58,
  "target": [105, 120],
  "risk_reward": 2.1,
  "thesis": [
    "15m bullish structure",
    "ADX expansion",
    "positive momentum",
    "call-side participation increasing"
  ],
  "invalidation": [
    "15m BOS failure",
    "premium below structural stop"
  ]
}
```

Then:

```text
                 TRADE INTENT
                      │
                      ▼
               Risk Manager
                      │
             ┌────────┴────────┐
             │                 │
           PASS              FAIL
             │                 │
             ▼                 ▼
       Order Preview         Reject
             │
             ▼
       Human/Policy Gate
             │
             ▼
         Execution
```

---

# 7. Agent tools

The Ollama SDK is particularly useful here because its `Agent` supports autonomous tool calling, validation and error recovery, while `ToolRegistry` provides execution controls such as timeouts, concurrency limits and output limits.

I'd expose tools approximately like this:

```text
MARKET
├── search_instrument
├── get_quote
├── get_historical_data
├── get_market_status
├── get_market_depth
└── get_market_session

TECHNICAL
├── calculate_indicators
├── multi_timeframe_analysis
├── detect_market_structure
├── detect_trend
└── detect_volatility_regime

OPTIONS
├── get_option_chain
├── calculate_greeks
├── calculate_iv
├── calculate_pcr
├── calculate_max_pain
├── detect_oi_walls
├── detect_gamma_ramp
└── select_option

RESEARCH
├── company_research
├── fundamental_analysis
├── valuation_analysis
├── earnings_analysis
├── sector_analysis
└── news_analysis

TRADING
├── generate_trade_setup
├── validate_trade
├── calculate_position_size
├── order_preview
└── execute_order

PORTFOLIO
├── get_positions
├── get_orders
├── get_holdings
├── get_pnl
├── calculate_exposure
└── portfolio_risk

RISK
├── risk_check
├── circuit_breaker_status
├── daily_limits
├── kill_switch_status
└── emergency_square_off
```

---

# 8. Permission model

This is **non-negotiable**.

The LLM should not receive unrestricted Dhan access.

Use:

```text
Agent
 │
 ▼
Policy Engine
 │
 ├── market:read
 ├── research:read
 ├── options:read
 ├── portfolio:read
 ├── orders:read
 ├── orders:preview
 ├── orders:write
 ├── risk:read
 ├── risk:write
 └── destructive:write
```

Your DhanHQ SDK already has this philosophy: tools are behind a permission policy, and writes require both the policy scope and explicit environment gates.

That is exactly the model I'd preserve.

---

# 9. Three agent modes

Don't build one giant autonomous agent.

Build **three operational modes**.

### Research Agent

```text
READ ONLY

Market
Technical
Fundamental
Options
News
Sector
Valuation

        ↓

Research Report
```

### Trading Analyst

```text
READ
   ↓
Analyze
   ↓
Generate Setup
   ↓
Risk Check
   ↓
Trade Intent
```

No execution.

### Execution Agent

```text
Trade Intent
     ↓
Risk Engine
     ↓
Order Preview
     ↓
Policy Gate
     ↓
DhanHQ
```

This separation prevents the classic LLM-agent failure mode:

> "The model reasoned itself into having permission to trade."

It never gets that permission through reasoning.

---

# 10. Rails integration

Your existing architecture is Rails.

I would **not rewrite AlgoScalperApi in TypeScript** merely because the SDKs are TypeScript.

Instead:

```text
Rails
 │
 ├── Existing Trading Engine
 │
 ├── Existing Risk Engine
 │
 ├── Existing Options Engine
 │
 ├── Existing Backtest Engine
 │
 └── AI Gateway
          │
          ▼
       Node AI Runtime
          │
     ┌────┴─────┐
     ▼          ▼
 Ollama SDK   DhanHQ SDK
     │          │
     └────┬─────┘
          ▼
       AI Agents
```

There are two good options.

### Option A — Node AI service

Recommended.

```text
algo_scalper_api/
       │
       │ REST/internal API
       ▼
algo_scalper_ai/
       │
       ├── Agent Runtime
       ├── Skills
       ├── Tool Registry
       ├── Policies
       ├── Ollama
       └── DhanHQ SDK
```

### Option B — Node worker

For asynchronous research:

```text
Rails
 ↓
Redis / queue
 ↓
Node AI Worker
 ↓
Ollama
 ↓
DhanHQ
 ↓
Result
 ↓
Rails DB
```

For your application, **A + B eventually** is the stronger architecture.

---

# 11. Skill architecture

I would make each skill follow a common contract:

```typescript
interface TradingSkill<TInput, TOutput> {
  name: string;
  version: string;

  execute(
    input: TInput,
    context: SkillContext
  ): Promise<TOutput>;
}
```

Example:

```typescript
const technicalAnalysisSkill = defineSkill({
  name: "technical_analysis",
  version: "1.0.0",

  input: z.object({
    symbol: z.string(),
    timeframes: z.array(z.enum([
      "1m",
      "5m",
      "15m",
      "1h",
      "1D"
    ]))
  }),

  output: TechnicalAnalysisSchema,

  execute: async (input, ctx) => {
    // DhanHQ
    // deterministic indicators
    // market structure
    // return structured result
  }
});
```

Then:

```text
Agent
 ↓
Skill Registry
 ↓
Skill
 ↓
Typed Input
 ↓
Deterministic Execution
 ↓
Typed Output
 ↓
Agent
```

---

# 12. Don't put calculations in prompts

This is one of the biggest traps.

Bad:

```text
Analyze this option chain and calculate:
PCR, IV, Greeks, expected move,
support, resistance...
```

Better:

```text
DhanHQ
    ↓
Raw market data
    ↓
Analytics engine
    ↓
Structured facts
    ↓
LLM
```

The LLM should receive:

```json
{
  "spot": 24820,
  "atm_iv": 13.42,
  "pcr": 1.14,
  "max_pain": 24800,
  "call_oi_wall": 25000,
  "put_oi_wall": 24600,
  "delta": 0.52,
  "gamma": 0.00018
}
```

and reason over it.

---

# 13. Evidence system

For every agent conclusion, store:

```json
{
  "claim": "Bullish intraday bias",
  "confidence": 0.81,
  "evidence": [
    {
      "source": "technical_analysis",
      "metric": "15m_supertrend",
      "value": "bullish"
    },
    {
      "source": "technical_analysis",
      "metric": "ADX",
      "value": 28.7
    },
    {
      "source": "market_structure",
      "metric": "BOS",
      "value": "bullish"
    }
  ]
}
```

This gives you an **auditable AI trading system**, rather than a chatbot producing prose.

---

# 14. Self-improvement layer

Your existing application already has:

* `auto_exp`
* `experiment_runner`
* `backtest_executor`
* `llm_planner`
* `results_store`
* `optimization`
* trailing optimization
* trade analysis

That is extremely valuable.

Connect the agent to that system:

```text
Live Trading
     ↓
Trade Journal
     ↓
Performance Analytics
     ↓
Failure Detector
     ↓
Experiment Generator
     ↓
Backtest
     ↓
Statistical Validation
     ↓
Candidate Strategy
     ↓
Human/Policy Approval
     ↓
Production
```

**Do not allow the LLM to directly modify production trading parameters.**

It can propose:

```json
{
  "parameter": "adx_threshold",
  "old": 22,
  "proposed": 24,
  "reason": "...",
  "backtest": {
    "trades": 1842,
    "profit_factor": 1.47,
    "max_drawdown": 8.2
  }
}
```

Then your deterministic validation layer decides.

---

# 15. Model architecture

Use different models for different jobs.

```text
                    Ollama
                      │
        ┌─────────────┼──────────────┐
        │             │              │
     Planner       Analyst       Critic
        │             │              │
   reasoning       research        validation
```

For example:

```text
Planner
   ↓
"What information do I need?"

Analyst
   ↓
"Analyze the collected information."

Critic
   ↓
"Find contradictions / missing evidence."

Finalizer
   ↓
"Produce structured decision."
```

Your Ollama SDK supports multiple agents/models and endpoint/model routing, so this maps naturally to its architecture.

---

# 16. Final agent workflow

For:

> **"Analyze NIFTY and tell me whether there is a trade."**

I'd want:

```text
                    USER
                     │
                     ▼
               PLANNER AGENT
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Market     Technical   Options
       Data       Analysis    Analysis
          │          │          │
          └──────────┼──────────┘
                     ▼
              MARKET STRUCTURE
                     │
                     ▼
                RISK ANALYSIS
                     │
                     ▼
              TRADE ANALYST
                     │
                     ▼
                CRITIC AGENT
                     │
                     ▼
              FINAL SYNTHESIS
                     │
                     ▼
             ┌───────────────┐
             │ TRADE / NO     │
             │ TRADE / WAIT   │
             └───────────────┘
```

If trade:

```text
Trade Thesis
     ↓
Option Selection
     ↓
Position Sizing
     ↓
Risk Validation
     ↓
Order Preview
```

Execution remains a **separate authorization boundary**.

---

# 17. Recommended repository structure

I would add a dedicated Node AI runtime rather than contaminating your Rails services:

```text
algo-scalper-ai/
│
├── src/
│   ├── agents/
│   │   ├── research-agent.ts
│   │   ├── trading-agent.ts
│   │   ├── execution-agent.ts
│   │   ├── critic-agent.ts
│   │   └── planner-agent.ts
│   │
│   ├── skills/
│   │   ├── market/
│   │   │   ├── market-data.ts
│   │   │   ├── technical-analysis.ts
│   │   │   └── market-structure.ts
│   │   │
│   │   ├── research/
│   │   │   ├── stock-research.ts
│   │   │   ├── fundamentals.ts
│   │   │   ├── valuation.ts
│   │   │   ├── earnings.ts
│   │   │   ├── sector.ts
│   │   │   └── news.ts
│   │   │
│   │   ├── options/
│   │   │   ├── chain-analysis.ts
│   │   │   ├── greeks.ts
│   │   │   ├── iv.ts
│   │   │   ├── oi.ts
│   │   │   └── strike-selection.ts
│   │   │
│   │   ├── trading/
│   │   │   ├── trade-setup.ts
│   │   │   ├── position-sizing.ts
│   │   │   ├── order-preview.ts
│   │   │   └── execution.ts
│   │   │
│   │   └── risk/
│   │       ├── risk-check.ts
│   │       ├── exposure.ts
│   │       └── circuit-breaker.ts
│   │
│   ├── tools/
│   │   ├── dhan/
│   │   ├── rails/
│   │   └── research/
│   │
│   ├── policies/
│   │   ├── read-only.ts
│   │   ├── analyst.ts
│   │   └── execution.ts
│   │
│   ├── schemas/
│   ├── prompts/
│   ├── memory/
│   ├── evaluation/
│   └── server.ts
│
├── tests/
├── docs/
└── package.json
```

---

# 18. One major correction to the Instagram concept

The Instagram claim is effectively:

> "Gemini can analyze Indian stocks like a senior equity analyst."

That is useful as a **prompting concept**, but it is not the architecture I'd deploy for AlgoScalper.

For your system:

### LLM should NOT be the source of truth

Instead:

```text
               SOURCE OF TRUTH

DhanHQ ────────────────┐
                       │
Database ──────────────┤
                       ├──> Deterministic Analysis
Historical Data ───────┤
                       │
Trading Engine ────────┘
                              │
                              ▼
                        Agent Context
                              │
                              ▼
                           Ollama
                              │
                              ▼
                        Interpretation
```

This is much more powerful than simply putting those ten prompts into Gemini/Ollama.

---

# 19. What I recommend we implement first

Given the current AlgoScalperApi codebase, I would execute this in phases:

### Phase 1 — Foundation

* Node AI runtime
* `@nemesis-oss/ollama-sdk`
* `@nemesis-oss/dhanhq-sdk`
* Agent runtime
* Skill registry
* Tool registry
* Zod schemas
* policy engine
* audit logging

### Phase 2 — Research Agent

Implement:

```text
stock_research
technical_analysis
market_structure
sector_analysis
valuation_analysis
earnings_analysis
```

### Phase 3 — Options Intelligence

Implement:

```text
option_chain_analysis
greeks
IV
OI
PCR
max_pain
gamma
expected_move
strike_selection
```

### Phase 4 — Trading Analyst

Implement:

```text
trade_setup
position_sizing
risk_check
order_preview
```

### Phase 5 — Execution

Connect:

```text
trade intent
     ↓
existing EntryGuard
     ↓
existing Risk Manager
     ↓
existing Capital Allocator
     ↓
existing Order Gateway
     ↓
DhanHQ
```

Do **not** create a second execution system.

### Phase 6 — Self-learning

Connect the agents to:

```text
Backtest
Auto Experimentation
Trade Analyzer
Optimization
Failure Detector
```

---

## Bottom line

You already have an unusually large portion of the **deterministic trading infrastructure** required.

The correct evolution is:

```text
CURRENT

Market → Signal → Options → Risk → Execution
                         ↓
                    AlgoScalperApi


TARGET

                         Ollama
                           │
                     Agentic Layer
                           │
          ┌────────────────┼─────────────────┐
          ▼                ▼                 ▼
       Research        Trading Analyst     Critic
          │                │                 │
          └────────────────┼─────────────────┘
                           ▼
                  Existing AlgoScalperApi
                           │
             ┌─────────────┼──────────────┐
             ▼             ▼              ▼
          Signals       Options         Risk
             │             │              │
             └─────────────┼──────────────┘
                           ▼
                    Execution Gateway
                           │
                           ▼
                       DhanHQ
```

And the two SDKs are well aligned with this: `dhanhq-sdk` becomes the **market/trading capability layer**, while `ollama-sdk` becomes the **reasoning/agent orchestration layer**.

**One missing input:** the screenshots you provided show the carousel introduction and final slide, but not the actual 10 prompt contents. I can build the architecture above now, but I would **not invent the missing nine prompts**. If you provide the remaining carousel screenshots (or the prompt text), I can map **each exact prompt → concrete Agent Skill → tools → Zod schema → agent workflow → AlgoScalperApi integration point** and turn this into an implementation-ready specification.

Yes. I checked the current `axis-nexus` repository, and **this is a much better integration target than adding the research-agent layer to the Rails app**.

The repo already has almost all of the infrastructure we need: a TypeScript autonomous backend, `@nemesis-oss/dhanhq-sdk`, `@nemesis-oss/ollama-sdk`, an `AgentOrchestrator`, an `AgentToolRegistry`, EventBus telemetry, PostgreSQL persistence, and policy/risk gating.

## What I would do

Do **not** create a second independent agent framework.

Extend the existing:

```text
AgentOrchestrator
       │
       ├── existing trading personas
       │     planner
       │     analyst
       │     strategy
       │     risk
       │     execution
       │     critic
       │
       └── NEW Research Intelligence Plane
             │
             ├── Research Planner
             ├── Business Analyst
             ├── Financial Analyst
             ├── Growth Analyst
             ├── Valuation Analyst
             ├── Moat / Competition Analyst
             ├── Management / Governance Analyst
             ├── Technical Analyst
             ├── Market / Flow Analyst
             ├── Bear-Case / Red-Team Analyst
             └── Thesis / Verdict Synthesizer
```

The current repo already uses Ollama for reasoning and DhanHQ's `AgentToolRegistry` for real broker tools.  It also explicitly describes the existing six-persona ReAct pipeline and 44 policy-gated DhanHQ tools.

### The key architectural separation

I would make this distinction:

```text
                    ┌───────────────────────────┐
                    │      AgentOrchestrator    │
                    └─────────────┬─────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
        Trading Agent Plane                Research Agent Plane
                 │                                 │
        strategy / execution             research / valuation /
        risk / critic                    technical / thesis
                 │                                 │
                 ▼                                 ▼
          Dhan execution APIs              READ-ONLY data tools
```

**Research agents should not receive order-placement capabilities.**

That is especially important because the current SDK registry includes both read and write capabilities, including order placement.  The research plane should get a deliberately restricted tool registry containing market/fundamental/research data only.

---

# Why `axis-nexus` is already well positioned

Your `package.json` already contains:

```json
"@nemesis-oss/dhanhq-sdk": "^1.1.0",
"@nemesis-oss/ollama-sdk": "^1.3.0"
```

so there is no reason to introduce another AI/Dhan integration layer.

The existing agent implementation already has:

* Ollama client
* Dhan client
* tool registry
* policy
* agent event persistence
* EventBus telemetry
* fallback deterministic reasoning
* execution/risk integration

That makes the research system an **extension of the current architecture**, not a new subsystem.

---

# Proposed implementation

## 1. Add a dedicated Research Agent subsystem

I would add:

```text
src/services/research/
├── orchestrator.ts
├── planner.ts
├── context.ts
├── evidence.ts
├── policy.ts
├── registry.ts
├── schemas/
│   ├── common.ts
│   ├── business.ts
│   ├── financials.ts
│   ├── growth.ts
│   ├── valuation.ts
│   ├── moat.ts
│   ├── management.ts
│   ├── technical.ts
│   ├── flows.ts
│   ├── risk.ts
│   └── verdict.ts
│
├── skills/
│   ├── business.ts
│   ├── financials.ts
│   ├── growth.ts
│   ├── valuation.ts
│   ├── moat.ts
│   ├── management.ts
│   ├── technical.ts
│   ├── flows.ts
│   ├── risk.ts
│   └── verdict.ts
│
└── tools/
    ├── marketData.ts
    ├── historicalData.ts
    ├── optionData.ts
    ├── fundamentals.ts
    ├── filings.ts
    ├── news.ts
    └── calculator.ts
```

The exact 10 Instagram prompts are not present in the screenshots you gave me, so I would **not pretend that these are the original ten prompts**. This is the engineering decomposition of that concept.

---

# 2. Make the agent truly agentic

This is important.

I would not implement:

```text
prompt → LLM → answer
```

Instead:

```text
User
  │
  ▼
Research Planner
  │
  ├── determines required evidence
  ├── determines missing data
  └── builds execution graph
          │
          ▼
    Tool Execution
          │
          ▼
     Specialist Skills
          │
          ▼
     Evidence Validation
          │
          ▼
       Red Team
          │
          ▼
     Final Synthesizer
          │
          ▼
      Research Report
```

For example:

```text
"Analyze RELIANCE"

Planner
   ↓
Resolve NSE instrument
   ↓
Pull market snapshot
   ↓
Pull historical OHLCV
   ↓
Pull fundamentals
   ↓
Pull filings
   ↓
Pull recent news
   ↓
Run 8 independent analyses
   ↓
Cross-check claims
   ↓
Bear-case attack
   ↓
Final investment thesis
```

---

# 3. DhanHQ becomes the quantitative data backbone

This is where `dhanhq-sdk` is particularly useful.

For example:

```text
DhanHQ
 ├── quote
 ├── historical candles
 ├── option chain
 ├── market depth
 ├── expiry information
 └── instrument metadata
```

The existing repo already has `MarketDataService`, which consumes DhanHQ WebSocket data and REST fallback, so research should reuse that rather than creating another market-data connection.

For technical research:

```text
MarketDataService
      │
      ▼
HistoricalDataTool
      │
      ├── OHLCV
      ├── ATR
      ├── RSI
      ├── MACD
      ├── ADX
      ├── Supertrend
      ├── moving averages
      ├── volume analysis
      └── volatility
```

**Indicators should be calculated deterministically.**

The LLM should interpret:

```json
{
  "adx": 31.4,
  "rsi": 64.2,
  "atr_percent": 1.72,
  "price_vs_200dma": 8.4
}
```

rather than being asked to calculate these from raw candles.

---

# 4. Fundamentals need another data source

This is one architectural limitation we should explicitly handle.

DhanHQ is excellent for market/broker data, but we should **not assume that it provides all the fundamental/company-research information required by the Instagram prompts**.

So the abstraction should be:

```ts
interface FundamentalProvider {
  companyProfile(symbol: string): Promise<CompanyProfile>;
  financialStatements(symbol: string): Promise<FinancialStatements>;
  ratios(symbol: string): Promise<FinancialRatios>;
  shareholding(symbol: string): Promise<Shareholding>;
  filings(symbol: string): Promise<Filing[]>;
}
```

Then implementations can be:

```text
FundamentalProvider
       │
       ├── NSE/BSE
       ├── company filings
       ├── financial API
       └── future providers
```

That gives you provider independence.

---

# 5. Evidence-first architecture

This is probably the most important enhancement over a normal LLM agent.

Every factual statement should carry provenance.

Example:

```json
{
  "claim": "Revenue increased 18.2% YoY",
  "value": 18.2,
  "unit": "percent",
  "source": "financial_statement",
  "period": "FY2026",
  "retrieved_at": "2026-09-03T18:10:00Z",
  "confidence": 0.99
}
```

The synthesis agent should **only be able to use claims that exist in the evidence store**.

So:

```text
Raw Data
   ↓
Normalized Data
   ↓
Evidence Objects
   ↓
Agent Analysis
   ↓
Validated Claims
   ↓
Final Thesis
```

This dramatically reduces hallucination.

---

# 6. Structured Ollama outputs

The current repo already uses `OllamaClient` for reasoning.

For research, I would use strict structured output:

```json
{
  "score": 78,
  "stance": "POSITIVE",
  "strengths": [],
  "weaknesses": [],
  "evidence": [],
  "risks": [],
  "missing_data": [],
  "confidence": 0.84
}
```

rather than free text.

Then Zod validates it:

```text
Ollama
  ↓
JSON
  ↓
Zod
  ↓
valid?
 ├── yes → continue
 └── no  → repair/retry
```

This fits very naturally with the SDK approach you're already using.

---

# 7. Research tool policy

Create a separate policy:

```text
ResearchPolicy
├── dhan_ltp             READ
├── dhan_quote           READ
├── dhan_historical      READ
├── dhan_option_chain    READ
├── dhan_depth           READ
├── fundamentals         READ
├── filings              READ
├── news                 READ
├── calculator           READ
│
├── dhan_order           DENY
├── dhan_modify_order    DENY
├── dhan_cancel_order    DENY
├── strategy_deploy      DENY
└── execution            DENY
```

That gives us a hard architectural boundary.

---

# 8. Final research output

The API could return:

```json
{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "as_of": "2026-09-03T15:30:00+05:30",

  "business": {},
  "financials": {},
  "growth": {},
  "valuation": {},
  "moat": {},
  "management": {},
  "technical": {},
  "market_flows": {},
  "risk": {},

  "thesis": {
    "stance": "BUY",
    "score": 82,
    "confidence": 0.81,

    "bull_case": [],
    "bear_case": [],
    "catalysts": [],
    "risks": [],
    "invalidation": []
  },

  "evidence_quality": {},
  "model": "...",
  "data_sources": []
}
```

This makes it usable both by humans and downstream systems.

---

# 9. API surface

Add:

```http
POST /api/research/analyze
```

Example:

```json
{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "horizon": "swing",
  "mode": "full"
}
```

Then:

```http
GET /api/research/:id
GET /api/research/:id/events
GET /api/research/:id/evidence
GET /api/research/:id/skills
```

And potentially:

```http
POST /api/research/compare
```

for:

```text
RELIANCE vs TCS vs INFY
```

---

# 10. Frontend becomes significantly more useful

You already have an Agent Console.

Add:

```text
Research Console

┌───────────────────────────────────────────┐
│ RELIANCE                                   │
│ NSE                                        │
│                                           │
│ Overall: 82/100                           │
│ Stance: BUY                               │
│ Confidence: 81%                           │
├───────────────────────────────────────────┤
│ Business        84                        │
│ Financials      88                        │
│ Growth          79                        │
│ Valuation       71                        │
│ Moat            90                        │
│ Management      82                        │
│ Technical       76                        │
│ Market Flow     80                        │
│ Risk            65                        │
├───────────────────────────────────────────┤
│ Bull Case                                  │
│ Bear Case                                  │
│ Catalysts                                  │
│ Invalidation                               │
└───────────────────────────────────────────┘
```

And underneath:

```text
Agent Activity

planner       ✓
financials    ✓
valuation     ✓
technical     ✓
red-team      ✓
synthesis     ✓
```

This would reuse the existing EventBus telemetry infrastructure.

---

# 11. Persistence

I would add:

```text
research_runs
research_tasks
research_evidence
research_skill_results
research_claims
research_verdicts
research_sources
```

Conceptually:

```text
research_runs
     │
     ├── tasks
     │    ├── financials
     │    ├── valuation
     │    └── technical
     │
     ├── evidence
     │
     ├── claims
     │
     ├── skill_results
     │
     └── verdict
```

You already have PostgreSQL infrastructure and `agent_events`, so this follows the existing persistence pattern.

---

# 12. The really powerful part: connect research to your trading engine

Once the research layer works, we can eventually have:

```text
Research Intelligence
        │
        ▼
Market Intelligence
        │
        ▼
Strategy Intelligence
        │
        ▼
Risk Engine
        │
        ▼
Execution
```

But **research should not directly trigger trades**.

A better contract is:

```json
{
  "symbol": "RELIANCE",
  "bias": "BULLISH",
  "score": 82,
  "confidence": 0.81,
  "horizon": "SWING",
  "conditions": [
    "price_above_200dma",
    "earnings_growth_positive"
  ],
  "invalidation": [
    "close_below_200dma"
  ]
}
```

Then your existing strategy engine decides whether that research signal is actionable.

---

# My assessment of the current repository

### Strong foundation

| Area                   | Current state      | Research integration                |
| ---------------------- | ------------------ | ----------------------------------- |
| DhanHQ                 | Already integrated | Reuse                               |
| Ollama                 | Already integrated | Reuse                               |
| Agent loop             | Already exists     | Extend                              |
| Tool registry          | Already exists     | Create restricted research registry |
| Policy                 | Already exists     | Add research policy                 |
| EventBus               | Already exists     | Reuse                               |
| PostgreSQL             | Already exists     | Extend                              |
| REST API               | Already exists     | Extend                              |
| WebSocket telemetry    | Already exists     | Reuse                               |
| Risk engine            | Already exists     | Keep separate                       |
| Execution              | Already exists     | Keep isolated                       |
| Frontend agent console | Already exists     | Extend into Research Console        |

The repo currently calls the system **Axis Nexus** and already describes itself as an autonomous options trading backend with an agentic AI loop.

So the correct evolution is:

```text
Axis Nexus
│
├── Trading Intelligence
│   ├── Market Data
│   ├── Strategy
│   ├── Risk
│   └── Execution
│
└── Research Intelligence       ← ADD
    ├── Research Planner
    ├── 10 Research Skills
    ├── Evidence Engine
    ├── Fundamental Providers
    ├── Valuation Engine
    ├── Red Team
    └── Thesis Engine
```

## One thing I would change from the current design

The existing `AgentOrchestrator` is **too tightly coupled to trading execution concerns**: it holds Dhan client, market, risk, paper/live/sandbox engines and can reach the execution side.

For the research layer, I would **not keep adding responsibilities to `agent.ts`**.

Instead:

```text
AgentOrchestrator
        │
        ├── TradingOrchestrator
        │
        └── ResearchOrchestrator
```

That will prevent the AI subsystem from becoming one enormous god object.

### Final architecture

```text
                    AXIS NEXUS
                         │
                ┌────────┴────────┐
                │                 │
         Trading Plane       Research Plane
                │                 │
        AgentOrchestrator   ResearchOrchestrator
                │                 │
        ┌───────┼───────┐   ┌─────┼───────────────┐
        │       │       │   │     │               │
      Market Strategy Risk  Data  Skills       Evidence
        │       │       │   │     │               │
        └───────┴───┬───┘   └─────┴──────┬────────┘
                    │                    │
                 DhanHQ              Ollama
                    │                    │
                    └────────┬───────────┘
                             │
                       Unified EventBus
                             │
                       PostgreSQL / UI
```

**Yes, this is absolutely implementable in `axis-nexus`, and the repository is already surprisingly close to the required architecture.** The main work is introducing a clean research domain rather than bolting more logic into the existing trading agent.

The next sensible step is to work directly against the repository and implement this as a separate `ResearchOrchestrator` + 10 skill registry + read-only Dhan/Ollama tool layer, with tests and the REST API, rather than just documenting it.
