import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';

/**
 * E2E Encrypted Chat Relay for Mugen Exchange trades.
 *
 * The relay only forwards encrypted messages between trade participants.
 * It never stores messages or has access to plaintext.
 *
 * Protocol:
 * 1. Client connects to /ws/chat?trade=<escrow_address>
 * 2. Client sends: { type: 'message', ciphertext: string, nonce: string }
 * 3. Relay broadcasts to all other connections in the same trade room
 * 4. Client decrypts using shared X25519 secret (derived off-relay)
 */

interface ChatRoom {
  clients: Set<WebSocket>;
}

export class ChatRelay {
  private wss: WebSocketServer | null = null;
  private rooms: Map<string, ChatRoom> = new Map();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws/chat' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const tradeId = url.searchParams.get('trade');

      if (!tradeId) {
        ws.close(4001, 'Missing trade parameter');
        return;
      }

      // Join room
      if (!this.rooms.has(tradeId)) {
        this.rooms.set(tradeId, { clients: new Set() });
      }
      const room = this.rooms.get(tradeId)!;
      room.clients.add(ws);

      console.log(`[chat] Client joined trade ${tradeId} (${room.clients.size} participants)`);

      ws.on('message', (data: Buffer) => {
        // Forward to all other participants in the room
        const message = data.toString();

        // Basic sanity: must be valid JSON with ciphertext
        try {
          const parsed = JSON.parse(message);
          if (!parsed.ciphertext) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing ciphertext' }));
            return;
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        for (const client of room.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      });

      ws.on('close', () => {
        room.clients.delete(ws);
        if (room.clients.size === 0) {
          this.rooms.delete(tradeId);
        }
        console.log(`[chat] Client left trade ${tradeId} (${room.clients.size} remaining)`);
      });

      ws.on('error', (err) => {
        console.error(`[chat] WebSocket error in trade ${tradeId}:`, err.message);
        room.clients.delete(ws);
      });

      // Welcome message
      ws.send(
        JSON.stringify({
          type: 'system',
          message: 'Connected to encrypted chat relay',
          trade: tradeId,
          participants: room.clients.size,
        }),
      );
    });

    console.log('[chat] WebSocket relay attached to server');
  }

  getStats(): { activeRooms: number; totalConnections: number } {
    let totalConnections = 0;
    for (const room of this.rooms.values()) {
      totalConnections += room.clients.size;
    }
    return {
      activeRooms: this.rooms.size,
      totalConnections,
    };
  }

  close(): void {
    this.wss?.close();
  }
}
