// Spire AI Agent route — rule-based operational assistant for restaurant owners.
// Mounted with: authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext

import { Router } from 'express';
import { resolveTenantContext } from '../lib/tenantContext';
import { cacheGet, cacheSet } from '../lib/cache';
import logger from '../lib/logger';
import resolveDateRange from '../services/spire/dateResolver';
import classifyIntent, { INTENT, type Intent } from '../services/spire/intentEngine';
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
} from '../services/spire/fetchers';

const router = Router();

const CACHE_TTL_SECONDS = 5 * 60;

async function getTenantIds(req: any): Promise<string[]> {
  const user = req.user;
  if (!user?.restaurantId) return [];
  const effectiveId = user.activeRestaurantId ?? user.restaurantId;
  const ctx = await resolveTenantContext(effectiveId);
  return ctx.allIds;
}

function computeCacheKey(tenantId: string, intent: string, dateRange: any, itemName?: string): string {
  const rangeHash = `${dateRange.startDate}:${dateRange.endDate}`;
  return `spire:${tenantId}:${intent}:${rangeHash}:${itemName || ''}`;
}

function detectLanguage(message: string): 'en' | 'te' {
  return isTeluguText(message) ? 'te' : 'en';
}

function classifyAnyIntent(message: string, language: 'en' | 'te'): { intent: Intent; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; limit?: number } {
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

    const tenantIds = await getTenantIds(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const effectiveTenantId = req.user.activeRestaurantId ?? req.user.restaurantId;
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
    const cacheKey = computeCacheKey(effectiveTenantId, intent, dateRange, undefined);
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

    if (intent === INTENT.ITEM_SALES || intent === INTENT.PURCHASES) {
      const match = await matchItem(message, tenantIds);
      itemName = match.itemName;
    }

    switch (intent) {
      case INTENT.SALES_SUMMARY:
        data = await getDailySalesData(tenantIds, dateRange.startIST, dateRange.endIST);
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
      default:
        return res.json({
          answer: formatFallbackAnswer(detectedLanguage),
          intent: INTENT.NEEDS_LLM,
          dataSummary: null,
          language: detectedLanguage,
        });
    }

    const dateRangeText = getDateRangeText(detectedLanguage, dateRange.startDate, dateRange.endDate);
    const { answer, dataSummary } = formatAnswer(intent, data, {
      language: detectedLanguage,
      dateRangeText,
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
