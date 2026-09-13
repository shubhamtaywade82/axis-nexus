import { Router } from 'express';
import { z } from 'zod';
import type { ScalpPositionManager } from '../services/scalpPositionManager';
import { DEFAULT_SCALP_CONFIG } from '../services/scalpConfig';
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('scalp_routes');

const ScalpConfigPatchSchema = z.object({
  minCapturePerLot: z.number().positive().optional(),
  spreadBufferPerLot: z.number().positive().optional(),
  ratchet: z.array(z.object({
    peakR: z.number().nonnegative(),
    slTrailPctOfPeak: z.number().positive(),
    floorR: z.number().nonnegative(),
    givebackPct: z.number().min(0).max(1),
  }).strict()).min(1).max(10).optional(),
  targetMultiplier: z.object({
    min: z.number().positive(),
    max: z.number().positive(),
  }).strict().optional(),
  useUnderlyingTrail: z.boolean().optional(),
  atrMultiple: z.number().positive().optional(),
  maxFlatHoldMs: z.number().int().positive().optional(),
  minMoveToHold: z.number().positive().optional(),
  deltaGate: z.object({
    min: z.number().min(0).max(1),
    max: z.number().min(0).max(1),
  }).strict().optional(),
  maxSpreadPct: z.number().positive().optional(),
  minIvRank: z.number().nonnegative().optional(),
  minVolume: z.number().int().nonnegative().optional(),
  minExpectedMoveMultiple: z.number().positive().optional(),
}).strict().optional();

export function scalpRoutes(manager: ScalpPositionManager): Router {
  const router = Router();

  // ── Open positions (real-time state) ──────────────────────────────────
  router.get('/positions', (_req, res) => {
    res.json({ positions: manager.getOpenPositions(), ts: Date.now() });
  });

  // ── Trade history ─────────────────────────────────────────────────────
  router.get('/history', (req, res) => {
    const limit = Math.min(100, Number(req.query.limit) || 50);
    res.json({ history: manager.getHistory(limit), ts: Date.now() });
  });

  // ── Stats ─────────────────────────────────────────────────────────────
  router.get('/stats', (_req, res) => {
    res.json(manager.getStats());
  });

  // ── Config ────────────────────────────────────────────────────────────
  router.get('/config', (_req, res) => {
    res.json(manager.getConfig());
  });

  router.post('/config', (req, res) => {
    const parsed = ScalpConfigPatchSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data) {
      return res.status(400).json({ error: parsed.success ? 'empty body' : parsed.error.issues[0]?.message || 'invalid config' });
    }
    manager.setConfig(parsed.data);
    res.json(manager.getConfig());
  });

  // ── Enable/disable ────────────────────────────────────────────────────
  router.post('/enable', (req, res) => {
    const enabled = req.body?.enabled !== false;
    if (enabled) manager.start();
    else manager.stop();
    res.json({ enabled: manager.isEnabled() });
  });

  return router;
}
