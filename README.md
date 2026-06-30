<div align="center">

<img src="https://img.shields.io/badge/SoftShape-Backend-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PHBhdGggZD0iTTEyIDZ2MTJsNi02Ii8+PC9zdmc+" alt="SoftShape Backend" />

# ⚡ SoftShape Backend API

**Multi-tenant Node.js API for the SoftShape restaurant POS ecosystem.**

[![Version](https://img.shields.io/badge/version-6.0.0-6366f1)](./package.json)
[![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql)](https://postgresql.org)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest)](./vitest.config.ts)
[![License](https://img.shields.io/badge/license-ISC-22c55e)](./package.json)

</div>

---

## 🚀 What is SoftShape Backend?

The **SoftShape Backend** is the engine room of the SoftShape restaurant operating system. It is a **multi-tenant REST API and Socket.IO server** that powers every portal, mobile app, and desktop client in the platform.

Built with **Node.js, Express, TypeScript, Prisma, and PostgreSQL**, it handles everything from restaurant onboarding and billing to real-time order events, inventory, payroll, and audit logging.

If you are looking for a **Prisma multi-tenant restaurant API**, a **Socket.IO order system**, or a reference backend for a modern POS, this repo is the place to start.

---

## ⚙️ How It Works

### Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│                        API Layer                             │
│  Express + Zod validation + tenant-scoped Prisma client      │
└──────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │   REST API  │    │  Socket.IO  │    │  Superadmin │
    │  /api/*     │    │  real-time  │    │  /api/superadmin  │
    └─────────────┘    └─────────────┘    └─────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
    ┌─────────────────────────────────────────────────────┐
    │                  Prisma ORM + PostgreSQL              │
    │   Redis (Socket.IO adapter + OTP cache)             │
    │   Razorpay · Resend · Firebase · Sentry · Cloudinary  │
    └─────────────────────────────────────────────────────┘
```

### Multi-tenant by default

Every restaurant is a separate tenant. Authentication middleware resolves the user and restaurant, and the tenant-scoped Prisma client automatically adds `restaurantId` filters to database queries. This prevents cross-tenant data leaks at the ORM layer.

### Real-time events

Socket.IO rooms are scoped per restaurant. Events like `order:created`, `table:updated`, and `print_job` are broadcast only to clients connected to the same restaurant. The backend supports Redis adapter scaling for horizontal deployments.

### Modular route structure

| Domain | Routes |
|--------|--------|
| Auth & users | `/api/auth`, `/api/verification` |
| Onboarding | `/api/onboard`, `/api/onboard/payment/*` |
| Restaurant & venues | `/api/restaurant`, `/api/venues`, `/api/sections` |
| Menu & inventory | `/api/menu`, `/api/inventory/*`, `/api/bar/menu` |
| Orders & billing | `/api/orders`, `/api/transactions`, `/api/vouchers` |
| Tables & captains | `/api/tables`, `/api/captain/*` |
| Reports & analytics | `/api/reports`, `/api/analytics`, `/api/stats` |
| Payroll & attendance | `/api/payroll`, `/api/attendance` |
| Printing | `/api/print` |
| Superadmin | `/api/superadmin/*` |

---

## ✨ Key Features

- **🔐 Multi-tenant auth** — JWT access tokens, refresh tokens, PIN login, and role-based access.
- **📱 Phone & email verification** — Firebase phone OTP and Resend email OTP with Redis-backed rate limiting.
- **💳 Payments** — Razorpay integration for onboarding with a mock gateway for dev/test.
- **🧾 Order lifecycle** — Create, edit, settle, print, and cancel orders with full audit trail.
- **🍳 KOT & print routing** — Generate ESC/POS receipts and KOTs, route to USB or network printers.
- **📊 Reports & analytics** — Sales, tax, item-wise, and inventory reports with date filtering.
- **📦 Inventory & recipes** — Stock tracking, recipe engine, and low-stock alerts.
- **💰 Payroll & attendance** — Staff shifts, attendance, and salary calculations.
- **🛡️ Superadmin dashboard** — Manage restaurants, plans, feature flags, announcements, and audit logs.
- **🔒 Security hardening** — Helmet, CORS, rate limiting, subscription checks, and tenant isolation.
- **📋 Automated backups** — Daily, weekly, and monthly PostgreSQL backups with optional S3 upload.

---

## 🐛 Bugs We Faced & Hardening We Added

The backend was battle-tested in production and hardened through several audits:

- **Unauthenticated routers** — Early versions of `/api/bar/menu` and `/api/print` were mounted without auth guards. We added `authenticate`, `assertTenantScope`, `assertSubscriptionActive`, and `withTenantContext` middleware chains to every tenant-facing route.
- **Razorpay webhook raw body bug** — The raw body middleware was being overwritten by `express.json()` for the same route, breaking HMAC signature verification. We reordered middleware to preserve the raw body for the webhook path.
- **Prisma tenant extension edge cases** — The tenant-scoped Prisma client incorrectly included `Restaurant` and non-existent models in its auto-filter list, causing query failures. We cleaned up the `modelsWithRestaurantId` set and ensured `basePrisma` is used for cross-tenant models like `OnboardingPayment`.
- **Schema probe `process.exit(1)` crash** — A missing non-critical column would block the entire server startup. We changed this to a warning plus a health-check flag so the server stays up.
- **Predictable reset tokens** — The forgot-password flow used `Math.random()` for tokens. We replaced it with `crypto.randomBytes` and `crypto.randomUUID`.
- **Concurrent onboarding collisions** — Restaurant code and slug allocation used non-cryptographic randomness and no transactions. We hardened the retry loop and wrapped creation in transactions where possible.
- **Orphan user records** — Onboarding cleanup only deleted restaurants on failure. We now track and roll back created users too.
- **Cross-tenant venue price upserts** — The upsert WHERE clause did not scope by `restaurantId`, risking data corruption. We tightened the query predicates.

---

## 🎯 Our Vision

> We want a backend that is **fast enough for a cashier under pressure, secure enough for multi-tenant SaaS, and simple enough to self-host** on a small VPS or deploy to Railway/Render.

Every route, every transaction, and every socket event should carry the tenant context explicitly. No accidental data leaks. No silent failures. No surprises at 1 PM on a Sunday lunch rush.

---

## 🛠️ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
cp .env.example .env
# Edit .env and set DATABASE_URL, DIRECT_URL, JWT_SECRET, and other required vars

# 3. Run Prisma migrations and generate client
npx prisma migrate dev
npx prisma generate

# 4. Seed sample data (optional)
npx prisma db seed

# 5. Start the dev server
npm run dev

# 6. Run tests
npm test
```

### Production deployment

```bash
# Build
npm run build

# Start
npm start

# Run migrations (production)
npx prisma migrate deploy
```

### Docker

```bash
docker build -t softshape-backend .
docker run -p 3000:3000 --env-file .env softshape-backend
```

For Railway, Render, or VPS deployment details, see [`docs/runbook.md`](./docs/runbook.md).

---

## 🧰 Environment Highlights

Required: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `SUPERADMIN_SECRET`  
Recommended: `REDIS_URL`, `RESEND_API_KEY`, `RAZORPAY_KEY_ID`, `SENTRY_DSN`, `CLOUDINARY_*`, `FIREBASE_*`

See [`.env.example`](./.env.example) for the full reference.

---

## 🔍 SEO Notes

This backend is designed for searches like **restaurant POS API**, **Prisma multi-tenant restaurant API**, **Socket.IO order system**, **Node.js POS backend**, **F&B management system API**, **offline-first POS backend**, and **restaurant billing API India**.

It is a practical, production-influenced reference for engineers building SaaS POS or F&B platforms.

---

## 📄 License

[ISC](./package.json) — SoftShape AI.