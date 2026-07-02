// Response formatters for the Spire AI agent.
// Turns structured data into plain English or Telugu answers.

import { INTENT, type Intent } from './intentEngine';

function formatCurrency(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-IN');
}

export interface FormatterContext {
  language: 'en' | 'te';
  dateRangeText: string;
}

export function formatAnswer(
  intent: Intent,
  data: any,
  ctx: FormatterContext,
): { answer: string; dataSummary: any } {
  const { language, dateRangeText } = ctx;

  if (language === 'te') {
    return formatTeluguAnswer(intent, data, dateRangeText);
  }

  return formatEnglishAnswer(intent, data, dateRangeText);
}

function formatEnglishAnswer(intent: Intent, data: any, dateRangeText: string): { answer: string; dataSummary: any } {
  const dataSummary: any = { intent, dateRangeText };

  switch (intent) {
    case INTENT.SALES_SUMMARY: {
      const s = data.summary;
      dataSummary.summary = s;
      const answer = [
        `Sales ${dateRangeText}: ${formatCurrency(s.totalRevenue)}`,
        `Transactions: ${formatNumber(s.totalTransactions)}`,
        `Average bill: ${formatCurrency(s.averageBillValue)}`,
        s.totalDiscount ? `Discounts: ${formatCurrency(s.totalDiscount)}` : null,
      ].filter(Boolean).join(' · ');
      return { answer, dataSummary };
    }

    case INTENT.ITEM_SALES: {
      const s = data.summary;
      const items = data.items.slice(0, 5);
      dataSummary.summary = s;
      dataSummary.items = items;
      const itemLines = items.map((it: any) => `${it.name}: ${formatNumber(it.quantitySold)} qty, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `Item sales ${dateRangeText}:\n${itemLines || 'No matching items found.'}\nTotal: ${formatNumber(s.totalQuantity)} qty, ${formatCurrency(s.totalRevenue)}`;
      return { answer, dataSummary };
    }

    case INTENT.DISCOUNTS: {
      const s = data.summary;
      dataSummary.summary = s;
      const answer = `Discounts ${dateRangeText}: ${formatCurrency(s.totalDiscountGiven)} across ${formatNumber(s.totalTransactionsWithDiscount)} bills. Average discount: ${s.averageDiscountPercent}%.`;
      return { answer, dataSummary };
    }

    case INTENT.ATTENDANCE: {
      const s = data;
      dataSummary.attendance = s;
      const answer = `Attendance ${dateRangeText}: ${formatNumber(s.present)} present, ${formatNumber(s.absent)} absent, ${formatNumber(s.halfDay)} half-day, ${formatNumber(s.leave)} leave, ${formatNumber(s.notMarked)} not marked out of ${formatNumber(s.totalEmployees)} staff.`;
      return { answer, dataSummary };
    }

    case INTENT.PURCHASES: {
      const s = data;
      dataSummary.purchases = s;
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.itemName}: ${formatNumber(it.purchased)} purchased, ${formatNumber(it.sold)} sold, ${formatNumber(it.wastage)} wastage`).join('\n');
      const answer = `Purchases ${dateRangeText}:\n${itemLines || 'No matching items found.'}\nTotal purchased: ${formatNumber(s.totalPurchased)}`;
      return { answer, dataSummary };
    }

    case INTENT.TOP_SELLING: {
      const items = data.items;
      dataSummary.items = items;
      const itemLines = items.map((it: any, i: number) => `${i + 1}. ${it.name}: ${formatNumber(it.quantitySold)} qty, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `Top selling items ${dateRangeText}:\n${itemLines || 'No items found.'}`;
      return { answer, dataSummary };
    }

    default:
      return {
        answer: "I couldn't understand that. Try rephrasing, e.g. 'today sales' or 'this week chicken sales'.",
        dataSummary: { intent: INTENT.NEEDS_LLM },
      };
  }
}

function formatTeluguAnswer(intent: Intent, data: any, dateRangeText: string): { answer: string; dataSummary: any } {
  const dataSummary: any = { intent, language: 'te', dateRangeText };

  switch (intent) {
    case INTENT.SALES_SUMMARY: {
      const s = data.summary;
      dataSummary.summary = s;
      const answer = `${dateRangeText} అమ్మకాలు: ${formatCurrency(s.totalRevenue)} · బిల్లులు: ${formatNumber(s.totalTransactions)} · సగటు బిల్లు: ${formatCurrency(s.averageBillValue)}`;
      return { answer, dataSummary };
    }

    case INTENT.ITEM_SALES: {
      const s = data.summary;
      const items = data.items.slice(0, 5);
      dataSummary.summary = s;
      dataSummary.items = items;
      const itemLines = items.map((it: any) => `${it.name}: ${formatNumber(it.quantitySold)} మొత్తం, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `${dateRangeText} అమ్మకాలు:\n${itemLines || 'సరిపోలే అంశాలు లేవు.'}\nమొత్తం: ${formatNumber(s.totalQuantity)} మొత్తం, ${formatCurrency(s.totalRevenue)}`;
      return { answer, dataSummary };
    }

    case INTENT.DISCOUNTS: {
      const s = data.summary;
      dataSummary.summary = s;
      const answer = `${dateRangeText} డిస్కౌంట్లు: ${formatCurrency(s.totalDiscountGiven)} · ${formatNumber(s.totalTransactionsWithDiscount)} బిల్లులు · సగటు డిస్కౌంట్: ${s.averageDiscountPercent}%.`;
      return { answer, dataSummary };
    }

    case INTENT.ATTENDANCE: {
      const s = data;
      dataSummary.attendance = s;
      const answer = `${dateRangeText} హాజరు: ${formatNumber(s.present)} హాజరు, ${formatNumber(s.absent)} గైర్హాజరు, ${formatNumber(s.totalEmployees)} మంది సిబ్బందిలో.`;
      return { answer, dataSummary };
    }

    case INTENT.PURCHASES: {
      const s = data;
      dataSummary.purchases = s;
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.itemName}: ${formatNumber(it.purchased)} కొనుగోలు, ${formatNumber(it.sold)} అమ్మకం, ${formatNumber(it.wastage)} వృథా`).join('\n');
      const answer = `${dateRangeText} కొనుగోళ్లు:\n${itemLines || 'సరిపోలే అంశాలు లేవు.'}\nమొత్తం కొనుగోలు: ${formatNumber(s.totalPurchased)}`;
      return { answer, dataSummary };
    }

    case INTENT.TOP_SELLING: {
      const items = data.items;
      dataSummary.items = items;
      const itemLines = items.map((it: any, i: number) => `${i + 1}. ${it.name}: ${formatNumber(it.quantitySold)} మొత్తం, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `${dateRangeText} టాప్ అమ్మకాలు:\n${itemLines || 'అంశాలు లేవు.'}`;
      return { answer, dataSummary };
    }

    default:
      return {
        answer: "నాకు అర్థం కాలేదు. దయచేసి 'ఈరోజు అమ్మకాలు' లాంటి విధంగా ప్రయత్నించండి.",
        dataSummary: { intent: INTENT.NEEDS_LLM },
      };
  }
}

export default formatAnswer;
