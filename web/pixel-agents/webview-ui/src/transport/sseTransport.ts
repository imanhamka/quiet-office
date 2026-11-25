// quiet-office: read-only Server-Sent Events transport for the wallpaper server.
//
// Receives ServerMessages from `GET /events` (`data: <json>` per event) and from
// same-window `message` events (browserMock's asset dispatch, the ?demo=1 agents).
// send() drops every ClientMessage: the wallpaper never talks back.

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { ServerMessage } from '../../../core/src/messages.js';
import { reconnectDelayMs } from './reconnectBackoff.js';
import type { MessageTransport, TransportState } from './types.js';

function isServerMessage(data: unknown): data is ServerMessage {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

export class SseTransport implements MessageTransport {
  private es: EventSource | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  /** Messages that arrived before the first handler subscribed. */
  private backlog: ServerMessage[] = [];
  private everConnected = false;
  private retryAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private readonly _ready: Promise<void>;
  private resolveReady!: () => void;
  private readonly onWindowMessage = (e: MessageEvent) => {
    // Same-window dispatches carry no origin; refuse anything posted cross-origin.
    if (e.origin && e.origin !== window.location.origin) return;
    if (isServerMessage(e.data)) this.deliver(e.data);
  };

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
    this._ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    window.addEventListener('message', this.onWindowMessage);
  }

  get state(): TransportState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  /** Open the stream. Called by App once assets and layout are in, so the
   *  server's snapshot never lands before the office exists. Idempotent. */
  connect(): void {
    if (this.disposed || this.es) return;
    this.setState(this.everConnected ? TRANSPORT_STATE_RECONNECTING : TRANSPORT_STATE_CONNECTING);
    const es = new EventSource(this.url);
    this.es = es;

    es.onopen = () => {
      this.retryAttempts = 0;
      this.everConnected = true;
      // A reconnect goes connected again: onReconnect() then flags the next
      // existingAgents as the whole truth (stale agents close, tools reset).
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
    };

    es.onmessage = (e: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (isServerMessage(msg)) this.deliver(msg);
    };

    es.onerror = () => {
      if (this.disposed) return;
      if (es.readyState === EventSource.CONNECTING) {
        // Built-in retry is under way.
        this.setState(TRANSPORT_STATE_RECONNECTING);
        return;
      }
      // CLOSED: the browser gave up (HTTP error, wrong content type). Retry ourselves.
      es.close();
      this.es = null;
      this.setState(TRANSPORT_STATE_RECONNECTING);
      const delay = reconnectDelayMs(this.retryAttempts++);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    };
  }

  send(): void {
    // Read-only wallpaper: drop every client message.
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    if (this.backlog.length > 0) {
      const queued = this.backlog;
      this.backlog = [];
      for (const msg of queued) handler(msg);
    }
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Hand a message to every handler, as if it came over the stream. */
  deliver(message: ServerMessage): void {
    if (this.handlers.length === 0) {
      this.backlog.push(message);
      return;
    }
    for (const handler of this.handlers) handler(message);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.es?.close();
    this.es = null;
    window.removeEventListener('message', this.onWindowMessage);
    this.handlers = [];
    this.backlog = [];
    this.setState(TRANSPORT_STATE_DISCONNECTED);
    this.stateHandlers = [];
  }
}
