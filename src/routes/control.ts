import { Router } from 'express';
import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { RiskEngine } from '../services/riskEngine';
import type { AutonomyEngine } from '../services/autonomy';
import type { AgentOrchestrator } from '../services/agent';
import type { MarketDataService } from '../services/marketData';
import { crossCheckJournalOnBoot } from '../core';
import { getTradingMode } from '../lib/tradingMode';
import { eventBus } from '../services/eventBus';
import { journal } from '../services/journal';
import { getSystemState, setSystemState } from '../services/systemState';
import { listAlerts, pushAlert } from '../db';
import { evaluateStrategyBacktest } from '../services/strategyConstructor';
import { analyzeOptionsBehavior } from './market';
import {
  AgentRunSchema, AlertTestSchema, AutonomyToggleSchema, KillSwitchSchema,
  LongOptionPolicySchema, RiskLimitsPatchSchema, ScannerToggleSchema, SquareOffSchema,
  zodError,
} from '../lib/routeSchemas';
import { getRuntimeVersions } from '../lib/versions';

/**
 * Control-plane routes.
 *
 * The frontend is a CONTROL PLANE: it reads backend state and issues
 * control commands (kill switch, autonomy toggle, risk limits, agent
 * runs). It never executes trades itself and never substitutes for the
 * backend's autonomous loop — everything here works identically with
 * zero frontend attached.
 */
