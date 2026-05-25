# Softshape Backend - Claude Code Guidelines

## Project Overview

Express.js + TypeScript + Prisma backend for Softshapeai restaurant management system. Provides REST API with real-time Socket.io updates for menu, orders, tables, and transactions. Supports dual-outlet (Restaurant + Bar) operations.

### Tech Stack
- **Runtime**: Node.js 20
- **Framework**: Express.js 5.1.0
- **Language**: TypeScript (ES2022, CommonJS)
- **Database**: PostgreSQL via Prisma 6.19.3
- **Real-Time**: Socket.io 4.8.3
- **Deployment**: Railway, Render (Docker-based)

## Architecture

### Directory Structure
```
src/
├── index.ts          # Entry point, Express app setup
├── socket.ts         # Socket.io singleton
├── seed.ts           # Auto-seeding logic
└── routes/
    ├── menu.ts       # Restaurant menu endpoints
    ├── orders.ts     # Order management
    ├── tables.ts     # Table management
    ├── sections.ts   # Section management
    ├── transactions.ts # Billing/transactions
    ├── barMenu.ts    # Bar menu endpoints
    └── barTables.ts  # Bar table endpoints

prisma/
├── schema.prisma     # Database schema
├── seed.ts           # Restaurant seed script
└── seedBar.ts        # Bar seed script
```

### Multi-Tenancy Model
- **Restaurant**: `restaurantId = "restaurant-001"`
- **Bar**: `restaurantId = "bar-001"`
- Tenant isolation via `restaurantId` query parameter
- No authentication - public API (internal use only)

### Database Models (Prisma)
```prisma
Category         # Menu categories
MenuItem         # Menu items (FOOD/LIQUOR)
MenuItemVariant  # Pricing variants (Half/Full, sizes)
MenuItemAddon    # Optional add-ons
Section          # Restaurant sections (Main Hall, Bar Hall)
Table            # Tables with status, session, KOT history
Order            # Orders with status, billing flags
OrderItem        # Individual order items
Transaction      # Completed payments with IST timestamps
```

## API Conventions

### Endpoint Pattern
All routes under `/api/*` prefix:

### REST Principles
- **GET**: Retrieve resources
- **POST**: Create resources
- **PATCH**: Partial update (status, items)
- **DELETE**: Remove resources

### Query Parameters
```
?restaurantId=restaurant-001   # Required for multi-tenancy
&status=PENDING                # Filter by status
&date=2024-05-24              # Filter by date (IST timezone)
&limit=50                      # Pagination limit
```

### Response Format
```typescript
// Success
{ data: [...] }
{ message: "Success" }

// Error
{ error: "Error message" }
```

### Status Codes
- `200`: Success
- `201`: Created
- `204`: No content
- `400`: Bad request (validation error)
- `404`: Not found
- `409`: Conflict
- `500`: Server error

## Key Endpoints

### Menu Routes (`/api/menu`)
```
GET  /api/menu/items?restaurantId=X
  → Returns flat list of available menu items

GET  /api/menu/pos-view?restaurantId=X
  → Returns hierarchical menu by categories

PATCH /api/menu/items/:id/availability
  Body: { available: boolean }
  → Toggle item availability
```

### Orders Routes (`/api/orders`)
```
POST /api/orders
  Body: { restaurantId, tableId, items: [{itemId, quantity, variantId?, addonIds?}] }
  → Create new order, update table status
  Socket: Emits 'order:created', 'table:updated'

GET /api/orders?restaurantId=X&status=PENDING
  → List orders, optionally filtered by status

GET /api/orders/table/:tableId
  → Get active order for specific table

PATCH /api/orders/:id/items
  Body: { items: [{itemId, quantity, ...}] }
  → Add items to existing order
  Socket: Emits 'order:updated'

PATCH /api/orders/:id/status
  Body: { status: 'PREPARING' | 'READY' | ... }
  → Update order status
  Socket: Emits 'order:updated'

POST /api/orders/:id/request-billing
  → Set billingRequested flag
  Socket: Emits 'billing:requested'

POST /api/orders/:id/pay
  → Mark order paid, clear table session
  Socket: Emits 'order:paid', 'table:updated'
```

### Tables Routes (`/api/tables`)
```
GET /api/tables?restaurantId=X
  → Get tables grouped by section (includes active orders)

GET /api/tables/flat?restaurantId=X
  → Get flat list of tables

GET /api/tables/sections?restaurantId=X
  → Get sections with table counts

POST /api/tables
  Body: { restaurantId, number, sectionId? }
  → Create new table
  Socket: Emits 'table:updated'

PATCH /api/tables/:id/status
  Body: { status: 'OCCUPIED' | 'AVAILABLE' | ... }
  → Update table status
  Socket: Emits 'table:updated'

PATCH /api/tables/:id/session
  Body: { sessionCaptain?, guestCount?, workflowStatus?, kotHistory? }
  → Update table session
  Socket: Emits 'table:updated'

DELETE /api/tables/:id
  → Delete table
  Socket: Emits 'table:deleted'
```

