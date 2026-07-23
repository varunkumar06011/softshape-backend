// ─────────────────────────────────────────────────────────────────────────────
// ESC/POS Builders — Compatibility shim for @softshape/output
// ─────────────────────────────────────────────────────────────────────────────
// This file re-exports the shared renderer package functions with the original
// builder names and return types (object[] instead of RenderedOutput).
// Existing imports from "../utils/escpos" continue to work unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import {
  renderFoodKOT,
  renderLiquorKOT,
  renderFinalBill,
  renderBill,
  renderCancelKOT,
  renderTableSwap,
  renderXReport,
  renderExpenditure,
  renderReceipt,
  numberToWords,
} from "@softshape/output";
import type {
  PrintItem,
  OrderData,
  BillData,
  BillPrintRestaurant,
  BillPrintInput,
  CancelKotItem,
  CancelKotPrintInput,
  TableSwapPrintInput,
  ExpenditurePrintRestaurant,
  ExpenditurePrintData,
  XReportExpenditureRow,
  XReportData,
  RenderedOutput,
} from "@softshape/output";

function toBlocks(rendered: RenderedOutput): object[] {
  return rendered.blocks as unknown as object[];
}

export {
  type PrintItem,
  type OrderData,
  type BillData,
  type BillPrintRestaurant,
  type BillPrintInput,
  type CancelKotItem,
  type CancelKotPrintInput,
  type TableSwapPrintInput,
  type ExpenditurePrintRestaurant,
  type ExpenditurePrintData,
  type XReportExpenditureRow,
  type XReportData,
};

export function buildFoodKOT(orderData: OrderData): object[] {
  return toBlocks(renderFoodKOT(orderData));
}

export function buildLiquorKOT(orderData: OrderData): object[] {
  return toBlocks(renderLiquorKOT(orderData));
}

export function buildFinalBill(data: BillData): object[] {
  return toBlocks(renderFinalBill(data));
}

export function buildBill(input: BillPrintInput): object[] {
  return toBlocks(renderBill(input));
}

export function buildCancelKOT(input: CancelKotPrintInput): object[] {
  return toBlocks(renderCancelKOT(input));
}

export function buildTableSwap(input: TableSwapPrintInput): object[] {
  return toBlocks(renderTableSwap(input));
}

export function buildXReport(data: XReportData): object[] {
  return toBlocks(renderXReport(data));
}

export function buildExpenditure(data: ExpenditurePrintData): object[] {
  return toBlocks(renderExpenditure(data));
}

export function buildReceipt(
  orderData: OrderData,
  tax: { cgst: number; sgst: number; total: number },
): object[] {
  return toBlocks(renderReceipt(orderData, tax));
}

export { numberToWords };
