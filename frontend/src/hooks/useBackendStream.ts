import { useEffect, useRef, useCallback, useState } from 'react';
import { log } from '../services/logger';
import { wsUrlWithToken } from '../services/api';

/**
 * Backend telemetry stream — the ONLY realtime channel into the UI.
 *
 * The backend pushes typed envelopes { channel, ts, payload } for:
 *   tick | log | alert | telemetry | risk | portfolio | order | system
 *
 * This hook connects, subscribes (all channels by default), auto-reconnects
 * with backoff, and dispatches each envelope to the AppContext reducers.
 * The default URL matches the backend server (port 3003, path /ws).
 */

export type Channel = 'tick' | 'log' | 'alert' | 'telemetry' | 'risk' | 'portfolio' | 'order' | 'system';

export interface Envelope {
  channel: Channel;
  ts: number;
  payload: any;
}

interface StreamState {
  connected: boolean;
  lastMessageAt: number | null;
}

export function useBackendStream(
  onEnvelope: (env: Envelope) => void,
  channels?: Channel[],
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<StreamState>({ connected: false, lastMessageAt: null });
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const onEnvelopeRef = useRef(onEnvelope);
  onEnvelopeRef.current = onEnvelope;
  const isMountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!isMountedRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // WS URL with ?token= appended when VITE_CONTROL_PLANE_TOKEN is set
    // (see services/api.ts). The backend's verifyClient uses the same
    // timing-safe compare as the HTTP bearer gate.
    const WS_URL = wsUrlWithToken('/ws');

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) {
          ws.close();
          return;
        }
        retriesRef.current = 0;
        setState((s) => ({ ...s, connected: true }));
        log.info('Telemetry stream connected', { source: 'ws' });
        ws.send(JSON.stringify({
          type: 'subscribe',
          channels: channels ?? ['tick', 'log', 'alert', 'telemetry', 'risk', 'portfolio', 'order', 'system'],
        }));
      };

      ws.onmessage = (event) => {
        try {
          const env: Envelope = JSON.parse(event.data);
          setState((s) => ({ ...s, lastMessageAt: Date.now() }));
          if (env && env.channel) {
            onEnvelopeRef.current(env);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!isMountedRef.current) return;
        const delay = Math.min(30000, 3000 * Math.pow(1.6, retriesRef.current++));
        log.warn('Telemetry stream disconnected — reconnecting', {
          source: 'ws',
          attempt: retriesRef.current,
          nextRetryMs: delay,
        });
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Spec automatically triggers onclose — avoid manual close on connecting socket
      };
    } catch {
      if (isMountedRef.current) {
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    }
  }, [channels]);

  useEffect(() => {
    isMountedRef.current = true;
    connect();
    return () => {
      isMountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, [connect]);

  return state;
}
