import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { unauthorized } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

export const notificationRouter = Router();

/**
 * Notifications belong to a user, not a role, so this router has no
 * requireRole - only the global requireAuth in front of the whole API. Every
 * query is scoped by the session's own userId, which is layer 3 in its
 * simplest form.
 */
function me(req: { session: { userId?: string } }): string {
  const userId = req.session.userId;
  if (!userId) throw unauthorized();
  return userId;
}

/** GET /api/notifications?unread=true */
notificationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const { unread } = z
      .object({ unread: z.enum(['true', 'false']).optional() })
      .parse(req.query);

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId, ...(unread === 'true' ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    res.json({ notifications, unreadCount });
  }),
);

/** POST /api/notifications/read — one, several, or everything */
notificationRouter.post(
  '/read',
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body);

    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });

    res.json({ read: result.count });
  }),
);
