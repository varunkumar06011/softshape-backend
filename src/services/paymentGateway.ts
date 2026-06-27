import crypto from 'crypto';
import Razorpay from 'razorpay';

export interface PaymentOrderResult { gatewayOrderId: string; amount: number; currency: string; }
export interface PaymentVerifyResult { success: boolean; gatewayPaymentId?: string; reason?: string; }

export interface PaymentGateway {
  createOrder(params: { amount: number; currency: string; sessionId: string }): Promise<PaymentOrderResult>;
  verifyPayment(params: { gatewayOrderId: string; payload: any }): Promise<PaymentVerifyResult>;
}

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
  return new MockPaymentGateway();
}
