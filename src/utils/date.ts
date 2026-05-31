const KOLKATA_TIME_ZONE = "Asia/Kolkata";

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