### Sections Routes (`/api/sections`)
```
GET /api/sections?restaurantId=X
  → List sections

POST /api/sections
  Body: { restaurantId, name, displayOrder? }
  → Create new section
```

### Transactions Routes (`/api/transactions`)
```
POST /api/transactions
  Body: {
    restaurantId, orderId, tableNumber,
    items: [{name, quantity, price}],
    subtotal, tax, totalAmount, paymentMethod
  }
  → Save completed transaction with IST timestamp

GET /api/transactions?restaurantId=X&limit=50&date=2024-05-24
  → Fetch transactions (IST timezone filtering)
```

### Bar Routes (`/api/bar/*`)
Same endpoints as above but hardcoded to `restaurantId=bar-001`:
- `/api/bar/menu/*`
- `/api/bar/tables/*`

## Data Models & Enums

### Status Enums
```typescript
enum TableStatus {
  AVAILABLE, OCCUPIED, BILLING_REQUESTED, RESERVED, CLEANING
}

enum OrderStatus {
  PENDING, CONFIRMED, PREPARING, READY,
  BILLING_REQUESTED, PAID, CANCELLED
}

enum MenuType {
  FOOD,    // Restaurant menu
  LIQUOR   // Bar menu
}
```

### Workflow Status (String)
```typescript
type WorkflowStatus =
  | "Free"
  | "Occupied"
  | "Preparing"
  | "Ready"
  | "Waiting Bill"
  | "Reserved"
  | "Cleaning"
```

### Table Model
```typescript
{
  id: string,
  number: string,              // "T1", "B5"
  status: TableStatus,
  workflowStatus: string,      // WorkflowStatus
  sessionCaptain: string?,     // Captain name
  guestCount: number,
  sessionStartedAt: Date?,
  kotHistory: Json,            // Array of KOT entries
  restaurantId: string,
  sectionId: string?,
  activeOrder?: Order          // Included in queries
}
```

### Order Model
```typescript
{
  id: string,
  tableId: string,
  items: OrderItem[],
  status: OrderStatus,
  totalAmount: number,
  billingRequested: boolean,
  paidAt: Date?,
  createdAt: Date,
  restaurantId: string
}
```

### Transaction Model
```typescript
{
  id: string,
  orderId: string?,
  restaurantId: string,
  tableNumber: string,
  items: Json,                 // Array of { name, quantity, price }
  subtotal: number,
  tax: number,
  totalAmount: number,
  paymentMethod: string,       // "CASH", "UPI", "CARD"
  paidAt: Date,               // IST timezone
  createdAt: Date
}
```

## Socket.io Real-Time

### Configuration
```typescript
io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
  path: "/socket.io",
  addTrailingSlash: false,
  transports: ["polling", "websocket"],  // Polling first for Railway
  allowUpgrades: true,
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  httpCompression: true
});
```

### Client Events (Listen)
```typescript
socket.on('join', (restaurantId) => {
  socket.join(restaurantId);
});

socket.on('disconnect', () => {
  // Auto cleanup
});
```

### Server Events (Emit)
Broadcast to room (`restaurantId`):
```typescript
io.to(restaurantId).emit('order:created', order);
io.to(restaurantId).emit('order:updated', order);
io.to(restaurantId).emit('order:paid', orderId);
io.to(restaurantId).emit('billing:requested', orderId);
io.to(restaurantId).emit('table:updated', table);
io.to(restaurantId).emit('table:deleted', tableId);
```

### Socket Singleton Pattern
```typescript
import { getIo } from './socket';

// In route handler
const io = getIo();
io.to(restaurantId).emit('event', data);
```

## Database (Prisma)

### Connection Setup
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")      # Pooled (Supabase)
  directUrl = env("DIRECT_URL")       # Direct (migrations)
}
```

### Prisma Client Pattern
```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Use in route handlers
const items = await prisma.menuItem.findMany({
  where: { restaurantId, available: true }
});
```

**⚠️ Current Issue**: Each route file creates new PrismaClient instance.
**TODO**: Refactor to use singleton pattern to avoid connection pool exhaustion.

### Transactions
Use `prisma.$transaction()` for atomic operations:
```typescript
await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: orderData });
  await tx.table.update({
    where: { id: tableId },
    data: { status: 'OCCUPIED' }
  });
});
```

### JSON Fields
```typescript
// KOT History (on Table)
kotHistory: {
  type: 'array',
  items: {
    items: [...],
    timestamp: '2024-05-24T10:30:00Z'
  }
}

