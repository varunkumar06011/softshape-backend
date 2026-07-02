// Deterministic date-range resolver for the Spire AI agent.
// No external date library — returns both Date objects (for paidAt DateTime fields)
// and zero-padded YYYY-MM-DD strings (for String fields like Attendance.date
// and DailyInventorySnapshot.snapshotDate).

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

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  startIST: Date;
  endIST: Date;
}

export function resolveDateRange(message: string, defaultDate?: string): DateRange {
  const base = defaultDate || getToday();
  const lower = message.toLowerCase();
  let startDate: string;
  let endDate: string;

  // Explicit date patterns: DD-MM-YYYY or DD/MM/YYYY
  const explicit = parseExplicitDate(message);
  if (explicit) {
    startDate = explicit;
    endDate = explicit;
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
      // Default to today if no date expression is found
      startDate = base;
      endDate = base;
    }
  }

  const { startIST, endIST } = toISTRange(startDate, endDate);
  return { startDate, endDate, startIST, endIST };
}

export default resolveDateRange;
