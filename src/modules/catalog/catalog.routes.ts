import { Router } from 'express';
import { z } from 'zod';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import { getActiveServices, getBusinessBySlug, toPublicBusiness } from './catalog.service.js';

const SlugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{3,60}$/, 'Invalid business slug') });

export const catalogRouter = Router();

/** Public: branding + opening hours for the sign-in screen. */
catalogRouter.get('/businesses/:slug', validate({ params: SlugParams }), async (req, res) => {
  const { slug } = input<typeof SlugParams>(req, 'params');
  res.json({ business: toPublicBusiness(await getBusinessBySlug(slug)) });
});

/** Bookable services for the caller's business. */
catalogRouter.get('/services', requireAuth, async (req, res) => {
  const { businessId } = getAuth(req);
  res.json({ services: await getActiveServices(businessId) });
});