// Transaction Items
items: {
  type: 'array',
  items: {
    name: string,
    quantity: number,
    price: number
  }
}
```

### Indexes
```prisma
@@index([restaurantId])
@@index([status])
@@index([tableId])
@@index([paidAt])
```

## Error Handling

### Route-Level
```typescript
try {
  // Logic
} catch (error) {
  console.error('[Error]', error.message);
  res.status(500).json({ error: error.message });
}
```

### Global Error Handler
```typescript
app.use((err: Error, _req, res, next) => {
  console.error("[Error]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});
```

### Validation Errors
```typescript
if (!items || items.length === 0) {
  return res.status(400).json({
    error: 'Items array is required'
  });
}
```

### Process-Level
```typescript
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
```

## Middleware

### Applied Middleware (Order)
1. **CORS** - Custom origin validator
2. **express.json()** - JSON body parser
3. **Route handlers**
4. **Global error handler**

### CORS Configuration
```typescript
// Allowed origins (whitelist + dynamic Vercel)
const allowedOrigins = [
  'https://softshapeai.vercel.app',
  'https://softshape.ai',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  // + All *.vercel.app domains
];

cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
});
```

### Cache Control
Set `Cache-Control: no-store` on real-time endpoints:
```typescript
res.setHeader('Cache-Control', 'no-store');
```

### No Authentication
**Current**: No auth middleware
**Recommendation**: Add JWT validation before production

## Auto-Seeding

### On Startup
`autoSeedIfEmpty()` runs automatically:
1. Checks if menu items exist for restaurant
2. If empty:
   - Creates "Main Hall" section
   - Creates 20 tables (T1-T20)
   - Parses `menu.txt` file
   - Seeds categories + menu items
   - Creates "Regular" variant for each item

### Manual Seeding
```bash
# Restaurant menu
npm run prisma:migrate
npx prisma db seed

# Bar menu
npm run seed:bar
```

### Seed Files
- `prisma/seed.ts` - Restaurant menu (FOOD)
- `prisma/seedBar.ts` - Bar menu (LIQUOR)
- `menu.txt` - Menu data file (gitignored)

## Deployment

### Supported Platforms
1. **Railway** (primary, Docker-based)
2. **Render** (Docker-based)
3. **Generic Docker**

### Build Process
```bash
# Install dependencies
npm ci

# Generate Prisma client
npx prisma generate

# Compile TypeScript
npx tsc

# Output: dist/
```

### Startup Process
```bash
# 1. Run migrations
npx prisma migrate deploy

# 2. Start server
node dist/index.js
```

### Railway Configuration (`railway.json`)
```json
{
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "startCommand": "sh -c 'npx prisma migrate deploy && node dist/index.js'",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

### Dockerfile
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
COPY menu.txt ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```

### Health Check
```typescript
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});
```

## Environment Variables

### Required
```bash
DATABASE_URL=postgresql://user:password@host:5432/db?pgbouncer=true
DIRECT_URL=postgresql://user:password@host:5432/db
PORT=3000  # Auto-set by Railway/Render
NODE_ENV=production
```

### Optional
```bash
CORS_ORIGIN=https://example.com,https://app.example.com
ALLOWED_ORIGINS=https://example.com  # Alternative env var
```

### Loading
```typescript
import 'dotenv/config';

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
```

## Cross-Repo Conventions (Backend ↔ Frontend)

### Frontend Repository
**Location**: `/workspace/.../Softshapeai`

### API Contract
Frontend expects these response formats:

```typescript
// Menu Items (flat list)
GET /api/menu/items?restaurantId=X
→ Array<{
  id: string,
  name: string,
  price: number,
  category: string,
  type: 'VEG' | 'NON_VEG' | 'VEGAN',
  menuType: 'FOOD' | 'LIQUOR',
  available: boolean,
  variants: Array<{ id, name, price }>,
  addons: Array<{ id, name, price }>
}>

// Tables (grouped by section)
GET /api/tables?restaurantId=X
→ Array<{
  section: { id, name },
  tables: Array<{
    id, number, status, workflowStatus,
    sessionCaptain, guestCount,
    activeOrder?: Order
  }>
}>
```

### Frontend Abbreviations
Frontend stores menu items with abbreviated keys:
- `n` → name
- `p` → price
- `c` → category

Backend always uses full property names. Frontend handles mapping.

### Socket.io Rooms
Frontend joins room on mount:
```typescript
socket.emit('join', restaurantId);
```

Backend broadcasts to room:
```typescript
io.to(restaurantId).emit('order:created', order);
```

## Code Quality

### TypeScript
```typescript
// ✅ Use strict types
interface CreateOrderDto {
  restaurantId: string;
  tableId: string;
  items: Array<{
    itemId: string;
    quantity: number;
    variantId?: string;
  }>;
}

