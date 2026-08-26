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
  // Optional previous-period range text for comparison intents.
  previousDateRangeText?: string;
  // Optional category name for CATEGORY_SALES.
  categoryName?: string;
}

export function formatAnswer(
  intent: Intent,
  data: any,
  ctx: FormatterContext,
): { answer: string; dataSummary: any } {
  const { language, dateRangeText, previousDateRangeText, categoryName } = ctx;

  if (language === 'te') {
    return formatTeluguAnswer(intent, data, dateRangeText, previousDateRangeText, categoryName);
  }

  return formatEnglishAnswer(intent, data, dateRangeText, previousDateRangeText, categoryName);
}

function formatEnglishAnswer(intent: Intent, data: any, dateRangeText: string, previousDateRangeText?: string, categoryName?: string): { answer: string; dataSummary: any } {
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

    case INTENT.AOV: {
      const s = data;
      dataSummary.aov = s;
      if (s.totalTransactions === 0) {
        return { answer: `No completed bills ${dateRangeText}, so AOV is not available.`, dataSummary };
      }
      const answer = `AOV ${dateRangeText}: ${formatCurrency(s.aov)} across ${formatNumber(s.totalTransactions)} bills (total revenue ${formatCurrency(s.totalRevenue)}${s.totalDiscount ? `, discounts ${formatCurrency(s.totalDiscount)}` : ''}).`;
      return { answer, dataSummary };
    }

    case INTENT.AOV_COMPARISON: {
      const s = data;
      dataSummary.comparison = s;
      const prevText = previousDateRangeText || 'previous period';
      const trend = s.aovDelta >= 0 ? 'up' : 'down';
      const answer = `AOV comparison:\nCurrent ${dateRangeText}: ${formatCurrency(s.current.aov)} (${formatNumber(s.current.totalTransactions)} bills, revenue ${formatCurrency(s.current.totalRevenue)})\nPrevious ${prevText}: ${formatCurrency(s.previous.aov)} (${formatNumber(s.previous.totalTransactions)} bills, revenue ${formatCurrency(s.previous.totalRevenue)})\nAOV change: ${trend} ${formatCurrency(Math.abs(s.aovDelta))} (${s.aovDeltaPercent}%)\nRevenue change: ${s.revenueDelta >= 0 ? '+' : ''}${formatCurrency(s.revenueDelta)} (${s.revenueDeltaPercent}%)\nBills change: ${s.transactionDelta >= 0 ? '+' : ''}${formatNumber(s.transactionDelta)}`;
      return { answer, dataSummary };
    }

    case INTENT.REVENUE: {
      const s = data;
      dataSummary.revenue = s;
      const answer = `Revenue ${dateRangeText}: ${formatCurrency(s.totalRevenue)} (net ${formatCurrency(s.netSales)}) across ${formatNumber(s.totalTransactions)} bills. Discounts: ${formatCurrency(s.totalDiscount)}. Average bill: ${formatCurrency(s.averageBillValue)}.`;
      return { answer, dataSummary };
    }

    case INTENT.ORDERS: {
      const s = data;
      dataSummary.orders = s;
      const answer = `Bills ${dateRangeText}: ${formatNumber(s.totalTransactions)} bills, ${formatCurrency(s.totalRevenue)} revenue. Average bill: ${formatCurrency(s.averageBillValue)}.`;
      return { answer, dataSummary };
    }

    case INTENT.CATEGORY_SALES: {
      const s = data;
      dataSummary.categorySales = s;
      const label = categoryName || s.categoryName || 'category';
      if (s.items.length === 0) {
        return { answer: `No ${label} sales found ${dateRangeText}.`, dataSummary };
      }
      const itemLines = s.items.slice(0, 8).map((it: any) => `${it.name}: ${formatNumber(it.quantitySold)} qty, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `${label} sales ${dateRangeText}:\n${itemLines}\nTotal: ${formatNumber(s.totalQuantity)} qty, ${formatCurrency(s.totalRevenue)} revenue`;
      return { answer, dataSummary };
    }

    case INTENT.SPECIALS: {
      const s = data;
      dataSummary.specials = s;
      if (s.specials.length === 0) {
        return { answer: `No specials sold ${dateRangeText}.`, dataSummary };
      }
      const lines = s.specials.map((sp: any) => `${sp.name} — ${formatNumber(sp.quantitySold)} sold — ${formatCurrency(sp.revenue)} revenue`);
      const outletLines = s.byOutlet && s.byOutlet.length > 1
        ? `\n\nOutlet-wise\n` + s.byOutlet.map((o: any) => `${o.outletName} — Specials: ${formatCurrency(o.specialsRevenue)} | Total Revenue: ${formatCurrency(o.totalRevenue)}`).join('\n')
        : '';
      const answer = `Today's Specials\n\n${lines.join('\n')}\n\nTotal Specials Revenue: ${formatCurrency(s.totalSpecialsRevenue)}\nTotal Outlet Revenue: ${formatCurrency(s.totalOutletRevenue)}\nSpecials Contribution: ${s.specialsContributionPercent}%${outletLines}`;
      return { answer, dataSummary };
    }

    case INTENT.OUTLET_WISE: {
      const s = data;
      dataSummary.outletWise = s;
      if (s.outlets.length === 0) {
        return { answer: `No sales found ${dateRangeText}.`, dataSummary };
      }
      const outletLines = s.outlets.map((o: any, i: number) => `${i + 1}. ${o.outletName}: ${formatCurrency(o.totalRevenue)} revenue, ${formatNumber(o.totalTransactions)} bills, AOV ${formatCurrency(o.averageBillValue)}`).join('\n');
      const answer = `Outlet-wise performance ${dateRangeText}:\n${outletLines}\n\nTotal: ${formatCurrency(s.totalRevenue)} revenue, ${formatNumber(s.totalTransactions)} bills, AOV ${formatCurrency(s.averageBillValue)}`;
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

    case INTENT.FLOOR_STATUS: {
      const s = data;
      dataSummary.floorStatus = s;
      const answer = `Floor status: ${formatNumber(s.occupied)} occupied, ${formatNumber(s.available)} available, ${formatNumber(s.reserved)} reserved, ${formatNumber(s.cleaning)} cleaning, ${formatNumber(s.billingRequested)} billing requested out of ${formatNumber(s.total)} tables.\nCurrent bills: ${formatCurrency(s.totalCurrentBill)} · Guests: ${formatNumber(s.totalGuests)}`;
      return { answer, dataSummary };
    }

    case INTENT.PAYMENT_BREAKDOWN: {
      const s = data;
      dataSummary.paymentBreakdown = s;
      const methodLines = s.methods.map((m: any) => `${m.method}: ${formatCurrency(m.totalAmount)} (${formatNumber(m.count)} txns)`).join('\n');
      const answer = `Payment breakdown ${dateRangeText}:\n${methodLines || 'No transactions found.'}\nTotal: ${formatCurrency(s.totalAmount)} across ${formatNumber(s.totalTransactions)} transactions`;
      return { answer, dataSummary };
    }

    case INTENT.WASTAGE: {
      const s = data;
      dataSummary.wastage = s;
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.itemName}: ${formatNumber(it.wastage)}`).join('\n');
      const answer = `Wastage ${dateRangeText}:\n${itemLines || 'No wastage recorded.'}\nTotal wastage: ${formatNumber(s.totalWastage)}`;
      return { answer, dataSummary };
    }

    case INTENT.LOW_STOCK: {
      const s = data;
      dataSummary.lowStock = s;
      if (s.totalAlerts === 0) {
        return { answer: 'No low stock alerts. All kitchen items are above reorder levels.', dataSummary };
      }
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.name}: ${formatNumber(it.currentStock)} ${it.unit} left (reorder at ${formatNumber(it.reorderLevel)} ${it.unit})`).join('\n');
      const answer = `Low stock alerts (${formatNumber(s.totalAlerts)} items):\n${itemLines}`;
      return { answer, dataSummary };
    }

    case INTENT.PERIOD_COMPARISON: {
      const s = data;
      dataSummary.comparison = s;
      const trend = s.revenueDelta >= 0 ? 'up' : 'down';
      const answer = `Revenue comparison:\nCurrent: ${formatCurrency(s.current.totalRevenue)} (${formatNumber(s.current.totalTransactions)} txns)\nPrevious: ${formatCurrency(s.previous.totalRevenue)} (${formatNumber(s.previous.totalTransactions)} txns)\nChange: ${trend} ${formatCurrency(Math.abs(s.revenueDelta))} (${s.revenueDeltaPercent}%)\nTransactions: ${s.transactionDelta >= 0 ? '+' : ''}${formatNumber(s.transactionDelta)}`;
      return { answer, dataSummary };
    }

    default:
      return {
        answer: "I couldn't understand that. Try rephrasing, e.g. 'today sales' or 'this week chicken sales'.",
        dataSummary: { intent: INTENT.NEEDS_LLM },
      };
  }
}

