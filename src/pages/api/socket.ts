import type { NextApiRequest, NextApiResponse } from 'next';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getToken } from 'next-auth/jwt';
import { prisma } from '@/lib/prisma';

type WebSocketWithMeta = WebSocket & {
  room?: string;
  userId?: string;
  label?: string;
};

type ExtendedServer = NextApiResponse['socket']['server'] & { wss?: WebSocketServer };

const rooms = new Map<string, Set<WebSocketWithMeta>>();

export const config = {
  api: {
    bodyParser: false,
  },
};

async function validateRoomAccess(req: NextApiRequest | IncomingMessage) {
  const url = req.url ? new URL(req.url, 'http://localhost') : null;
  const roomName = url?.searchParams.get('room') || '';

  if (!roomName) {
    return { allowed: false as const, reason: 'Room not provided' };
  }

  if (!roomName.startsWith('private-chat-')) {
    return { allowed: false as const, reason: 'Invalid room' };
  }

  const token = await getToken({ req: req as unknown as NextApiRequest, secret: process.env.NEXTAUTH_SECRET });
  const userId = (token?.id as string | undefined) || undefined;
  const role = (token?.role as string | undefined) || undefined;
  const label = (token?.name as string | undefined) || (token?.email as string | undefined) || userId;

  if (!userId) {
    return { allowed: false as const, reason: 'Unauthorized user' };
  }

  const parts = roomName.split('-');
  const counsellorId = parts[2];
  const patientId = parts[3];

  if (!counsellorId || !patientId) {
    return { allowed: false as const, reason: 'Invalid room' };
  }

  if (userId !== counsellorId && userId !== patientId) {
    return { allowed: false as const, reason: 'User not in room' };
  }

  // Enforce that the patient can only talk to their assigned counsellor
  const assignment = await prisma.assignment.findFirst({
    where: { counsellorId, patientId, isActive: true },
    select: { id: true },
  });

  if (!assignment) {
    return { allowed: false as const, reason: 'No active assignment' };
  }

  if (role === 'USER' && userId !== patientId) {
    return { allowed: false as const, reason: 'Patients may only join their own room' };
  }

  if (role === 'COUNSELLOR' && userId !== counsellorId) {
    return { allowed: false as const, reason: 'Counsellors may only join their own room' };
  }

  return { allowed: true as const, roomName, userId, label };
}

function broadcast(roomName: string, data: Record<string, unknown>) {
  const clients = rooms.get(roomName);
  if (!clients) return;

  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const server = res.socket.server as ExtendedServer;

  if (!server.wss) {
    const wss = new WebSocketServer({ server });
    server.wss = wss;

    wss.on('connection', (ws, connectionReq) => {
      void (async () => {
        const validation = await validateRoomAccess(connectionReq);

        if (!validation.allowed || !validation.roomName || !validation.userId) {
          ws.close(1008, validation.reason || 'Forbidden');
          return;
        }

        const withMeta = ws as WebSocketWithMeta;
        withMeta.room = validation.roomName;
        withMeta.userId = validation.userId;
        withMeta.label = validation.label;

        const existing = rooms.get(validation.roomName) || new Set<WebSocketWithMeta>();
        existing.add(withMeta);
        rooms.set(validation.roomName, existing);

        ws.on('message', async (message) => {
          try {
            const parsed = (() => {
              try {
                return JSON.parse(message.toString());
              } catch {
                return { text: message.toString() };
              }
            })();

            const text = (parsed.text || parsed.message) as string | undefined;
            if (!text || typeof text !== 'string') return;

            broadcast(validation.roomName, {
              text,
              ts: Date.now(),
              sender: validation.label,
              senderId: validation.userId,
            });
          } catch {
            // Ignore malformed payloads
          }
        });

        ws.on('close', () => {
          const set = rooms.get(validation.roomName);
          if (!set) return;
          set.delete(withMeta);
          if (set.size === 0) rooms.delete(validation.roomName);
        });
      })();
    });
  }

  res.end();
}