// ❌ Avoid 'any'
const data: any = req.body;
```

### Error Handling
```typescript
// ✅ Always try-catch async routes
app.get('/route', async (req, res) => {
  try {
    const data = await prisma.model.findMany();
    res.json(data);
  } catch (error) {
    console.error('[Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});
```

### Logging
```typescript
// ✅ Use descriptive logs
console.log('[Orders] Creating order for table', tableId);
console.error('[Orders] Failed to create order:', error.message);

// ❌ Avoid generic logs
console.log('data', data);
```

### No Linting
**Current**: No ESLint/Prettier
**TODO**: Add linting configuration

## Testing

### Currently: No Tests
**Recommendation**: Add Jest + Supertest for API testing

### Future Test Structure
```
tests/
├── menu.test.ts
├── orders.test.ts
├── tables.test.ts
└── socket.test.ts
```

## Security

### Current State
- ❌ No authentication
- ❌ No rate limiting
- ❌ No input sanitization beyond type checks
- ✅ SQL injection protected (Prisma ORM)
- ✅ CORS whitelist

### Production Recommendations
1. Add JWT authentication
2. Implement rate limiting (express-rate-limit)
3. Add input validation (Zod, Joi)
4. Enable Helmet.js for security headers
5. Use HTTPS only
6. Rotate DATABASE_URL regularly

## Performance

### Optimization Tips
```typescript
// ✅ Use select to limit returned fields
const items = await prisma.menuItem.findMany({
  select: { id: true, name: true, price: true }
});

// ✅ Use pagination
const orders = await prisma.order.findMany({
  skip: offset,
  take: limit
});

// ✅ Create indexes for frequent queries
@@index([restaurantId, status])
```

### Caching Strategy
**Current**: No caching
**Recommendation**: Add Redis for menu cache (rarely changes)

### Connection Pooling
**Current**: Prisma handles pooling
**Issue**: Multiple PrismaClient instances
**Fix**: Use singleton pattern

## Don't Do

### Never Commit
- `.env` files
- `node_modules/`
- `dist/` build output
- `menu.txt` (contains seed data)
- Database credentials

### Never Use
- `console.log` without context (use `[Module] Message`)
- Synchronous blocking operations
- Direct SQL queries (use Prisma)

### Never Modify
- `prisma/migrations/` manually (use `prisma migrate`)
- `package-lock.json` manually

## Debugging

### Common Issues

**1. Socket.io not connecting**
- Check CORS origins match frontend URL
- Verify transport order: `["polling", "websocket"]`
- Check Railway proxy settings

**2. Database connection errors**
- Verify `DATABASE_URL` and `DIRECT_URL` are set
- Check Supabase connection pooling settings
- Run `npx prisma generate`

**3. Auto-seed failing**
- Check `menu.txt` exists and is readable
- Verify Prisma schema matches migrations
- Check console for error messages

## Getting Started

### First-Time Setup
```bash
# 1. Clone repository
git clone <repo-url>
cd softshape-backend

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env  # If exists
# Edit .env and set DATABASE_URL, DIRECT_URL

# 4. Run migrations
npx prisma migrate dev

# 5. Generate Prisma client
npx prisma generate

# 6. Seed database (optional)
npx prisma db seed

# 7. Start development server
npm run dev

# Server runs on http://localhost:3000
```

### Development Workflow
```bash
# Make schema changes
nano prisma/schema.prisma

# Create migration
npx prisma migrate dev --name add_new_field

# Regenerate client
npx prisma generate

# Restart server
npm run dev
```

## Scripts

```json
{
  "dev": "ts-node src/index.ts",
  "build": "prisma generate && tsc",
  "start": "node dist/index.js",
  "railway:start": "sh scripts/start.sh",
  "postinstall": "prisma generate",
  "prisma:migrate": "npx prisma migrate deploy",
  "seed:bar": "npx tsx prisma/seedBar.ts"
}
```

## Contact & Support

**Repository Owner**: varunkumar06011
**Collaborators**: Akhil14324

For architecture questions, refer to this document first.
For production deployment, ensure authentication is added.

---

## Version History

- **v1.0.0** (2024-05-24): Initial CLAUDE.md created by Claude Code
  - Comprehensive backend guidelines
  - Cross-repo conventions documented
  - Socket.io patterns defined

---

**Remember**: This backend is optimized for Railway deployment with Socket.io real-time updates. Always use transactions for order+table updates. Emit socket events after database changes. Test both restaurant and bar endpoints before deploying.
