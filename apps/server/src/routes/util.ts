import type { Request } from 'express';
import { z, type ZodType } from 'zod';
import { canAccessLocation, hasPermission } from '@store/shared';
import { forbidden, unauthorized } from '../middleware/errors.js';

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export const uuidParam = z.object({ id: z.uuid() });

export const dateRangeQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  locationId: z.uuid().optional(),
});

export function defaultRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const today = new Date();
  const to = q.to ?? today.toISOString().slice(0, 10);
  const from = q.from ?? new Date(today.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Resolve which locations a read query covers.
 * - explicit locationId: must be accessible
 * - otherwise: all locations for users with company-wide access, else the user's own
 * Returns null for "all locations".
 */
export function locationFilter(req: Request, locationId?: string | null): string[] | null {
  const user = req.user;
  if (!user) throw unauthorized();
  if (locationId) {
    if (!canAccessLocation(user, locationId)) throw forbidden('You do not have access to this location');
    return [locationId];
  }
  if (user.allLocations && hasPermission(user, 'reports.consolidated')) return null;
  if (user.allLocations) return null;
  return user.locationIds;
}

/** Appends `AND <col> = ANY($n)` when a location filter applies. */
export function locClause(col: string, filter: string[] | null, params: unknown[]): string {
  if (filter === null) return '';
  params.push(filter);
  return ` AND ${col} = ANY($${params.length}::uuid[])`;
}
