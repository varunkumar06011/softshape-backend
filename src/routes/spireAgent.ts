// Spire AI Agent route — rule-based operational assistant for restaurant owners.
// Mounted with: authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext

import { Router } from 'express';
import { basePrisma } from '../lib/prisma';
import { cacheGet, cacheSet } from '../lib/cache';
import logger from '../lib/logger';
import resolveDateRange from '../services/spire/dateResolver';
import classifyIntent, { INTENT, type Intent, type IntentResult } from '../services/spire/intentEngine';
import { isBusinessQuestion } from '../services/spire/intentEngine';
import matchItem from '../services/spire/itemMatcher';
import { isTeluguText, classifyTeluguIntent } from '../services/spire/te-phrasebook';
import formatAnswer from '../services/spire/formatters';
import {
  getDailySalesData,
  getItemwiseSalesData,
  getDiscountReportData,
  getAttendanceSummary,
  getPurchaseSummary,
  getTopSellingItems,
  getFloorStatus,
  getPaymentBreakdown,
  getWastageSummary,
  getLowStockAlerts,
  getPeriodComparison,
  getAovData,
  getAovComparison,
  getOrdersCount,
  getRevenueData,
  getCategorySales,
  getOutletWisePerformance,
  getSpecialsSummary,
} from '../services/spire/fetchers';

const router = Router();

const CACHE_TTL_SECONDS = 5 * 60;

// Resolves the outlet IDs the requesting admin is authorized to access.
//
// Admin-level data isolation: each admin only receives data for outlets they
// have been granted via the OutletAccess table. OWNER/ADMIN roles are auto-
// granted access to every active outlet in their organization at login
// (see syncOutletAccess in auth.ts), so this returns the full org for them
// while restricting other roles to their explicitly assigned outlets.
//
// Falls back to the active outlet only if no access records exist (defensive).
async function getAuthorizedOutletIds(req: any): Promise<string[]> {
  const user = req.user;
  if (!user?.userId) return [];

  try {
    const access = await basePrisma.outletAccess.findMany({
      where: { userId: user.userId, outlet: { isActive: true } },
      select: { outletId: true },
    });
    if (access.length > 0) {
      return access.map(a => a.outletId);
    }
  } catch (err) {
    logger.warn({ err, userId: user.userId }, '[Spire] OutletAccess lookup failed, falling back to tenant context');
  }

  // Defensive fallback: active outlet only (never expose the whole org when
  // access records are missing — that would violate data isolation).
  const effectiveId = user.activeRestaurantId ?? user.restaurantId;
  if (!effectiveId) return [];
  return [effectiveId];
}

function computeCacheKey(userId: string, tenantIds: string[], intent: string, dateRange: any, itemName?: string): string {
  const rangeHash = `${dateRange.startDate}:${dateRange.endDate}`;
  // Include the sorted outlet IDs so two admins with different outlet access
  // never share a cache entry, even if their active outlet matches.
  const scopeHash = tenantIds.slice().sort().join(',');
  return `spire:${userId}:${intent}:${scopeHash}:${rangeHash}:${itemName || ''}`;
}

function detectLanguage(message: string): 'en' | 'te' {
  return isTeluguText(message) ? 'te' : 'en';
}

function classifyAnyIntent(message: string, language: 'en' | 'te'): IntentResult {
  if (language === 'te') {
    return classifyTeluguIntent(message);
  }
  return classifyIntent(message);
}

function getDateRangeText(language: 'en' | 'te', startDate: string, endDate: string): string {
  if (language === 'te') {
    if (startDate === endDate) return `${startDate} రోజు`;
    return `${startDate} నుండి ${endDate} వరకు`;
  }
  if (startDate === endDate) return `on ${startDate}`;
  return `from ${startDate} to ${endDate}`;
}

function computePreviousRange(dateRange: { startDate: string; endDate: string; startIST: Date; endIST: Date }) {
  const [sy, sm, sd] = dateRange.startDate.split('-').map(Number);
  const [ey, em, ed] = dateRange.endDate.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const spanMs = end.getTime() - start.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round(spanMs / dayMs) + 1;

  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * dayMs);

  const pad = (n: number) => n.toString().padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const prevStartDate = fmt(prevStart);
  const prevEndDate = fmt(prevEnd);
  const prevStartIST = new Date(Date.UTC(prevStart.getFullYear(), prevStart.getMonth(), prevStart.getDate(), 0, 0, 0, 0) - IST_OFFSET_MS);
  const prevEndIST = new Date(Date.UTC(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate(), 23, 59, 59, 999) - IST_OFFSET_MS);

  return { startDate: prevStartDate, endDate: prevEndDate, startIST: prevStartIST, endIST: prevEndIST };
}

function formatFallbackAnswer(language: 'en' | 'te'): string {
  if (language === 'te') {
    return "నాకు అర్థం కాలేదు. దయచేసి 'ఈరోజు అమ్మకాలు' లాంటి విధంగా ప్రయత్నించండి.";
  }
  return "I couldn't understand that. Try rephrasing, e.g. 'today sales' or 'this week chicken sales'.";
}

