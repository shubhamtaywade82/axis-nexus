# Security Policy

This document describes the security model of the Axis Nexus autonomous
trading control plane, how to configure it safely for different deployment
shapes, and how to report vulnerabilities.

## Threat model

The control plane is an HTTP + WebSocket server that can place real orders
against a DhanHQ broker account. The highest-severity threats, in order:

1. **Unauthenticated order placement** — an attacker who can reach
   `/api/portfolio/paper/order` or `/api/control/agent/run` can place
   trades or arm the kill switch.
2. **Timing-attack token recovery** — a non-constant-time token comparison
   leaks the secret's prefix length through response-time side channels.
3. **Internal error leakage** — raw `Error.message` strings in 500
   responses can expose Postgres connection strings, broker API stacks,
   or file paths.
4. **CSRF / clickjacking from a malicious same-origin page** — any
   webpage open in the operator's browser can issue `fetch()` to
   `localhost:3003` unless CORS rejects it.
5. **Runaway script flooding** — a buggy frontend loop or compromised
   tab can hammer write endpoints unbounded.

## Authentication

### Bearer token (`CONTROL_PLANE_TOKEN`)

The control plane accepts a shared bearer token, validated by
[`src/lib/authToken.ts`](src/lib/authToken.ts):

- HTTP requests: `Authorization: Bearer <token>` header (parsed by
  `extractBearer()`, validated by `safeTokenCompare()`).
- WebSocket upgrade: `?token=<token>` query parameter (browsers can't
  set Authorization headers on a WS handshake).
- Comparison is **constant-time** via `crypto.timingSafeEqual` — no
  first-byte short-circuit, no length leak beyond what's already
  non-secret for a configured bearer token.
- `/api/health` is exempt so the dashboard can show "backend down"
  before the operator finishes configuring the token.

### Loopback vs. network deployment

The token posture depends on `CONTROL_PLANE_HOST`:

| Host | Token required? | Why |
|---|---|---|
| `127.0.0.1` / `localhost` / `::1` (default) | Optional but recommended | Loopback is reachable by any local process or webpage; CORS alone is not a real boundary. |
| Anything else (e.g. `0.0.0.0`, Docker `-p 3003:3003`) | **Mandatory** — boot aborts without it | An unauthenticated order-placement API on a network interface is the most dangerous misconfiguration for an autonomous trading server. |

### Frontend wiring

The frontend reads `VITE_CONTROL_PLANE_TOKEN` at build time and attaches
it as a Bearer header on every REST request (except `/api/health`) and
as `?token=` on the WebSocket URL. See
[`frontend/src/services/api.ts`](frontend/src/services/api.ts) and
[`frontend/src/hooks/useBackendStream.ts`](frontend/src/hooks/useBackendStream.ts).

The token is a **build-time constant**, not a runtime fetch — a runtime
fetch would itself need to be unauthenticated to retrieve the token,
which defeats the purpose. For hosted deployments, bake the token into
the build via CI secrets.

## CORS

Allowed origins are exact-matched against an allowlist
([`src/server.ts`](src/server.ts)):

- `CONTROL_PLANE_ORIGIN` (default `http://localhost:5175`)
- A fixed list of dev origins (`:5175`, `:5173` on `localhost` + `127.0.0.1`)

In `NODE_ENV=production`, the dev-only regex
`/^http:\/\/(localhost|127\.0\.0\.1):\d+$/` is dropped — a published
Docker image must not accept arbitrary localhost-port origins.

No `Origin` header (curl, SDK, same-origin) is always allowed.

## Security headers

[`helmet`](https://helmetjs.github.io/) is applied with a JSON-API-tuned
CSP:

- `defaultSrc: 'none'` — no HTML/JS/CSS from this origin
- `frameAncestors: 'none'` — cannot be framed (clickjacking defense)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (when behind HTTPS)
- `Referrer-Policy: no-referrer`

## Rate limiting

[`src/lib/rateLimiters.ts`](src/lib/rateLimiters.ts) defines two
in-memory per-IP limiters:

- **Write routes** (`/api/portfolio/*`, `/api/control/*`): 60 req/min/IP.
  GETs are exempt so dashboard polling never trips it.
- **Agent runs** (`/api/control/agent/run`): 6 req/min/IP, since each
  run takes 10-30s and consumes LLM tokens.

`/api/client-logs` has its own custom per-IP token bucket in
[`src/routes/clientLogs.ts`](src/routes/clientLogs.ts) (it needs a
batched-event shape, not a per-request limiter).

## Input validation

All write routes (POST/PUT/DELETE) and most GET routes with query
params are validated by [zod schemas](src/lib/routeSchemas.ts):

- Request bodies: `.strict()` mode rejects unknown top-level keys (catches
  typos like `transactiontype` vs `transactionType`).
- Query params: `z.coerce.number()` handles string→number conversion
  with bounds (e.g. `days` must be int 1–10).
- WebSocket client→server messages: discriminated union on `type`.
- Responses: 400 with a single user-facing error string from `zodError()`.

## Error sanitization

In `NODE_ENV=production`, the central error handler
([`src/lib/requestLogger.ts`](src/lib/requestLogger.ts)) returns a
generic `"Internal server error"` for 5xx responses instead of the raw
`Error.message`. 4xx responses keep the raw message (it's already
user-facing, e.g. "securityId and exchangeSegment are required"). The
full error detail is always logged server-side with the `requestId`.

## Secret redaction

[Pino](src/lib/logger.ts) redacts these paths from every log line:

- Generic: `password`, `token`, `accessToken`, `refreshToken`, `secret`,
  `authorization`, `cookie`, `apiKey`, `pin`
- DhanHQ-specific: `dhanAccessToken`, `totpSecret`, `totp`
- Nested wildcards: `*.password`, `*.token`, etc.
- HTTP headers: `req.headers.authorization`, `req.headers.cookie`

Redacted values appear as `[REDACTED]` in both stdout and the daily
`.jsonl` log file.

## Reporting a vulnerability

**DO NOT open a public GitHub issue for security vulnerabilities.**

Email the maintainer privately at `shubhamtaywade82@github.com` (or the
email on the GitHub profile) with:

1. A description of the issue
2. Steps to reproduce (or a proof-of-concept)
3. Affected versions
4. Suggested fix (if any)

You will receive an acknowledgment within 72 hours. Please do not
disclose the issue publicly until a fix has been released.

## Deployment checklist

Before exposing the control plane to anything other than loopback:

- [ ] `CONTROL_PLANE_TOKEN` set to a high-entropy random string (≥32 chars)
- [ ] `CONTROL_PLANE_HOST` explicitly set (not `0.0.0.0` unless intended)
- [ ] `NODE_ENV=production` (tightens CORS, sanitizes errors)
- [ ] `VITE_CONTROL_PLANE_TOKEN` baked into the frontend build
- [ ] HTTPS termination in front (for HSTS to take effect)
- [ ] Firewall rules limiting source IPs if possible
- [ ] `ALLOW_LIVE_TRADING` left unset until a supervised first live
      session confirms the kill switch and reconciler fire correctly
      against a real DhanHQ account
