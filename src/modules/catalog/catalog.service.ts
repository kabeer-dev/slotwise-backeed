import { AppError } from '../../lib/errors.js';
import * as repo from './catalog.repository.js';
import type { Business, Service } from './catalog.types.js';

/**
 * Business settings and the service list are read on every chat turn but
 * change rarely, so they get a short in-process cache.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; expires: number }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function clearCatalogCache() {
  cache.clear();
}

export async function getBusiness(businessId: string): Promise<Business> {
  const business = await cached(`business:${businessId}`, () => repo.findBusinessById(businessId));
  if (!business) throw AppError.notFound('Business');
  return business;
}

export async function getBusinessBySlug(slug: string): Promise<Business> {
  const business = await cached(`business-slug:${slug}`, () => repo.findBusinessBySlug(slug));
  if (!business) throw AppError.notFound('Business');
  return business;
}

export async function getActiveServices(businessId: string): Promise<Service[]> {
  return cached(`services:${businessId}`, () => repo.listServices(businessId));
}

/** Active service that belongs to the tenant, or a 422 the client can act on. */
export async function getBookableService(businessId: string, serviceId: string): Promise<Service> {
  const service = await repo.findServiceById(businessId, serviceId);
  if (!service) throw AppError.unprocessable('SERVICE_NOT_FOUND', 'That service does not exist');
  if (!service.isActive) throw AppError.unprocessable('SERVICE_UNAVAILABLE', `${service.name} is not available for booking right now`);
  return service;
}

/** Public, non-sensitive view of a business (used by the login page). */
export function toPublicBusiness(b: Business) {
  return {
    slug: b.slug,
    name: b.name,
    timezone: b.timezone,
    opensAt: b.opensAt,
    closesAt: b.closesAt,
    workingDays: b.workingDays,
    slotIntervalMinutes: b.slotIntervalMinutes,
    bookingHorizonDays: b.bookingHorizonDays,
  };
}
