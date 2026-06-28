// ─────────────────────────────────────────────────────────────────────────────
// Payment Gateway Service — Abstraction layer for payment processing
// ─────────────────────────────────────────────────────────────────────────────
// Provides a unified interface for creating and verifying payments.
// Currently supports Razorpay as the production gateway, with a MockPaymentGateway
// for development/testing environments.
//
// The factory function getPaymentGateway() returns the appropriate implementation
// based on environment variables (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET).
// If neither is set, returns MockPaymentGateway (auto-approves all payments).
//
// Interface:
//   createOrder({ amount, currency, sessionId }) → { gatewayOrderId, amount, currency }
//   verifyPayment({ gatewayOrderId, payload }) → { success, gatewayPaymentId?, reason? }
//
// Razorpay signature verification uses HMAC-SHA256 with the key secret.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import Razorpay from 'razorpay';

// Result of creating a payment order
export interface PaymentOrderResult { gatewayOrderId: string; amount: number; currency: string; }
// Result of verifying a payment
export interface PaymentVerifyResult { success: boolean; gatewayPaymentId?: string; reason?: string; }

// Unified payment gateway interface — implementations must provide both methods
export interface PaymentGateway {
  createOrder(params: { amount: number; currency: string; sessionId: string }): Promise<PaymentOrderResult>;
  verifyPayment(params: { gatewayOrderId: string; payload: any }): Promise<PaymentVerifyResult>;
}

// Mock payment gateway for development — auto-approves all payments
export class MockPaymentGateway implements PaymentGateway {
  async createOrder({ amount, currency }: { amount: number; currency: string; sessionId: string }): Promise<PaymentOrderResult> {
    return {
      gatewayOrderId: `MOCK_ORDER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      amount,
      currency,
    };
  }
  async verifyPayment({ gatewayOrderId }: { gatewayOrderId: string; payload: any }): Promise<PaymentVerifyResult> {
    return { success: true, gatewayPaymentId: `MOCK_PAY_${Date.now()}` };
  }
}

export class RazorpayGateway implements PaymentGateway {
  private client: Razorpay;

  constructor() {
    this.client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
  }

  async createOrder({ amount, currency, sessionId }: { amount: number; currency: string; sessionId: string }) {
    const order = await this.client.orders.create({
      amount: Math.round(amount * 100), // Razorpay works in paise
      currency,
      receipt: sessionId.slice(0, 40),
    });
    return {
      gatewayOrderId: order.id,
      amount,
      currency,
    };
  }

  async verifyPayment({ gatewayOrderId, payload }: { gatewayOrderId: string; payload: any }) {
    const { razorpay_payment_id, razorpay_signature } = payload;
    const body = gatewayOrderId + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return { success: false, reason: 'Signature mismatch' };
    }
    return { success: true, gatewayPaymentId: razorpay_payment_id };
  }
}

export function getPaymentGateway(): PaymentGateway {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    return new RazorpayGateway();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Payment] RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set in production — mock payments are disabled');
  }
  return new MockPaymentGateway();
}
