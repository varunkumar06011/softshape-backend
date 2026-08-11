// ─────────────────────────────────────────────────────────────────────────────
// Shared constants — single source of truth for magic values across the backend
// ─────────────────────────────────────────────────────────────────────────────

// Payment methods accepted by the system
export const PAYMENT_METHODS = ["CASH", "BANK", "UPI", "CHEQUE"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Daily purchase entry limits
export const MAX_ITEM_NAME = 2000;
export const MAX_DAILY_ROWS = 200;
export const NORMALIZED_NAME_MAX_LENGTH = 255;

// API / transaction timeouts (ms)
export const TX_TIMEOUT_MS = 30000;
export const TX_MAX_WAIT_MS = 35000;
export const VENDOR_PAYMENT_TX_TIMEOUT_MS = 15000;
export const VENDOR_PAYMENT_TX_MAX_WAIT_MS = 20000;
export const EXPENDITURE_TX_TIMEOUT_MS = 15000;
export const EXPENDITURE_TX_MAX_WAIT_MS = 20000;

// Frontend API fetch timeouts (ms)
export const API_TIMEOUT_SHORT_MS = 10000;
export const API_TIMEOUT_DEFAULT_MS = 20000;
export const API_TIMEOUT_SAVE_DAILY_MS = 60000;

// Ledger category system names
export const AP_CATEGORY_NAME = "Accounts Payable";
export const AP_CATEGORY_ENTRY_TYPE = "LIABILITY";

// Daily counter key for global (non-date-specific) counters
export const GLOBAL_COUNTER_DATE = "global";

// Expenditure statuses
export const EXPENDITURE_STATUS = {
  PENDING: "PENDING",
  UNVERIFIED: "UNVERIFIED",
  VERIFIED: "VERIFIED",
  VOIDED: "VOIDED",
} as const;

// Expenditure entry types
export const ENTRY_TYPE = {
  EXPENSE: "EXPENSE",
  LIABILITY: "LIABILITY",
  LIABILITY_PAYMENT: "LIABILITY_PAYMENT",
} as const;

// Purchase order statuses
export const PO_STATUS = {
  PENDING: "PENDING",
  DELIVERED: "DELIVERED",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
  CANCELLED: "CANCELLED",
} as const;

// Cash payment method (used for non-cash exclusion filters)
export const CASH_METHOD = "CASH";

// Balance sheet statuses
export const BALANCE_SHEET_STATUS = {
  DRAFT: "DRAFT",
  LOCKED: "LOCKED",
} as const;

// Audit log sources
export const AUDIT_SOURCE = {
  DAILY_PURCHASE: "DAILY_PURCHASE",
} as const;

// Paid-to types
export const PAID_TO_TYPE = {
  STAFF: "STAFF",
  VENDOR: "VENDOR",
  OTHER: "OTHER",
} as const;
