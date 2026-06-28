// ─────────────────────────────────────────────────────────────────────────────
// Date Utilities — IST (Kolkata) timezone helpers for consistent date handling
// ─────────────────────────────────────────────────────────────────────────────
// All date/time operations in the app use IST (Asia/Kolkata) as the reference
// timezone, even though the server may run in UTC. This ensures that daily
// counters, transaction dates, and report ranges align with the restaurant's
// business day (midnight IST to midnight IST).
//
// Functions:
//   getKolkataDateString(date?) — returns YYYY-MM-DD in IST
//   formatTxnDisplayId(txnDate, txnNumber) — formats as DD/MM/YY-NNN for receipts
// ─────────────────────────────────────────────────────────────────────────────

// IST timezone identifier used for all date formatting
const KOLKATA_TIME_ZONE = "Asia/Kolkata";

// Helper: returns Intl.DateTimeFormat parts for a given date in IST
function getParts(date: Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KOLKATA_TIME_ZONE,
    ...options,
  }).formatToParts(date);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value || "";
}

export function getKolkataDateString(date = new Date()): string {
  const parts = getParts(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return `${partValue(parts, "year")}-${partValue(parts, "month")}-${partValue(parts, "day")}`;
}

export function formatTxnDisplayId(txnDate?: string, txnNumber?: number): string {
  if (!txnDate || !txnNumber) return "";

  const [year, month, day] = txnDate.split("-");
  const datePart = `${day}/${month}/${year.slice(-2)}`;
  const seqPart = String(txnNumber).padStart(3, "0");
  return `${datePart}-${seqPart}`;
}

export { KOLKATA_TIME_ZONE };
