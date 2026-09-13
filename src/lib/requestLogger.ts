import pinoHttp, { stdSerializers, type ReqId } from 'pino-http';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { parseTraceparent } from './logger';

/**
 * HTTP request logging middleware (pino-http).
 *
 * Behavior:
 *   - Correlation: honors an inbound `x-request-id` / `x-correlation-id`
 *     header (the frontend sends one on every API call) or generates a
 *     UUID. The id is echoed back as `x-request-id` on the response so
 *     the client can attach it to follow-up reports.
 *   - OpenTelemetry: if the caller sends a W3C `traceparent` header,
 *     its traceId/spanId are bound onto the request logger — logs and
 *     traces stay correlatable without a full OTel SDK on our side.
 *   - Noise control: `/api/health` (polled every few seconds by the
 *     control plane) is excluded from access logging.
 *   - `req.log` is a child logger carrying requestId (+traceId) — use it
 *     inside any route: `req.log.info({ symbol }, 'order placed')`.
 */

// NOTE: pino-http already augments http.IncomingMessage with
// `id: ReqId` and `log: pino.Logger`, and Express's Request extends
// IncomingMessage — so `req.log` / `req.id` are fully typed everywhere
// without any local module augmentation (re-declaring them here would
// conflict with pino-http's types).

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestLogger: import('express').RequestHandler = pinoHttp({
  logger,
  genReqId: (req: Request, res: Response) => {
    const incoming =
      (req.headers['x-request-id'] as string | undefined) ||
      (req.headers['x-correlation-id'] as string | undefined);
    const id = incoming && /^[\w.-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, String(id));
    return id as ReqId;
  },
  customProps: (req: Request) => {
    const trace = parseTraceparent(req.headers.traceparent);
    return trace ? { traceId: trace.traceId, spanId: trace.spanId } : {};
  },
  customSuccessMessage: (req: Request, res: Response) =>
    `${req.method} ${req.originalUrl ?? req.url} → ${res.statusCode}`,
  customErrorMessage: (req: Request, res: Response, err: Error) =>
    `${req.method} ${req.originalUrl ?? req.url} → ${res.statusCode} (${err.message})`,
  customLogLevel: (_req: Request, res: Response, err?: unknown) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: {
    ignore: (req: Request) => {
      const path = (req.url ?? '').split('?')[0];
      // Background polls from the dashboard — hide so operator actions stand out.
      const quiet = [
        '/api/health',
        '/api/control/state',
        '/api/portfolio/positions',
        '/api/portfolio/funds',
        '/api/portfolio/orders',
        '/api/portfolio/strategies',
        '/api/portfolio/margin/reconcile',
        '/api/market/indices',
      ];
      return quiet.some((p) => path === p || path.startsWith(`${p}/`));
    },
  },
  // Quiet serializers: no request bodies in logs (they can carry order
  // params and tokens) — method/url/status/duration are enough.
  serializers: {
    req: stdSerializers.req,
    res: stdSerializers.res,
  },
});


/**
 * Central error handler — MUST be registered LAST (after all routes).
 * Express 5 async route rejections land here. Logs the error with the
 * request's correlation id and stack, and answers with the JSON error
 * shape the frontend already expects: { error: string }.
 *
 * In production, the response body is sanitized: the client sees a
 * generic message ("Internal server error" / "Request failed") rather
 * than the raw \`e.message\`, which can leak Postgres connection strings,
 * broker API error stacks, file paths, or internal module names. The
 * full detail is still logged server-side with the correlation id, so
 * an operator can trace any 500 to its real cause via requestId.
 *
 * 4xx errors (caller mistakes) DO surface the raw message — they're
 * already user-facing ("securityId and exchangeSegment are required") and
 * sanitizing them would make the API harder to use without buying safety.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const status = typeof (err as any).status === 'number' ? (err as any).status : 500;
  const log = (req.log ?? logger).child({ requestId: req.id });
  const isProd = process.env.NODE_ENV === 'production';
  // 4xx: caller mistake, message is already user-facing — keep verbatim.
  // 5xx: server fault, raw message may leak internals — sanitize in prod.
  const clientMessage = status < 500 || !isProd
    ? (err.message || 'Internal server error')
    : (status >= 500 ? 'Internal server error' : 'Request failed');
  log.error(
    {
      err: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      method: req.method,
      url: req.url,
      status,
      // Mark whether the client saw the real message or the sanitized one
      // — useful when triaging a 500 from logs: \`sanitized:true\` means
      // the operator needs to look up the requestId to learn the cause.
      sanitized: clientMessage !== err.message,
    },
    status >= 500 ? 'Unhandled route error' : 'Request failed',
  );
  if (res.headersSent) return;
  res.status(status).json({ error: clientMessage });
}

/** JSON 404 for unknown /api paths (default Express HTML is useless to the SPA). */
export function notFoundHandler(req: Request, res: Response): void {
  if (req.url.startsWith('/api')) {
    (req.log ?? logger).warn({ url: req.url }, 'Unknown API route');
    res.status(404).json({ error: `Not found: ${req.method} ${req.url}` });
    return;
  }
  res.status(404).json({ error: 'Not found' });
}
