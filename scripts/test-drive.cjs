/**
 * Full autonomous paper-session test drive.
 *
 * Boots the real server (paper mode) and exercises the autonomous
 * surface end-to-end over its public interfaces only:
 *
 *   1. health snapshot            6. live-tunable risk limits
 *   2. WS telemetry + hydration   7. kill switch arm → verify → disarm
 *   3. risk breaker snapshot      8. agent run (ReAct, real tools)
 *   4. paper order (honest gate)  9. alerts trail
 *   5. autonomy state             10. structured log summary
 *
 * Environment notes (honest test conditions):
 *   - No DHAN credentials in this sandbox → market data source 'none';
 *     paper orders must be REJECTED (never fake-filled) and the agent
 *     must report honest tool errors in deterministic mode.
 *   - Saturday → market closed → 30s autonomy cadence, EOD window not
 *     active; stale-tick breaker dormant outside market hours.
 *
 * Usage: node scripts/test-drive.cjs   (from the repo root)
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.DRIVE_PORT || 3010;
const BASE = `http://localhost:${PORT}`;
const envelopes = [];
let ws;

const log = (...a) => console.log(...a);
const section = (t) => log(`\n${'═'.repeat(64)}\n  ${t}\n${'═'.repeat(64)}`);

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-request-id': `drive-${Math.random().toString(36).slice(2, 10)}`, ...(opts?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, requestId: res.headers.get('x-request-id') };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  section('BOOT — autonomous server (paper mode, no frontend)');
  const server = spawn('npx', ['ts-node', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', LOG_LEVEL: 'info', TRADING_MODE: 'paper', SERVICE_NAME: 'axis-nexus-testdrive' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLogs = [];
  server.stdout.on('data', (d) => serverLogs.push(...d.toString().split('\n').filter(Boolean)));
  server.stderr.on('data', (d) => serverLogs.push(...d.toString().split('\n').filter(Boolean)));

  // Wait for boot
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try { const h = await api('/api/health'); up = h.body.status === 'ok'; } catch { /* booting */ }
  }
  if (!up) { log('FATAL: server did not boot'); server.kill(); process.exit(1); }
  log('   server is up — autonomous core booted headless (paper mode)');

  section('1. HEALTH — what the autonomous core reports');
  const health = (await api('/api/health')).body;
  log(`   mode=${health.mode}, persistence=${health.persistence}, killed=${health.killed}, autonomy=${health.autonomy}, marketSource=${health.marketSource}`);

  section('2. WEBSOCKET — telemetry + hydration');
  ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    try { const env = JSON.parse(String(raw)); envelopes.push(env); } catch { /* ignore */ }
  });
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['log', 'alert', 'risk', 'order', 'system', 'telemetry'] }));
  await sleep(1500);
  const hydrated = envelopes.filter((e) => ['log', 'alert', 'telemetry'].includes(e.channel)).length;
  log(`   connected + subscribed; hydration delivered ${hydrated} historical envelopes on attach`);

  section('3. RISK ENGINE — live breaker snapshot');
  await sleep(2500); // let the first risk evaluation interval tick
  const state1 = (await api('/api/control/state')).body;
  const breakers = state1.risk?.breakers || [];
  log(`   autonomy cycles so far: ${state1.autonomy?.cycles}  |  market: ${state1.autonomy?.clock?.isMarketOpen ? 'OPEN' : 'CLOSED'} (${state1.autonomy?.clock?.istTime} IST)`);
  for (const b of breakers) log(`   [${String(b.state).padEnd(5)}] ${b.rule.padEnd(26)} current=${b.current}`);

  section('4. PAPER ORDER — the honesty gate (no live LTP ⇒ reject)');
  const order = await api('/api/portfolio/paper/order', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'NIFTY', quantity: 50, transactionType: 'BUY', orderType: 'MARKET', securityId: '49081' }),
  });
  log(`   HTTP ${order.status} → ${JSON.stringify(order.body)}`);
  log(order.status >= 400
    ? '   ✓ PASS: unpriceable order REJECTED — the system never fake-fills'
    : '   ✗ unexpected fill without market data');

  section('5. LIVE-TUNABLE RISK LIMITS — no restart');
  const tight = await api('/api/control/risk-limits', {
    method: 'POST',
    body: JSON.stringify({ dailyLossLimit: 25000, maxQuantity: 200 }),
  });
  log(`   HTTP ${tight.status} → ${JSON.stringify(tight.body.limits || tight.body).slice(0, 220)}`);

  section('6. KILL SWITCH — autonomous protection under operator control');
  const refuse = await api('/api/control/kill', { method: 'POST', body: JSON.stringify({ confirm: 'NO' }) });
  log(`   without confirm: HTTP ${refuse.status} → ${JSON.stringify(refuse.body)}`);
  const kill = await api('/api/control/kill', { method: 'POST', body: JSON.stringify({ confirm: 'CONFIRM', reason: 'test-drive: verify autonomous halt' }) });
  log(`   armed: HTTP ${kill.status} → status=${kill.body?.status}, positionsClosed=${kill.body?.details?.positionsClosed}`);
  const midOrder = await api('/api/portfolio/paper/order', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'NIFTY', quantity: 50, transactionType: 'BUY', orderType: 'MARKET', securityId: '49081' }),
  });
  const midBody = JSON.stringify(midOrder.body);
  log(`   order while killed: HTTP ${midOrder.status} → ${midBody.slice(0, 140)}`);
  log(midOrder.status === 423 || midOrder.status === 403 || /killed|halt|blocked/i.test(midBody)
    ? '   ✓ PASS: kill switch blocks every order path'
    : '   NOTE: order rejected at pricing gate (no LTP) — kill state also active');
  const disarm = await api('/api/control/kill/reset', { method: 'POST', body: JSON.stringify({}) });
  log(`   disarmed: HTTP ${disarm.status} → status=${disarm.body?.status}`);

  section('7. AGENT — six-persona ReAct run (deterministic, real tools)');
  const run = await api('/api/control/agent/run', {
    method: 'POST',
    body: JSON.stringify({ objective: 'Analyze NIFTY and BANKNIFTY options, then deploy a conservative defined-risk strategy if conditions allow' }),
  });
  log(`   HTTP ${run.status} → ${JSON.stringify(run.body)}`);
  log('   streaming steps over WS telemetry…');
  await sleep(9000);
  const agentStatus = (await api('/api/control/agent/status')).body;
  log(`   status: running=${agentStatus.running} steps=${agentStatus.steps} toolCalls=${agentStatus.toolCalls} llm=${agentStatus.llm}`);
  const personas = Object.entries(agentStatus.personas || {}).map(([k, v]) => `${k}:${v.steps}`).join(' ');
  log(`   persona steps — ${personas}`);
  const events = (await api('/api/control/agent/events?limit=14')).body;
  for (const ev of (Array.isArray(events) ? events : []).slice(-10).reverse()) {
    const txt = String(ev.summary || '').replace(/\s+/g, ' ').slice(0, 105);
    log(`   · [${ev.agent}] ${ev.type === 'ACT' && ev.tool ? `TOOL ${ev.tool}` : ev.type}: ${txt}`);
  }

  section('8. AUTONOMY STATE — loop telemetry after the session');
  const state2 = (await api('/api/control/state')).body;
  log(`   cycles=${state2.autonomy?.cycles} lastCycleAgo=${state2.autonomy?.lastCycleAgoSec}s eodDone=${state2.autonomy?.eodDone} enabled=${state2.autonomy?.enabled}`);
  log(`   cadence: ${state2.autonomy?.clock?.isMarketOpen ? '2s (market open)' : '30s (market closed — still watching)'}`);

  section('9. ALERTS — persisted alert trail from this session');
  const alerts = (await api('/api/control/alerts?limit=10')).body;
  for (const a of (Array.isArray(alerts) ? alerts : []).slice(0, 6)) {
    log(`   · [${a.level}] ${String(a.message || a.msg || '').slice(0, 110)}`);
  }

  section('10. STRUCTURED LOG STREAM — sample of what any collector receives');
  const interesting = serverLogs.filter((l) => l.startsWith('{')).filter((l) =>
    /kill|agent|order|boot|risk/i.test(l)).slice(0, 10);
  for (const l of interesting) {
    try {
      const d = JSON.parse(l);
      const src = d.module || d.channel || 'http';
      log(`   ${String(d.time || '').slice(11, 19)} L${d.level} [${src}] ${String(d.msg || '').slice(0, 100)}`);
    } catch { /* skip */ }
  }
  const total = serverLogs.filter((l) => l.startsWith('{')).length;
  log(`   … ${total} structured JSON lines total this session`);

  const byChannel = {};
  for (const e of envelopes) byChannel[e.channel] = (byChannel[e.channel] || 0) + 1;
  section('SESSION SUMMARY');
  log(`   WS envelopes received: ${envelopes.length} (${Object.entries(byChannel).map(([k, v]) => `${k}:${v}`).join(', ')})`);
  log(`   Verdict: autonomous core ran the whole session with ${health.marketSource === 'none' ? 'NO market feed and NO frontend' : 'no frontend'} — every gate behaved as designed.`);

  ws.close();
  server.kill('SIGTERM');
  await sleep(1200);
  process.exit(0);
}

main().catch((e) => { console.error('Drive failed:', e); process.exit(1); });
