// ─────────────────────────────────────────────────────────────────────────────
// Restaurant Routes — Restaurant profile, staff lookup, and outlets overview
// ─────────────────────────────────────────────────────────────────────────────
// Manages restaurant (outlet) profile settings, staff lookups for login,
// and multi-outlet organization overview.
//
// Endpoints:
//   GET   /api/restaurant/by-code/:code     — lookup restaurant by join code (for staff login)
//   GET   /api/restaurant/:slug/staff       — list captains/cashiers by slug or code
//   GET   /api/restaurant/me                — current restaurant profile + tables (for QR generation)
//   PATCH /api/restaurant/profile           — update restaurant settings (OWNER/ADMIN only)
//   GET   /api/restaurant/outlets-overview   — all outlets in the organization with summary stats
//   POST  /api/restaurant/add-outlet         — create a new outlet under the existing organization (OWNER only)
//
// Profile updates invalidate the tenant context cache for all sibling outlets
// since GST settings are inherited across the organization.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from "../lib/logger";
import prisma, { basePrisma } from '../lib/prisma';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth';
import { withTenantContext } from '../middleware/tenantContext';
import { invalidateTenantContextCache, validateSharedKitchenOutlet } from '../lib/tenantContext';
import { computeEnabledModules } from '../lib/moduleDefaults';
import { checkVerificationProof } from '../lib/verificationToken';
import { emitConfigChange } from '../lib/edgeEmit';
import { getIo } from '../socket';

const router = Router();