function formatTeluguAnswer(intent: Intent, data: any, dateRangeText: string, previousDateRangeText?: string, categoryName?: string): { answer: string; dataSummary: any } {
  const dataSummary: any = { intent, language: 'te', dateRangeText };

  switch (intent) {
    case INTENT.SALES_SUMMARY: {
      const s = data.summary;
      dataSummary.summary = s;
      const answer = `${dateRangeText} అమ్మకాలు: ${formatCurrency(s.totalRevenue)} · బిల్లులు: ${formatNumber(s.totalTransactions)} · సగటు బిల్లు: ${formatCurrency(s.averageBillValue)}`;
      return { answer, dataSummary };
    }

    case INTENT.AOV: {
      const s = data;
      dataSummary.aov = s;
      if (s.totalTransactions === 0) {
        return { answer: `${dateRangeText} పూర్తయిన బిల్లులు లేవు, కాబట్టి AOV లేదు.`, dataSummary };
      }
      const answer = `${dateRangeText} AOV: ${formatCurrency(s.aov)} · ${formatNumber(s.totalTransactions)} బిల్లులు · మొత్తం ఆదాయం ${formatCurrency(s.totalRevenue)}.`;
      return { answer, dataSummary };
    }

    case INTENT.AOV_COMPARISON: {
      const s = data;
      dataSummary.comparison = s;
      const prevText = previousDateRangeText || 'గత కాలం';
      const trend = s.aovDelta >= 0 ? 'పెరుగుదల' : 'తగ్గుదల';
      const answer = `AOV పోలిక:\nప్రస్తుతం ${dateRangeText}: ${formatCurrency(s.current.aov)} (${formatNumber(s.current.totalTransactions)} బిల్లులు)\n${prevText}: ${formatCurrency(s.previous.aov)} (${formatNumber(s.previous.totalTransactions)} బిల్లులు)\nమార్పు: ${trend} ${formatCurrency(Math.abs(s.aovDelta))} (${s.aovDeltaPercent}%)`;
      return { answer, dataSummary };
    }

    case INTENT.REVENUE: {
      const s = data;
      dataSummary.revenue = s;
      const answer = `${dateRangeText} ఆదాయం: ${formatCurrency(s.totalRevenue)} · ${formatNumber(s.totalTransactions)} బిల్లులు · సగటు బిల్లు ${formatCurrency(s.averageBillValue)}.`;
      return { answer, dataSummary };
    }

    case INTENT.ORDERS: {
      const s = data;
      dataSummary.orders = s;
      const answer = `${dateRangeText} బిల్లులు: ${formatNumber(s.totalTransactions)} · ${formatCurrency(s.totalRevenue)} ఆదాయం · సగటు బిల్లు ${formatCurrency(s.averageBillValue)}.`;
      return { answer, dataSummary };
    }

    case INTENT.CATEGORY_SALES: {
      const s = data;
      dataSummary.categorySales = s;
      const label = categoryName || s.categoryName || 'వర్గం';
      if (s.items.length === 0) {
        return { answer: `${dateRangeText} ${label} అమ్మకాలు లేవు.`, dataSummary };
      }
      const itemLines = s.items.slice(0, 8).map((it: any) => `${it.name}: ${formatNumber(it.quantitySold)} మొత్తం, ${formatCurrency(it.totalRevenue)}`).join('\n');
      const answer = `${dateRangeText} ${label} అమ్మకాలు:\n${itemLines}\nమొత్తం: ${formatNumber(s.totalQuantity)} మొత్తం, ${formatCurrency(s.totalRevenue)}`;
      return { answer, dataSummary };
    }

    case INTENT.SPECIALS: {
      const s = data;
      dataSummary.specials = s;
      if (s.specials.length === 0) {
        return { answer: `${dateRangeText} స్పెషల్స్ అమ్మకాలు లేవు.`, dataSummary };
      }
      const lines = s.specials.map((sp: any) => `${sp.name} — ${formatNumber(sp.quantitySold)} అమ్మకం — ${formatCurrency(sp.revenue)}`);
      const outletLines = s.byOutlet && s.byOutlet.length > 1
        ? `\n\nఔట్లెట్-వైస్\n` + s.byOutlet.map((o: any) => `${o.outletName} — స్పెషల్స్: ${formatCurrency(o.specialsRevenue)} | మొత్తం: ${formatCurrency(o.totalRevenue)}`).join('\n')
        : '';
      const answer = `నేటి స్పెషల్స్\n\n${lines.join('\n')}\n\nమొత్తం స్పెషల్స్ ఆదాయం: ${formatCurrency(s.totalSpecialsRevenue)}\nమొత్తం ఔట్లెట్ ఆదాయం: ${formatCurrency(s.totalOutletRevenue)}\nస్పెషల్స్ వాటా: ${s.specialsContributionPercent}%${outletLines}`;
      return { answer, dataSummary };
    }

    case INTENT.OUTLET_WISE: {
      const s = data;
      dataSummary.outletWise = s;
      if (s.outlets.length === 0) {
        return { answer: `${dateRangeText} అమ్మకాలు లేవు.`, dataSummary };
      }
      const outletLines = s.outlets.map((o: any, i: number) => `${i + 1}. ${o.outletName}: ${formatCurrency(o.totalRevenue)} ఆదాయం, ${formatNumber(o.totalTransactions)} బిల్లులు, AOV ${formatCurrency(o.averageBillValue)}`).join('\n');
      const answer = `ఔట్లెట్-వైస్ ${dateRangeText}:\n${outletLines}\n\nమొత్తం: ${formatCurrency(s.totalRevenue)} ఆదాయం, ${formatNumber(s.totalTransactions)} బిల్లులు`;
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

    case INTENT.FLOOR_STATUS: {
      const s = data;
      dataSummary.floorStatus = s;
      const answer = `ఫ్లోర్ స్థితి: ${formatNumber(s.occupied)} నిండిన, ${formatNumber(s.available)} ఖాళీ, ${formatNumber(s.reserved)} బుకింగ్, ${formatNumber(s.billingRequested)} బిల్ కోరిన ${formatNumber(s.total)} టేబుల్స్ లో.\nప్రస్తుత బిల్లులు: ${formatCurrency(s.totalCurrentBill)} · అతిథులు: ${formatNumber(s.totalGuests)}`;
      return { answer, dataSummary };
    }

    case INTENT.PAYMENT_BREAKDOWN: {
      const s = data;
      dataSummary.paymentBreakdown = s;
      const methodLines = s.methods.map((m: any) => `${m.method}: ${formatCurrency(m.totalAmount)} (${formatNumber(m.count)} లావాదేవీలు)`).join('\n');
      const answer = `${dateRangeText} చెల్లింపులు:\n${methodLines || 'లావాదేవీలు లేవు.'}\nమొత్తం: ${formatCurrency(s.totalAmount)} · ${formatNumber(s.totalTransactions)} లావాదేవీలు`;
      return { answer, dataSummary };
    }

    case INTENT.WASTAGE: {
      const s = data;
      dataSummary.wastage = s;
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.itemName}: ${formatNumber(it.wastage)}`).join('\n');
      const answer = `${dateRangeText} వృథా:\n${itemLines || 'వృథా లేదు.'}\nమొత్తం వృథా: ${formatNumber(s.totalWastage)}`;
      return { answer, dataSummary };
    }

    case INTENT.LOW_STOCK: {
      const s = data;
      dataSummary.lowStock = s;
      if (s.totalAlerts === 0) {
        return { answer: 'స్టాక్ అలర్ట్లు లేవు. అన్ని అంశాలు రీఆర్డర్ స్థాయికి పైనే.', dataSummary };
      }
      const itemLines = s.items.slice(0, 5).map((it: any) => `${it.name}: ${formatNumber(it.currentStock)} ${it.unit} మిగిలి (రీఆర్డర్ ${formatNumber(it.reorderLevel)} ${it.unit})`).join('\n');
      const answer = `స్టాక్ అలర్ట్లు (${formatNumber(s.totalAlerts)} అంశాలు):\n${itemLines}`;
      return { answer, dataSummary };
    }

    case INTENT.PERIOD_COMPARISON: {
      const s = data;
      dataSummary.comparison = s;
      const trend = s.revenueDelta >= 0 ? 'పెరుగుదల' : 'తగ్గుదల';
      const answer = `ఆదాయం పోలిక:\nప్రస్తుతం: ${formatCurrency(s.current.totalRevenue)} (${formatNumber(s.current.totalTransactions)} లావాదేవీలు)\nగతం: ${formatCurrency(s.previous.totalRevenue)} (${formatNumber(s.previous.totalTransactions)} లావాదేవీలు)\nమార్పు: ${trend} ${formatCurrency(Math.abs(s.revenueDelta))} (${s.revenueDeltaPercent}%)`;
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
