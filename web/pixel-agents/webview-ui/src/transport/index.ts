import { isBrowserRuntime } from '../runtime.js';
import { PostMessageTransport } from './postMessageTransport.js';
// quiet-office: the browser runtime reads the wallpaper server's SSE stream
// (read-only) instead of the upstream WebSocket. The SSE transport also takes
// same-window `message` events: browserMock's asset dispatch and ?demo=1.
import { SseTransport } from './sseTransport.js';
import type { MessageTransport } from './types.js';

/** quiet-office: the browser-runtime transport, for App to connect() and the demo to deliver(). */
export const sseTransport: SseTransport | null = isBrowserRuntime ? new SseTransport('/events') : null;

function createTransport(): MessageTransport {
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  return sseTransport!;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
