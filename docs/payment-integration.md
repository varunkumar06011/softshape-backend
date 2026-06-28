# Payment Integration Split

## Overview

The Softshape platform uses a gateway-agnostic payment architecture for onboarding.
Payments are handled by a pluggable `PaymentGateway` interface, with Razorpay as the
production gateway and a Mock gateway for development/testing.

## Architecture

### PaymentGateway Interface (`src/services/paymentGateway.ts`)

```typescript
interface PaymentGateway {
  createOrder(params: { amount: number; currency: string; sessionId: string }): Promise<PaymentOrderResult>;
  verifyPayment(params: { gatewayOrderId: string; payload: any }): Promise<PaymentVerifyResult>;
}
```

### Gateways

1. **RazorpayGateway** — Production gateway. Requires `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
   - Creates Razorpay orders via their REST API
   - Verifies payments via signature validation (`HMAC-SHA256`)

2. **MockPaymentGateway** — Development only. Instantly succeeds without external calls.
   - **Production guard**: `getPaymentGateway()` throws in `NODE_ENV=production` if Razorpay keys are missing.

### OnboardingPayment Model (`prisma/schema.prisma`)

Gateway-agnostic audit trail for each onboarding payment:

| Field             | Description                                      |
|-------------------|--------------------------------------------------|
| `sessionId`       | Client-generated UUID for the wizard session     |
| `restaurantId`    | Backfilled after outlet creation                 |
| `gateway`         | `"MOCK"` \| `"RAZORPAY"`                         |
| `gatewayOrderId`  | Order ID from the gateway                        |
| `gatewayPaymentId`| Payment ID from the gateway (on success)         |
| `status`          | `"CREATED"` → `"SUCCESS"` \| `"FAILED"`          |

## Flow

1. **Onboarding wizard** calls `POST /api/onboard/payment/mock` (dev) or
   `POST /api/onboard/payment/razorpay/create-order` (prod) to create a payment intent.
2. User completes payment on the frontend (Razorpay checkout SDK or mock auto-settle).
3. Frontend calls `POST /api/onboard/payment/razorpay/verify` to verify the payment.
4. On success, an `OnboardingPayment` row is created with `status: "SUCCESS"`.
5. The onboarding completion endpoint (`POST /api/onboard`) validates the payment reference
   before creating any tenant data.

## Environment Variables

| Variable                | Required in Prod | Description                        |
|-------------------------|------------------|------------------------------------|
| `RAZORPAY_KEY_ID`       | Yes              | Razorpay API key                   |
| `RAZORPAY_KEY_SECRET`   | Yes              | Razorpay API secret                |
| `NODE_ENV`              | Yes              | Must be `production` in prod       |

## Security Notes

- Mock payments are disabled in production via a runtime guard in `getPaymentGateway()`.
- The onboarding endpoint validates `payment.status === 'SUCCESS'` and `payment.plan === data.plan`
  before proceeding.
- An idempotency guard prevents re-using a payment reference that already has a linked `restaurantId`.
- A Redis lock prevents concurrent duplicate submissions with the same payment reference.
