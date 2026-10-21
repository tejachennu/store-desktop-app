import { Router } from 'express';
import { z } from 'zod';
import { loginSchema, passwordSchema, permissionsFor, type LoginResponse } from '@store/shared';
import type { AppContext } from '../context.js';
import { one } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { badRequest, unauthorized } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { getUser } from '../services/rows.js';
import { parse } from './util.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function authRoutes(ctx: AppContext): Router {
  const r = Router();

  r.post(
    '/login',
    rateLimit({ windowMs: 60_000, max: 20, key: (req) => String(req.body?.username ?? '') }),
    async (req, res) => {
      const { username, password } = parse(loginSchema, req.body);
      const row = await one<{ id: string; passwordHash: string; isActive: boolean; tokenVersion: number; failedLogins: number; lockedUntil: Date | null }>(
        ctx.db,
        `SELECT id, password_hash AS "passwordHash", is_active AS "isActive", token_version AS "tokenVersion",
                failed_logins AS "failedLogins", locked_until AS "lockedUntil"
           FROM users WHERE username = $1`,
        [username],
      );
      const fail = () => unauthorized('Invalid username or password');
      if (!row) {
        // Spend comparable time to avoid user enumeration by timing.
        await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
        throw fail();
      }
      if (row.lockedUntil && row.lockedUntil > new Date()) {
        throw unauthorized(`Account locked after repeated failed attempts. Try again after ${row.lockedUntil.toISOString()}`);
      }
      const ok = await verifyPassword(password, row.passwordHash);
      if (!ok || !row.isActive) {
        const failed = row.failedLogins + 1;
        const lock = failed >= MAX_FAILED;
        await ctx.db.query(
          `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE NULL END WHERE id = $1`,
          [row.id, lock ? 0 : failed, lock, LOCK_MINUTES],
        );
        await audit(ctx.db, { userId: row.id, action: 'auth.login_failed', entityType: 'user', entityId: row.id, ip: req.ip });
        throw fail();
      }
      await ctx.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [row.id]);
      const user = (await getUser(ctx.db, row.id))!;
      const { token, expiresAt } = await ctx.tokens.issue(row.id, row.tokenVersion);
      await audit(ctx.db, { userId: row.id, action: 'auth.login', entityType: 'user', entityId: row.id, ip: req.ip });
      const body: LoginResponse = {
        accessToken: token,
        expiresAt: expiresAt.toISOString(),
        user: { ...user, permissions: permissionsFor(user.role) },
      };
      res.json(body);
    },
  );

  r.get('/me', requireUser(ctx), async (req, res) => {
    const user = (await getUser(ctx.db, req.user!.id))!;
    res.json({ ...user, permissions: permissionsFor(user.role) });
  });

  r.post('/change-password', requireUser(ctx), rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
    const row = await one<{ passwordHash: string }>(ctx.db, 'SELECT password_hash AS "passwordHash" FROM users WHERE id = $1', [req.user!.id]);
    if (!row || !(await verifyPassword(body.currentPassword, row.passwordHash))) throw badRequest('Current password is incorrect');
    if (body.currentPassword === body.newPassword) throw badRequest('New password must be different');
    const updated = await one<{ tokenVersion: number }>(
      ctx.db,
      `UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING token_version AS "tokenVersion"`,
      [req.user!.id, await hashPassword(body.newPassword)],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'auth.password_changed', entityType: 'user', entityId: req.user!.id, ip: req.ip });
    const { token, expiresAt } = await ctx.tokens.issue(req.user!.id, updated!.tokenVersion);
    res.json({ accessToken: token, expiresAt: expiresAt.toISOString() });
  });

  return r;
}
