// Deterministic date-range resolver for the Spire AI agent.
// No external date library — returns both Date objects (for paidAt DateTime fields)
// and zero-padded YYYY-MM-DD strings (for String fields like Attendance.date
// and DailyInventorySnapshot.snapshotDate).
//
// Supported natural-language date expressions:
//   - Explicit dates: DD-MM-YYYY, DD/MM/YYYY
//   - "today", "yesterday"
//   - "this week", "last week"
//   - "this month", "last month"
//   - "N days/weeks/months ago"
//   - Day-of-month references: "27th", "the 27th"
//   - "from <day>th to today" / "from 27th to today"
//   - "27th of last month to today" / "from 27th of last month to today"
//   - "from <date> to <date>" (two explicit dates)
//   - "from <day>th of this month to <day>th of this month"

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTRange(startDate: string, endDate: string) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startIST = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { startIST, endIST };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getToday(): string {
  return formatDate(new Date());
}

function parseExplicitDate(input: string): string | null {
  const s = input.trim().replace(/\s+/g, ' ');
  // DD-MM-YYYY or DD/MM/YYYY
  const m = s.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
  if (m) {
    const d = Number(m[1]);
    const mon = Number(m[2]);
    const y = Number(m[3]);
    if (d >= 1 && d <= 31 && mon >= 1 && mon <= 12 && y >= 2000 && y <= 2100) {
      return `${y}-${pad(mon)}-${pad(d)}`;
    }
  }
  return null;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return formatDate(dt);
}

function startOfWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0 = Sunday
  dt.setDate(dt.getDate() - day);
  return formatDate(dt);
}

function endOfWeek(date: string): string {
  const start = startOfWeek(date);
  return addDays(start, 6);
}

function startOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}-${pad(m)}-01`;
}

function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const dt = new Date(y, m, 0);
  return formatDate(dt);
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1 + months, d);
  return formatDate(dt);
}

// Returns the last valid day-of-month for a given year/month (handles month
// boundaries — e.g. day 31 in February becomes 28/29).
function clampDayToMonth(year: number, month1Based: number, day: number): string {
  const lastDay = new Date(year, month1Based, 0).getDate();
  const clamped = Math.min(day, lastDay);
  return `${year}-${pad(month1Based)}-${pad(clamped)}`;
}

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  startIST: Date;
  endIST: Date;
}

// Extracts a day-of-month (e.g. "27th", "the 27th", "27") from a phrase.
// Returns the day number (1-31) or null if not found.
function parseDayOfMonth(phrase: string): number | null {
  const m = phrase.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return day;
  }
  return null;
}

// Resolves a day-of-month in the context of a month reference.
// monthRef: 'this' | 'last' | 'next' | undefined (defaults to current month)
function resolveDayInMonth(day: number, base: string, monthRef: string | undefined): string {
  const [y, m] = base.split('-').map(Number);
  if (monthRef === 'last') {
    // Previous month
    const prevMonth = m - 1;
    if (prevMonth < 1) return clampDayToMonth(y - 1, 12, day);
    return clampDayToMonth(y, prevMonth, day);
  }
  if (monthRef === 'next') {
    const nextMonth = m + 1;
    if (nextMonth > 12) return clampDayToMonth(y + 1, 1, day);
    return clampDayToMonth(y, nextMonth, day);
  }
  // 'this' or undefined → current month
  return clampDayToMonth(y, m, day);
}

// Detects a month reference keyword ("last month", "this month", "next month")
// in a phrase and returns the corresponding monthRef token.
function detectMonthRef(phrase: string): string | undefined {
  const lower = phrase.toLowerCase();
  if (lower.includes('last month') || lower.includes('previous month')) return 'last';
  if (lower.includes('next month')) return 'next';
  if (lower.includes('this month') || lower.includes('current month')) return 'this';
  return undefined;
}

// Parses a "from X to Y" range where X and Y can be:
//   - explicit dates (DD-MM-YYYY)
//   - "today"
//   - day-of-month with optional month reference ("27th", "27th of last month")
// Returns { startDate, endDate } as YYYY-MM-DD strings, or null if it can't parse.
function parseFromToRange(message: string, base: string): { startDate: string; endDate: string } | null {
  const lower = message.toLowerCase();

  // "from X to Y" or "X to Y" patterns. We require "from ... to ..." or a
  // standalone "... to today" / "... to now" to avoid false positives.
  const fromTo = lower.match(/(?:from\s+)?(.+?)\s+to\s+(today|now|yesterday|end of (?:this |last )?month|this month end|.+)$/);
  if (!fromTo) return null;

  let startPhrase = fromTo[1].trim();
  let endPhrase = fromTo[2].trim();

  // Strip a leading "from" if present in startPhrase, and trim trailing
  // punctuation (e.g. "today?" → "today") so keyword matches succeed.
  startPhrase = startPhrase.replace(/^from\s+/, '').replace(/[^a-z0-9\s]+$/,'').trim();
  endPhrase = endPhrase.replace(/[^a-z0-9\s]+$/,'').trim();

  // Resolve end date — day-of-month is checked before whole-month keywords
  // so "20th of last month" resolves to the 20th, not end-of-last-month.
  let endDate: string;
  const explicitEnd = parseExplicitDate(endPhrase);
  const endDay = parseDayOfMonth(endPhrase);
  if (endPhrase === 'today' || endPhrase === 'now' || endPhrase.startsWith('today') || endPhrase.startsWith('now')) {
    endDate = base;
  } else if (endPhrase === 'yesterday' || endPhrase.startsWith('yesterday')) {
    endDate = addDays(base, -1);
  } else if (explicitEnd) {
    endDate = explicitEnd;
  } else if (endDay !== null) {
    // Day-of-month with optional month reference: "20th", "20th of last month"
    const endMonthRef = detectMonthRef(endPhrase);
    endDate = resolveDayInMonth(endDay, base, endMonthRef);
  } else if (endPhrase.includes('end of this month') || endPhrase.includes('this month end')) {
    endDate = endOfMonth(base);
  } else if (endPhrase.includes('end of last month')) {
    endDate = endOfMonth(addMonths(startOfMonth(base), -1));
  } else if (endPhrase.includes('this month')) {
    endDate = endOfMonth(base);
  } else if (endPhrase.includes('last month')) {
    const lastMonthStart = addMonths(startOfMonth(base), -1);
    endDate = endOfMonth(lastMonthStart);
  } else {
    return null;
  }

  // Resolve start date — day-of-month is checked before whole-month keywords
  // so "27th of last month" resolves to the 27th, not the 1st of last month.
  let startDate: string;
  const explicitStart = parseExplicitDate(startPhrase);
  const startDay = parseDayOfMonth(startPhrase);
  if (explicitStart) {
    startDate = explicitStart;
  } else if (startPhrase === 'today' || startPhrase === 'now') {
    startDate = base;
  } else if (startPhrase === 'yesterday') {
    startDate = addDays(base, -1);
  } else if (startDay !== null) {
    // Day-of-month with optional month reference: "27th", "27th of last month",
    // "the 27th of last month", "27 of this month"
    const startMonthRef = detectMonthRef(startPhrase);
    startDate = resolveDayInMonth(startDay, base, startMonthRef);
    // If a bare day-of-month (no explicit month ref) resolves to a future
    // date relative to today, roll it back to the previous month — "from the
    // 27th to today" means the most recent past 27th.
    if (!startMonthRef && startDate > base) {
      startDate = resolveDayInMonth(startDay, base, 'last');
    }
  } else if (startPhrase.includes('start of this month') || startPhrase === 'this month start') {
    startDate = startOfMonth(base);
  } else if (startPhrase.includes('start of last month') || startPhrase === 'last month start') {
    startDate = addMonths(startOfMonth(base), -1);
  } else if (startPhrase.includes('this month')) {
    startDate = startOfMonth(base);
  } else if (startPhrase.includes('last month')) {
    const lastMonthStart = addMonths(startOfMonth(base), -1);
    startDate = startOfMonth(lastMonthStart);
  } else {
    return null;
  }

  // Guard: if start is after end, swap them so the range is always valid.
  if (startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  return { startDate, endDate };
}

export function resolveDateRange(message: string, defaultDate?: string): DateRange {
  const base = defaultDate || getToday();
  const lower = message.toLowerCase();
  let startDate: string;
  let endDate: string;

  // "from X to Y" / "X to today" ranges (checked before single-date patterns)
  const fromToRange = parseFromToRange(message, base);
  if (fromToRange) {
    startDate = fromToRange.startDate;
    endDate = fromToRange.endDate;
  } else if (lower.includes('today')) {
    startDate = base;
    endDate = base;
  } else if (lower.includes('yesterday')) {
    startDate = addDays(base, -1);
    endDate = startDate;
  } else if (lower.includes('last week')) {
    const lastWeekStart = addDays(startOfWeek(base), -7);
    startDate = lastWeekStart;
    endDate = addDays(lastWeekStart, 6);
  } else if (lower.includes('this week')) {
    startDate = startOfWeek(base);
    endDate = endOfWeek(base);
  } else if (lower.includes('last month')) {
    const lastMonthStart = addMonths(startOfMonth(base), -1);
    startDate = lastMonthStart;
    endDate = endOfMonth(lastMonthStart);
  } else if (lower.includes('this month')) {
    startDate = startOfMonth(base);
    endDate = endOfMonth(base);
  } else {
    const relative = lower.match(/(\d+)\s*(day|week|month)s?\s+ago/);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2];
      if (unit === 'day') {
        startDate = addDays(base, -amount);
        endDate = startDate;
      } else if (unit === 'week') {
        const target = addDays(base, -amount * 7);
        startDate = startOfWeek(target);
        endDate = endOfWeek(target);
      } else {
        const target = addMonths(base, -amount);
        startDate = startOfMonth(target);
        endDate = endOfMonth(target);
      }
    } else {
      // Single explicit date: DD-MM-YYYY or DD/MM/YYYY
      const explicit = parseExplicitDate(message);
      if (explicit) {
        startDate = explicit;
        endDate = explicit;
      } else {
        // Default to today if no date expression is found
        startDate = base;
        endDate = base;
      }
    }
  }

  const { startIST, endIST } = toISTRange(startDate, endDate);
  return { startDate, endDate, startIST, endIST };
}

export default resolveDateRange;
