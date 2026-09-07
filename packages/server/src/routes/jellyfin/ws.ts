import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@aiostreams/core';
import { readToken, verifyCredentials } from './context.js';

const logger = createLogger('jellyfin');

const MAX_SOCKETS_PER_USER = 16;
const MAX_SOCKETS_TOTAL = 50_000;

const SOCKET_PATH =
  /^\/jellyfin(?:\/([^/?]+)\/([^/?]+))?(?:\/emby)?\/socket(?:\?|$)/i;

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function authenticateUpgrade(url: string): Promise<string | null> {
  const m = SOCKET_PATH.exec(url);
  if (!m) return null;
  const query = new URLSearchParams(url.split('?')[1] ?? '');
  const apiKey = query.get('api_key') ?? query.get('ApiKey') ?? '';
  if (apiKey) {
    const payload = readToken(apiKey);
    if (payload) return verifyCredentials(payload.u, payload.p);
  }
  if (m[1] && m[2]) {
    return verifyCredentials(decodeURIComponent(m[1]), m[2]);
  }
  return null;
}

export function attachJellyfinWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const perUser = new Map<string, number>();

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, uuid: string) => {
    perUser.set(uuid, (perUser.get(uuid) ?? 0) + 1);
    const send = (MessageType: string, Data: unknown = null) => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ MessageType, Data }));
    };
    send('ForceKeepAlive', 60);
    const timer = setInterval(() => send('KeepAlive'), 30_000);
    const release = () => {
      clearInterval(timer);
      const n = (perUser.get(uuid) ?? 1) - 1;
      if (n <= 0) perUser.delete(uuid);
      else perUser.set(uuid, n);
    };
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { MessageType?: string };
        if (msg.MessageType === 'KeepAlive') send('KeepAlive');
      } catch {}
    });
    ws.on('close', release);
    ws.on('error', release);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (!SOCKET_PATH.test(url)) return;
    void authenticateUpgrade(url)
      .then((uuid) => {
        if (socket.destroyed) return;
        if (!uuid) {
          reject(socket, 401, 'Unauthorized');
          return;
        }
        if ((perUser.get(uuid) ?? 0) >= MAX_SOCKETS_PER_USER) {
          reject(socket, 429, 'Too Many Requests');
          return;
        }
        if (wss.clients.size >= MAX_SOCKETS_TOTAL) {
          reject(socket, 503, 'Service Unavailable');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, uuid);
        });
      })
      .catch((error) => {
        logger.debug(
          { err: error instanceof Error ? error.message : String(error) },
          'websocket upgrade auth failed'
        );
        if (!socket.destroyed) reject(socket, 500, 'Internal Server Error');
      });
  });
  logger.debug('jellyfin websocket attached');
}