router.post('/ask', async (req: any, res) => {
  try {
    const { message, language: explicitLanguage } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const tenantIds = await getAuthorizedOutletIds(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = req.user.userId;
    const detectedLanguage = explicitLanguage === 'te' || explicitLanguage === 'en' ? explicitLanguage : detectLanguage(message);

    const classification = classifyAnyIntent(message, detectedLanguage);
    const intent = classification.intent;

    // Business-advice questions are outside the rule-based scope in Phase 1/2.
    if (intent !== INTENT.NEEDS_LLM && isBusinessQuestion(message)) {
      return res.json({
        answer: detectedLanguage === 'te'
          ? 'బిజినెస్ సలహా కోసం దయచేసి స్పష్టమైన ప్రశ్న అడగండి. లేదా భవిష్యత్తులో AI fallback ఎనేబుల్ చేయండి.'
          : 'For business advice, please ask a specific question, or enable the AI fallback in a later phase.',
        intent: INTENT.NEEDS_LLM,
        dataSummary: null,
        language: detectedLanguage,
      });
    }

    if (intent === INTENT.NEEDS_LLM) {
      return res.json({
        answer: formatFallbackAnswer(detectedLanguage),
        intent: INTENT.NEEDS_LLM,
        dataSummary: null,
        language: detectedLanguage,
      });
    }

    const dateRange = resolveDateRange(message);
    const cacheKey = computeCacheKey(userId, tenantIds, intent, dateRange, undefined);
    const cached = await cacheGet<string>(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return res.json({ ...parsed, cached: true });
      } catch {
        // Ignore cache parse errors and fall through
      }
    }

    let itemName: string | undefined;
    let data: any;
    let prevRangeForComparison: { startDate: string; endDate: string; startIST: Date; endIST: Date } | undefined;

    if (intent === INTENT.ITEM_SALES || intent === INTENT.PURCHASES) {
      const match = await matchItem(message, tenantIds);
      itemName = match.itemName;
    }

    switch (intent) {
      case INTENT.SALES_SUMMARY:
        data = await getDailySalesData(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.AOV:
        data = await getAovData(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.REVENUE:
        data = await getRevenueData(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.ORDERS:
        data = await getOrdersCount(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.CATEGORY_SALES:
        data = await getCategorySales(tenantIds, dateRange.startIST, dateRange.endIST, classification.categoryName || 'Desserts');
        break;
      case INTENT.SPECIALS:
        data = await getSpecialsSummary(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.OUTLET_WISE:
        data = await getOutletWisePerformance(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.ITEM_SALES:
        data = await getItemwiseSalesData(tenantIds, dateRange.startIST, dateRange.endIST, { itemName });
        break;
      case INTENT.DISCOUNTS:
        data = await getDiscountReportData(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.ATTENDANCE:
        data = await getAttendanceSummary(tenantIds, dateRange.startDate, dateRange.endDate);
        break;
      case INTENT.PURCHASES:
        data = await getPurchaseSummary(tenantIds, dateRange.startDate, dateRange.endDate, itemName);
        break;
      case INTENT.TOP_SELLING:
        data = await getTopSellingItems(tenantIds, dateRange.startIST, dateRange.endIST, classification.limit ?? 5);
        break;
      case INTENT.FLOOR_STATUS:
        data = await getFloorStatus(tenantIds);
        break;
      case INTENT.PAYMENT_BREAKDOWN:
        data = await getPaymentBreakdown(tenantIds, dateRange.startIST, dateRange.endIST);
        break;
      case INTENT.WASTAGE:
        data = await getWastageSummary(tenantIds, dateRange.startDate, dateRange.endDate);
        break;
      case INTENT.LOW_STOCK:
        data = await getLowStockAlerts(tenantIds);
        break;
      case INTENT.PERIOD_COMPARISON: {
        prevRangeForComparison = computePreviousRange(dateRange);
        data = await getPeriodComparison(
          tenantIds,
          dateRange.startIST, dateRange.endIST,
          prevRangeForComparison.startIST, prevRangeForComparison.endIST,
        );
        break;
      }
      case INTENT.AOV_COMPARISON: {
        prevRangeForComparison = computePreviousRange(dateRange);
        data = await getAovComparison(
          tenantIds,
          dateRange.startIST, dateRange.endIST,
          prevRangeForComparison.startIST, prevRangeForComparison.endIST,
        );
        break;
      }
      default:
        return res.json({
          answer: formatFallbackAnswer(detectedLanguage),
          intent: INTENT.NEEDS_LLM,
          dataSummary: null,
          language: detectedLanguage,
        });
    }

    const dateRangeText = getDateRangeText(detectedLanguage, dateRange.startDate, dateRange.endDate);
    // For comparison intents, also surface the previous period's range text so
    // the response is unambiguous about which two periods were compared.
    // Reuse the prevRange already computed in the switch above (if any).
    let previousDateRangeText: string | undefined;
    if (prevRangeForComparison) {
      previousDateRangeText = getDateRangeText(detectedLanguage, prevRangeForComparison.startDate, prevRangeForComparison.endDate);
    }
    const { answer, dataSummary } = formatAnswer(intent, data, {
      language: detectedLanguage,
      dateRangeText,
      previousDateRangeText,
      categoryName: classification.categoryName,
    });

    const response = {
      answer,
      intent,
      dataSummary,
      language: detectedLanguage,
    };

    await cacheSet(cacheKey, JSON.stringify(response), CACHE_TTL_SECONDS);

    return res.json(response);
  } catch (err: any) {
    logger.error({ err }, '[Spire] ask error');
    return res.status(500).json({ error: 'Failed to process Spire request' });
  }
});

export default router;