// GET /api/restaurant/by-code/:code — lookup restaurant by restaurantCode.
// Used during staff login to resolve the restaurant from the join code entered by the user.
// Returns minimal info (id, name, slug, restaurantCode) — no auth required.
router.get('/by-code/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const restaurant = await prisma.outlet.findUnique({ where: { restaurantCode: code } });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    return res.json({
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      restaurantCode: restaurant.restaurantCode,
    });
  } catch (error) {
    logger.error({ err: error }, '[Restaurant By Code] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/:slug/staff — list captains/cashiers for a restaurant by slug or restaurantCode
router.get('/:slug/staff', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const rawRole = req.query.role;
    const role = typeof rawRole === 'string' ? rawRole : undefined;

    if (!role || (role !== 'CAPTAIN' && role !== 'CASHIER')) {
      return res.status(400).json({ error: 'role query param must be CAPTAIN or CASHIER' });
    }

    // Resolve by slug or restaurantCode
    const restaurant = await prisma.outlet.findFirst({
      where: {
        OR: [
          { slug },
          { restaurantCode: slug.toUpperCase() },
        ]
      }
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const users = await prisma.user.findMany({
      where: {
        outletId: restaurant.id,
        role: role as 'CAPTAIN' | 'CASHIER',
        isActive: true
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });

    return res.json({ restaurantId: restaurant.id, staff: users });
  } catch (error) {
    logger.error({ err: error }, '[Staff Lookup] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/me — current restaurant + tables (for QR code generation)
router.get('/me', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        slug: true,
        restaurantCode: true,
        address: true,
        phone: true,
        email: true,
        gstin: true,
        isActive: true,
        logoUrl: true,
        receiptHeader: true,
        receiptSubHeader: true,
        themePrimary: true,
        themeSecondary: true,
        printerConfig: true,
        barUnitMl: true,
        fullBottleMl: true,
        halfBottleMl: true,
        restaurantType: true,
        outletCount: true,
        fssai: true,
        gstRegistered: true,
        gstCategory: true,
        gstRate: true,
        pricesIncludeGst: true,
        serviceChargePercent: true,
        enabledModules: true,
        organizationId: true,
      }
    });

    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Fallback: if outlet has no enabledModules, inherit from organization
    let restaurantWithModules = restaurant as any;
    if (!restaurantWithModules.enabledModules) {
      const org = await prisma.organization.findUnique({
        where: { id: restaurant.organizationId },
        select: { enabledModules: true },
      });
      restaurantWithModules = { ...restaurantWithModules, enabledModules: org?.enabledModules ?? null };
    }

    const tables = await prisma.table.findMany({
      where: { restaurantId },
      select: { id: true, number: true, sectionId: true },
      orderBy: [{ sectionId: 'asc' }, { number: 'asc' }]
    });

    return res.json({ restaurant: restaurantWithModules, tables });
  } catch (error) {
    logger.error({ err: error }, '[Restaurant Me] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/restaurant/profile — update restaurant settings (OWNER / ADMIN only)
router.patch('/profile', authenticate as any, withTenantContext as any, requireRole('OWNER', 'ADMIN') as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const {
      name, address, phone, email, gstin,
      receiptHeader, receiptSubHeader,
      themePrimary, themeSecondary,
      logoUrl, printerConfig,
      barUnitMl, fullBottleMl, halfBottleMl,
      fssai, gstRegistered, gstCategory, gstRate,
      pricesIncludeGst, serviceChargePercent,
      phoneVerificationProof, emailVerificationProof, sessionId,
      sharedKitchenOutletId,
      managerTabs
    } = req.body;

    // ── OTP verification for phone/email changes ──────────────────────────
    // If the user is changing their phone or email, require a valid verification
    // proof (JWT signed by the verification endpoints). This prevents unauthorized
    // contact info changes without OTP verification.
    if (phone !== undefined || email !== undefined) {
      const current = await prisma.outlet.findUnique({ where: { id: restaurantId }, select: { phone: true, email: true } });
      if (!current) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      const normalizePhone = (raw: string) => {
        const digits = (raw || '').replace(/\D/g, '');
        if (digits.length === 10) return '+91' + digits;
        if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
        return (raw || '').trim();
      };

      if (phone !== undefined && String(phone || '').trim()) {
        const newPhoneNorm = normalizePhone(String(phone));
        const curPhoneNorm = normalizePhone(current.phone || '');
        if (newPhoneNorm !== curPhoneNorm) {
          if (!phoneVerificationProof || !sessionId) {
            return res.status(400).json({ error: 'Phone verification required to change phone number' });
          }
          const phoneOk = checkVerificationProof(phoneVerificationProof, 'phone', newPhoneNorm, sessionId);
          if (!phoneOk) {
            return res.status(400).json({ error: 'Phone verification invalid or expired — please re-verify' });
          }
        }
      }

      if (email !== undefined && String(email || '').trim()) {
        const newEmail = (String(email) || '').trim().toLowerCase();
        const curEmail = (current.email || '').trim().toLowerCase();
        if (newEmail !== curEmail) {
          if (!emailVerificationProof || !sessionId) {
            return res.status(400).json({ error: 'Email verification required to change email address' });
          }
          const emailOk = checkVerificationProof(emailVerificationProof, 'email', newEmail, sessionId);
          if (!emailOk) {
            return res.status(400).json({ error: 'Email verification invalid or expired — please re-verify' });
          }
        }
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (address !== undefined) updateData.address = String(address).trim() || null;
    if (phone !== undefined) updateData.phone = String(phone).trim() || null;
    if (email !== undefined) updateData.email = String(email).trim() || null;
    if (gstin !== undefined) updateData.gstin = String(gstin).trim().toUpperCase() || null;
    if (receiptHeader !== undefined) updateData.receiptHeader = String(receiptHeader).trim() || null;
    if (receiptSubHeader !== undefined) updateData.receiptSubHeader = String(receiptSubHeader).trim() || null;
    if (themePrimary !== undefined) updateData.themePrimary = String(themePrimary).trim() || null;
    if (themeSecondary !== undefined) updateData.themeSecondary = String(themeSecondary).trim() || null;
    if (logoUrl !== undefined) updateData.logoUrl = String(logoUrl).trim() || null;
    if (printerConfig !== undefined) updateData.printerConfig = printerConfig;
    if (barUnitMl !== undefined) {
      const num = Number(barUnitMl);
      if (!Number.isNaN(num) && num > 0) updateData.barUnitMl = num;
    }
    if (fullBottleMl !== undefined) {
      const num = Number(fullBottleMl);
      if (!Number.isNaN(num) && num > 0) updateData.fullBottleMl = num;
    }
    if (halfBottleMl !== undefined) {
      const num = Number(halfBottleMl);
      if (!Number.isNaN(num) && num > 0) updateData.halfBottleMl = num;
    }
    if (fssai !== undefined) updateData.fssai = String(fssai).trim() || null;
    if (gstRegistered !== undefined) updateData.gstRegistered = Boolean(gstRegistered);
    if (gstCategory !== undefined) {
      const validCategories = ['NON_AC', 'AC', 'TAKEAWAY'];
      const cat = String(gstCategory).trim().toUpperCase();
      if (validCategories.includes(cat)) updateData.gstCategory = cat;
    }
    if (gstRate !== undefined) {
      if (gstRate === null) {
        updateData.gstRate = null;
      } else {
        const num = Number(gstRate);
        if (!Number.isNaN(num) && num >= 0 && num <= 100) updateData.gstRate = num;
      }
    }
    if (pricesIncludeGst !== undefined) updateData.pricesIncludeGst = Boolean(pricesIncludeGst);
    if (serviceChargePercent !== undefined) {
      const num = Number(serviceChargePercent);
      if (!Number.isNaN(num) && num >= 0 && num <= 20) updateData.serviceChargePercent = num;
    }

    // Validate and set sharedKitchenOutletId
    if (sharedKitchenOutletId !== undefined) {
      if (sharedKitchenOutletId) {
        const validation = await validateSharedKitchenOutlet(restaurantId, sharedKitchenOutletId);
        if (!validation.valid) {
          return res.status(400).json({ error: validation.error });
        }
      }
      updateData.sharedKitchenOutletId = sharedKitchenOutletId || null;
    }

    // Save manager tab visibility config into enabledModules.managerTabs
    if (managerTabs !== undefined && typeof managerTabs === 'object') {
      const currentOutlet = await prisma.outlet.findUnique({
        where: { id: restaurantId },
        select: { enabledModules: true },
      });
      const currentModules = (currentOutlet?.enabledModules as Record<string, any>) || {};
      updateData.enabledModules = { ...currentModules, managerTabs };
    }

    const updated = await prisma.outlet.update({
      where: { id: restaurantId },
      data: updateData
    });

    // Invalidate tenant context cache so GST/settings changes propagate immediately
    await invalidateTenantContextCache(restaurantId);
    // Also invalidate cache for all other outlets in the same organization
    const siblingOutlets = await prisma.outlet.findMany({
      where: { organizationId: updated.organizationId, id: { not: restaurantId } },
      select: { id: true },
    });
    await Promise.all(siblingOutlets.map(o => invalidateTenantContextCache(o.id)));

    // Notify connected edge servers so they update local SQLite (printer config, GST, etc.)
    emitConfigChange(restaurantId, 'outlet', 'upsert', updated);

    // If printerConfig was updated, notify all connected captain/cashier clients so they sync
    if (printerConfig !== undefined) {
      try {
        const io = getIo();
        const config = (updated as any).printerConfig || {};
        const printerMapping = config.agentMapping || {};
        io.to(restaurantId).emit('printer:config-updated', { printerMapping, printerConfig: config });
        logger.info(`[Restaurant Profile] Emitted printer:config-updated to room ${restaurantId}`);
      } catch {
        // Socket not initialized — silent fail
      }
    }

    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[Restaurant Profile] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/outlets-overview — all outlets in the organization
router.get('/outlets-overview', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const currentOutlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    if (!currentOutlet) {
      return res.status(404).json({ error: 'Outlet not found' });
    }

    const outlets = await prisma.outlet.findMany({
      where: { organizationId: currentOutlet.organizationId },
      include: {
        venues: {
          where: { isDeleted: false },
          include: {
            sections: { include: { _count: { select: { tables: true } } } },
            floors: { include: { sections: { include: { _count: { select: { tables: true } } } } } }
          }
        },
        sections: { where: { venueId: null }, include: { _count: { select: { tables: true } } } },
        _count: { select: { users: true } },
        organization: { select: { plan: true, name: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    const summary = outlets.map(o => {
      const venueSections = [
        ...o.venues.flatMap(v => v.sections),
        ...o.venues.flatMap(v => v.floors.flatMap(f => f.sections))
      ];
      const legacySections = (o.sections ?? []).map(s => ({ ...s, _count: { tables: s._count.tables } }));
      const allSections = [...venueSections, ...legacySections];
      const totalTables = allSections.reduce((sum, s) => sum + s._count.tables, 0);
      const totalVenueCount = o.venues.length + (legacySections.length > 0 && o.venues.length === 0 ? 1 : 0);
      return {
        id: o.id,
        name: o.name,
        restaurantCode: o.restaurantCode,
        restaurantType: o.restaurantType,
        slug: o.slug,
        isActive: o.isActive,
        onboardingCompletedAt: o.onboardingCompletedAt,
        createdAt: o.createdAt,
        venueCount: totalVenueCount,
        venues: o.venues.map(v => ({ name: v.name, venueType: v.venueType })),
        totalSections: allSections.length,
        totalTables,
        staffCount: o._count.users,
        plan: o.organization?.plan ?? null,
        organizationName: o.organization?.name ?? null
      };
    });

    return res.json({ organizationId: currentOutlet.organizationId, outlets: summary });
  } catch (error) {
    logger.error({ err: error }, '[Outlets Overview] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/restaurant/add-outlet — create a new outlet under the existing organization
// Body: { name, restaurantType, address, phone, email, copyFromOutletId? }
// If copyFromOutletId is provided, clones menu, venues, floors, sections, tables,
// tax profiles, and price profiles from the source outlet.
router.post('/add-outlet', authenticate as any, requireRole('OWNER') as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const currentOutlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
    });
    if (!currentOutlet) {
      return res.status(404).json({ error: 'Outlet not found' });
    }

    const { name, restaurantType, address, phone, email, copyFromOutletId } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Outlet name is required (min 2 characters)' });
    }

    const validTypes = ['DINE_IN', 'BAR_LOUNGE', 'BAR_WITH_DINING', 'CAFE', 'CLOUD_KITCHEN'];
    const type = validTypes.includes(restaurantType) ? restaurantType : 'DINE_IN';

    // If copyFromOutletId is provided, verify it belongs to the same organization
    let sourceOutlet: any = null;
    if (copyFromOutletId) {
      sourceOutlet = await basePrisma.outlet.findUnique({
        where: { id: copyFromOutletId },
        select: { id: true, organizationId: true, name: true },
      });
      if (!sourceOutlet) {
        return res.status(404).json({ error: 'Source outlet not found' });
      }
      if (sourceOutlet.organizationId !== currentOutlet.organizationId) {
        return res.status(403).json({ error: 'Cannot copy from an outlet in a different organization' });
      }
    }

    // Generate unique slug
    const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    let slug = base;
    let slugAttempts = 0;
    while (await basePrisma.outlet.findUnique({ where: { slug } })) {
      const suffix = crypto.randomBytes(2).toString('hex').slice(0, 3);
      slug = `${base}${suffix}`;
      slugAttempts++;
      if (slugAttempts > 20) {
        slug = `${base}${Date.now()}`;
        break;
      }
    }

    // Generate unique restaurantCode
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let restaurantCode = '';
    for (let i = 0; i < 100; i++) {
      const randomBytes = crypto.randomBytes(6);
      let code = '';
      for (let j = 0; j < 6; j++) {
        code += chars.charAt(randomBytes[j] % chars.length);
      }
      const existing = await basePrisma.outlet.findUnique({ where: { restaurantCode: code } });
      if (!existing) {
        restaurantCode = code;
        break;
      }
    }
    if (!restaurantCode) {
      return res.status(500).json({ error: 'Failed to allocate unique restaurant code' });
    }

    const enabledModules = computeEnabledModules({ restaurantType: type });

    // Create the new outlet, inheriting branding & tax config from parent
    const newOutlet = await basePrisma.outlet.create({
      data: {
        name: name.trim(),
        slug,
        restaurantCode,
        restaurantType: type,
        outletCount: 1,
        enabledModules,
        gstin: currentOutlet.gstin,
        phone: phone || currentOutlet.phone,
        email: email || currentOutlet.email,
        address: address || currentOutlet.address,
        pricesIncludeGst: currentOutlet.pricesIncludeGst,
        gstCategory: currentOutlet.gstCategory,
        gstRate: currentOutlet.gstRate,
        gstRegistered: currentOutlet.gstRegistered,
        serviceChargePercent: currentOutlet.serviceChargePercent,
        barUnitMl: currentOutlet.barUnitMl,
        fullBottleMl: currentOutlet.fullBottleMl,
        halfBottleMl: currentOutlet.halfBottleMl,
        receiptHeader: currentOutlet.receiptHeader,
        receiptSubHeader: currentOutlet.receiptSubHeader,
        themePrimary: currentOutlet.themePrimary,
        themeSecondary: currentOutlet.themeSecondary,
        logoUrl: currentOutlet.logoUrl,
        fssai: currentOutlet.fssai,
        organizationId: currentOutlet.organizationId,
        printerConfig: (currentOutlet as any).printerConfig || undefined,
        onboardingCompletedAt: new Date(),
      },
    });

    // Grant owner access to the new outlet
    await basePrisma.outletAccess.create({
      data: {
        userId: r.user!.userId,
        outletId: newOutlet.id,
        role: 'OWNER',
      },
    });

    // Grant access to all other active staff in the organization
    const orgStaff = await basePrisma.user.findMany({
      where: {
        isActive: true,
        id: { not: r.user!.userId },
        outlet: { organizationId: currentOutlet.organizationId },
      },
      select: { id: true, role: true },
    });
    for (const staff of orgStaff) {
      await basePrisma.outletAccess.create({
        data: {
          userId: staff.id,
          outletId: newOutlet.id,
          role: staff.role,
        },
      }).catch(() => { /* skip if already exists */ });
    }

    // Seed: DailyCounter for today
    const today = new Date().toISOString().slice(0, 10);
    await basePrisma.dailyCounter.create({
      data: { restaurantId: newOutlet.id, counterDate: today },
    });

    if (copyFromOutletId && sourceOutlet) {
      // ── Clone configuration from source outlet ──────────────────────────
      const newRid = newOutlet.id;
      const srcRid = sourceOutlet.id;

      // 1. Clone TaxProfiles
      const srcTaxProfiles = await basePrisma.taxProfile.findMany({ where: { restaurantId: srcRid } });
      const taxProfileMap = new Map<string, string>();
      for (const tp of srcTaxProfiles) {
        const newTp = await basePrisma.taxProfile.create({
          data: {
            restaurantId: newRid,
            name: tp.name,
            gstCategory: tp.gstCategory,
            gstRate: tp.gstRate,
            gstRegistered: tp.gstRegistered,
            serviceChargePercent: tp.serviceChargePercent,
            isDefault: tp.isDefault,
          },
        });
        taxProfileMap.set(tp.id, newTp.id);
      }

      // 2. Clone PriceProfiles
      const srcPriceProfiles = await basePrisma.priceProfile.findMany({ where: { restaurantId: srcRid } });
      const priceProfileMap = new Map<string, string>();
      for (const pp of srcPriceProfiles) {
        const newPp = await basePrisma.priceProfile.create({
          data: {
            restaurantId: newRid,
            name: pp.name,
            isDefault: pp.isDefault,
          },
        });
        priceProfileMap.set(pp.id, newPp.id);
      }

      // 3. Clone Categories + MenuItems + Variants + Addons
      const srcCategories = await basePrisma.category.findMany({
        where: { restaurantId: srcRid, isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          items: {
            where: { isDeleted: false },
            include: { variants: true, addons: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });

      const menuItemMap = new Map<string, string>();

      for (const cat of srcCategories) {
        const newCat = await basePrisma.category.create({
          data: {
            restaurantId: newRid,
            name: cat.name,
            printerTarget: cat.printerTarget,
            sortOrder: cat.sortOrder,
            isActive: cat.isActive,
          },
        });

        for (const item of cat.items) {
          const newItem = await basePrisma.menuItem.create({
            data: {
              restaurantId: newRid,
              categoryId: newCat.id,
              name: item.name,
              description: item.description,
              imageUrl: item.imageUrl,
              basePrice: item.basePrice,
              isVeg: item.isVeg,
              isAvailable: item.isAvailable,
              menuType: item.menuType,
              printerTarget: item.printerTarget,
              printerName: item.printerName,
              sortOrder: item.sortOrder,
              unit: item.unit,
            },
          });
          menuItemMap.set(item.id, newItem.id);

          for (const v of item.variants) {
            await basePrisma.menuItemVariant.create({
              data: {
                restaurantId: newRid,
                menuItemId: newItem.id,
                name: v.name,
                price: v.price,
                isDefault: v.isDefault,
                isAvailable: v.isAvailable,
              },
            });
          }

          for (const a of item.addons) {
            await basePrisma.menuItemAddon.create({
              data: {
                restaurantId: newRid,
                menuItemId: newItem.id,
                name: a.name,
                price: a.price,
                isAvailable: a.isAvailable,
              },
            });
          }
        }
      }

      // 4. Clone PriceProfileItems (now that we have new menuItem IDs)
      for (const [oldPpId, newPpId] of priceProfileMap) {
        const srcItems = await basePrisma.priceProfileItem.findMany({ where: { priceProfileId: oldPpId } });
        for (const ppi of srcItems) {
          const newMenuItemId = menuItemMap.get(ppi.menuItemId);
          if (!newMenuItemId) continue;
          await basePrisma.priceProfileItem.create({
            data: {
              restaurantId: newRid,
              priceProfileId: newPpId,
              menuItemId: newMenuItemId,
              price: ppi.price,
            },
          });
        }
      }

      // 5. Clone Venues + Floors + Sections + Tables
      const srcVenues = await basePrisma.venue.findMany({
        where: { restaurantId: srcRid, isDeleted: false },
        orderBy: { sortOrder: 'asc' },
        include: {
          floors: {
            orderBy: { sortOrder: 'asc' },
            include: {
              sections: {
                orderBy: { sortOrder: 'asc' },
                include: { tables: true },
              },
            },
          },
          sections: {
            orderBy: { sortOrder: 'asc' },
            include: { tables: true },
          },
        },
      });

      for (const venue of srcVenues) {
        const newVenue = await basePrisma.venue.create({
          data: {
            restaurantId: newRid,
            name: venue.name,
            venueType: venue.venueType,
            sortOrder: venue.sortOrder,
            isActive: venue.isActive,
            priceProfileId: venue.priceProfileId ? priceProfileMap.get(venue.priceProfileId) || null : null,
            taxProfileId: venue.taxProfileId ? taxProfileMap.get(venue.taxProfileId) || null : null,
            kotPrinterName: venue.kotPrinterName,
            billPrinterName: venue.billPrinterName,
          },
        });

        for (const floor of venue.floors) {
          const newFloor = await basePrisma.floor.create({
            data: {
              restaurantId: newRid,
              venueId: newVenue.id,
              name: floor.name,
              sortOrder: floor.sortOrder,
              isActive: floor.isActive,
            },
          });

          for (const section of floor.sections) {
            const newSection = await basePrisma.section.create({
              data: {
                restaurantId: newRid,
                venueId: newVenue.id,
                floorId: newFloor.id,
                name: section.name,
                sortOrder: section.sortOrder,
              },
            });

            for (const table of section.tables) {
              await basePrisma.table.create({
                data: {
                  restaurantId: newRid,
                  sectionId: newSection.id,
                  number: table.number,
                  capacity: table.capacity,
                },
              });
            }
          }
        }

        for (const section of venue.sections) {
          const newSection = await basePrisma.section.create({
            data: {
              restaurantId: newRid,
              venueId: newVenue.id,
              name: section.name,
              sortOrder: section.sortOrder,
            },
          });

          for (const table of section.tables) {
            await basePrisma.table.create({
              data: {
                restaurantId: newRid,
                sectionId: newSection.id,
                number: table.number,
                capacity: table.capacity,
              },
            });
          }
        }
      }

      // 6. Clone legacy sections (venueId = null) if no venues were cloned
      if (srcVenues.length === 0) {
        const srcLegacySections = await basePrisma.section.findMany({
          where: { restaurantId: srcRid, venueId: null },
          orderBy: { sortOrder: 'asc' },
          include: { tables: true },
        });
        for (const section of srcLegacySections) {
          const newSection = await basePrisma.section.create({
            data: {
              restaurantId: newRid,
              name: section.name,
              sortOrder: section.sortOrder,
            },
          });
          for (const table of section.tables) {
            await basePrisma.table.create({
              data: {
                restaurantId: newRid,
                sectionId: newSection.id,
                number: table.number,
                capacity: table.capacity,
              },
            });
          }
        }
      }

      logger.info({ newOutletId: newOutlet.id, copiedFrom: srcRid }, '[Add Outlet] Configuration cloned from source outlet');
    } else {
      // No copy — seed one default section so the outlet isn't empty
      await basePrisma.section.create({
        data: { name: 'Main Hall', restaurantId: newOutlet.id },
      });
    }

    // Invalidate tenant context cache
    await invalidateTenantContextCache(restaurantId);

    logger.info({ newOutletId: newOutlet.id, organizationId: newOutlet.organizationId }, '[Add Outlet] New outlet created');

    return res.status(201).json({
      id: newOutlet.id,
      name: newOutlet.name,
      slug: newOutlet.slug,
      restaurantCode: newOutlet.restaurantCode,
      restaurantType: newOutlet.restaurantType,
      organizationId: newOutlet.organizationId,
    });
  } catch (error) {
    logger.error({ err: error }, '[Add Outlet] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as restaurantRouter };
