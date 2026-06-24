export interface PaymentOrderResult { gatewayOrderId: string; amount: number; currency: string; }
export interface PaymentVerifyResult { success: boolean; gatewayPaymentId?: string; reason?: string; }

export interface PaymentGateway {
  createOrder(params: { amount: number; currency: string; sessionId: string }): Promise<PaymentOrderResult>;
  verifyPayment(params: { gatewayOrderId: string; payload: any }): Promise<PaymentVerifyResult>;
}

export class MockPaymentGateway implements PaymentGateway {
  async createOrder({ amount, currency }: { amount: number; currency: string; sessionId: string }) {
    return {
      gatewayOrderId: `MOCK_ORDER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      amount,
      currency,
    };
  }
  async verifyPayment({ gatewayOrderId }: { gatewayOrderId: string; payload: any }) {
    return { success: true, gatewayPaymentId: `MOCK_PAY_${Date.now()}` };
  }
}

export function getPaymentGateway(): PaymentGateway {
  return new MockPaymentGateway();
}