export function controlRoutes(
  client: DhanClient,
  risk: RiskEngine,
  autonomy: AutonomyEngine,
  agent: AgentOrchestrator,
  market: MarketDataService,
  sandboxClient?: DhanClient,
): Router {
  const router = Router();

  // ── system state ────────────────────────────────────────────────────
  router.get('/state', async (_req, res) => {
    const [alerts, agentEvents] = await Promise.all([listAlerts(50), agent.events(50)]);
    res.json({
      mode: getTradingMode(),
      systemState: getSystemState(),
      risk: risk.snapshot(),
      autonomy: autonomy.stats(),
      agent: agent.status(),
      market: market.stats(),
      alerts,
      agentEvents,
      version: getRuntimeVersions(),
    });
  });

  // ── kill switch ─────────────────────────────────────────────────────
  router.post('/kill', async (req, res) => {
    try {
      const parsed = KillSwitchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { reason } = parsed.data;
      const result = await risk.armKillSwitch(reason || 'Manual kill switch from control plane');
      journal.append('control_command', { route: 'POST /kill', reason, result });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/kill/reset', async (_req, res) => {
    try {
      const result = await risk.disarmKillSwitch();
      journal.append('control_command', { route: 'POST /kill/reset', result });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── autonomy ────────────────────────────────────────────────────────
  router.post('/autonomy', async (req, res) => {
    const parsed = AutonomyToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: zodError(parsed.error) });
    }
    const { enabled } = parsed.data;
    autonomy.setEnabled(enabled);
    await pushAlert('INFO', 'control_plane', `Autonomy engine ${enabled ? 'resumed' : 'paused'} via control plane`);
    journal.append('control_command', { route: 'POST /autonomy', enabled });
    res.json({ status: 'ok', enabled: autonomy.isEnabled(), stats: autonomy.stats() });
  });

  router.post('/scanner', (req, res) => {
    const parsed = ScannerToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: zodError(parsed.error) });
    }
    const { enabled } = parsed.data;
    autonomy.setScanEnabled(enabled);
    journal.append('control_command', { route: 'POST /scanner', enabled });
    res.json({ status: 'ok', stats: autonomy.stats() });
  });

  router.get('/adaptive-supertrend', async (_req, res) => {
    const scanner = autonomy.getScanner();
    if (!scanner) return res.status(503).json({ error: 'Adaptive Supertrend scanner not armed' });
    res.json(await scanner.probe());
  });

  router.post('/reconcile-boot', async (_req, res) => {
    try {
      await crossCheckJournalOnBoot(journal.readTodayEntries(), risk, client, sandboxClient);
      journal.append('control_command', { route: 'POST /reconcile-boot', systemState: getSystemState() });
      res.json({ status: 'ok', systemState: getSystemState() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── long-option peak-profit policy ─────────────────────────────────
  router.get('/long-option-policy', (_req, res) => {
    res.json({ enabled: autonomy.longOptionManager.isEnabled(), positions: autonomy.longOptionManager.snapshot() });
  });

  router.post('/long-option-policy', (req, res) => {
    const parsed = LongOptionPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: zodError(parsed.error) });
    }
    const { enabled } = parsed.data;
    autonomy.longOptionManager.setEnabled(enabled);
    res.json({ status: 'ok', enabled: autonomy.longOptionManager.isEnabled() });
  });

  router.post('/square-off', async (req, res) => {
    try {
      const parsed = SquareOffSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const reason = parsed.data?.reason || 'Manual square-off from control plane';
      const closed = await autonomy.squareOffAll(reason);
      journal.append('control_command', { route: 'POST /square-off', reason, closed });
      res.json({ status: 'ok', closed });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── risk limits ─────────────────────────────────────────────────────
  router.get('/risk-limits', (_req, res) => {
    res.json(risk.getLimits());
  });

  router.post('/risk-limits', async (req, res) => {
    const parsed = RiskLimitsPatchSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data) {
      return res.status(400).json({ error: parsed.success ? 'empty body' : zodError(parsed.error) });
    }
    const patch = parsed.data;
    const updated = await risk.setLimits(patch);
    journal.append('control_command', { route: 'POST /risk-limits', patch, updated });
    res.json(updated);
  });

  // ── agent ───────────────────────────────────────────────────────────
  router.post('/agent/run', async (req, res) => {
    try {
      const parsed = AgentRunSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: zodError(parsed.error) });
      }
      const { objective } = parsed.data;
      const result = await agent.run(objective, 'control_plane');
      journal.append('control_command', { route: 'POST /agent/run', objective, result });
      res.json(result);
    } catch (e: any) {
      res.status(e.message?.includes('in progress') ? 409 : 500).json({ error: e.message });
    }
  });

  router.get('/agent/status', async (_req, res) => {
    const llmOnline = await agent.refreshLlm();
    res.json({ ...agent.status(), llmOnline });
  });

  // Per-Ollama-Cloud-key health (which numbered OLLAMA_API_KEY_N is
  // currently cooling down after a failure, e.g. a rate limit) — read-only,
  // reports the SDK's own circuit-breaker state, makes no new LLM calls.
  router.get('/agent/ollama-keys', (_req, res) => {
    res.json(agent.ollamaKeyStatus());
  });

  router.get('/agent/events', async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(await agent.events(limit));
  });

  router.get('/agent/tools', (_req, res) => {
    res.json(agent.toolCatalog());
  });

  // ── alerts ──────────────────────────────────────────────────────────
  router.get('/alerts', async (req, res) => {
    res.json(await listAlerts(Math.min(500, Number(req.query.limit) || 100)));
  });

  router.post('/alerts/test', async (req, res) => {
    const parsed = AlertTestSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data) {
      return res.status(400).json({ error: parsed.success ? 'empty body' : zodError(parsed.error) });
    }
    const { level, message } = parsed.data;
    await pushAlert(level, 'control_plane', message);
    eventBus.emit('alert', { level, source: 'control_plane', msg: message });
    res.json({ status: 'ok' });
  });

  // ── strategy backtest ───────────────────────────────────────────────
  router.post('/strategy/backtest', async (req, res) => {
    try {
      const { symbol = 'NIFTY', type = 'STRADDLE', days = 5, entryType, targetPct, slPct, timeExit, lots, side } = req.body || {};
      const secMap: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', FINNIFTY: '27', MIDCPNIFTY: '442', SENSEX: '51' };
      const sym = symbol.toUpperCase();
      const secId = secMap[sym] || '13';
      const histData = await analyzeOptionsBehavior(client, {
        symbol: sym,
        securityId: secId,
        daysCount: Math.min(10, Math.max(1, Number(days) || 5)),
        interval: '1',
        expiryFlag: 'WEEK',
        expiryCode: 1,
      });
      const report = evaluateStrategyBacktest(sym, type, histData.days || [], {
        entryType,
        targetPct: Number(targetPct) || 20,
        slPct: Number(slPct) || 15,
        timeExit: timeExit || '13:30',
        lots: Number(lots) || 1,
        side,
      });
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: `Strategy backtest failed: ${e.message}` });
    }
  });

  return router;
}
