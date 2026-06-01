# AGENTS.md

# Softshape Backend - AI Agent Rules

This repository contains the backend for the Softshape POS SaaS platform.

Tech Stack:

* Node.js
* Express
* Prisma
* PostgreSQL
* Socket.io

This backend handles:

* restaurant operations
* transactions
* billing
* KOT workflows
* inventory
* realtime synchronization
* authentication
* analytics

This is production-sensitive infrastructure.
The backend is on https://softshape-backend.onrender.com, always clone https://github.com/varunkumar06011/Softshapeai for frontend repo
---

# 1. CRITICAL GIT RULES

## NEVER FORCE PUSH

NEVER RUN:

```bash id="yc9wlf"
git push --force
git push -f
```

Do not rewrite repository history.

Always use feature branches.

---

## BRANCH NAMING

Use:

```txt id="prl3m6"
feature/<name>
fix/<name>
refactor/<name>
hotfix/<name>
```

Examples:

```txt id="lkwxtu"
feature/rate-limiting
fix/prisma-relations
refactor/error-handler
```

---

# 2. DATABASE SAFETY RULES

The database contains:

* transaction history
* billing data
* restaurant sessions
* inventory
* financial workflows

NEVER:

* truncate production tables
* auto-run cleanup scripts
* reset transactions silently
* modify migration history carelessly

Dangerous scripts:

* clearTransactions
* resetRestaurant
* cleanup scripts

must NEVER execute automatically in production.

---

# 3. PRISMA RULES

After schema changes ALWAYS run:

```bash id="pq4ogx"
npx prisma generate
```

Use migrations properly:

```bash id="vgzjlwm"
npx prisma migrate dev
```

DO NOT:

* edit old migrations
* modify generated Prisma files
* rewrite migration history
* bypass schema validation

---

# 4. AUTHENTICATION RULES

Authentication is critical.

NEVER:

* trust frontend role checks
* expose secrets
* store plaintext passwords
* bypass middleware validation

ALWAYS:

* validate JWTs server-side
* verify restaurant ownership
* verify permissions per request
* hash passwords securely

---

# 5. API SECURITY RULES

Mandatory middleware:

* helmet
* express-rate-limit
* CORS restrictions
* centralized error handling

Never expose:

* stack traces
* raw SQL errors
* Prisma internals

---

# 6. VALIDATION RULES

All routes must validate:

* IDs
* quantities
* prices
* payment values
* dates
* role values

Never trust client payloads.

Reject malformed requests safely.

---

# 7. TRANSACTION LOGIC RULES

Transaction logic is business-critical.

Changes affecting:

* billing
* KOTs
* orders
* payments
* table lifecycle
* session closure

must preserve:

* financial integrity
* reporting accuracy
* inventory consistency

Never assume:

```txt id="x1zwqs"
table cleared = transaction completed
```

without explicit verification.

---

# 8. SOCKET.IO RULES

Realtime events must:

* avoid duplicate emissions
* cleanup disconnected clients
* support reconnect handling
* prevent stale state

Do not emit excessive events.

Avoid socket memory leaks.

---

# 9. ERROR HANDLING RULES

Centralized error handling is mandatory.

Never silently ignore errors.

BAD:

```js id="m2y3p9"
catch (e) {}
```

GOOD:

```js id="s7krjq"
catch (e) {
  logger.error(e);
  next(e);
}
```

All async routes must handle failures safely.

---

# 10. LOGGING RULES

Use structured logging.

Log:

* authentication failures
* payment failures
* database failures
* printer-related failures
* socket disconnects
* server crashes

Never log:

* passwords
* JWT secrets
* sensitive user data

---

# 11. ENVIRONMENT VARIABLES

Never hardcode:

* database URLs
* JWT secrets
* API keys
* cloud credentials

Maintain:

```txt id="cf2j2t"
.env.example
```

Required examples:

```env id="m14j34"
DATABASE_URL=
JWT_SECRET=
PORT=
FRONTEND_URL=
```

---

# 12. DEPLOYMENT RULES

Before deployment ALWAYS verify:

```bash id="98g1gf"
npm install
npx prisma generate
npm run build
```

Never deploy if:

* migrations fail
* Prisma generation fails
* environment variables are missing
* sockets fail initialization

---

# 13. API RESPONSE RULES

Use consistent responses.

Success:

```json id="qv0h7i"
{
  "success": true,
  "data": {}
}
```

Failure:

```json id="mqj5to"
{
  "success": false,
  "message": "Error message"
}
```

Avoid inconsistent structures.

---

# 14. AI AGENT RESTRICTIONS

AI agents must NEVER:

* rewrite auth blindly
* modify financial calculations carelessly
* delete "unused" workflow code without verification
* remove socket logic aggressively
* alter migrations recklessly

Preserve operational integrity.

---

# 15. REQUIRED TESTING

After backend changes verify:

* authentication
* role validation
* transactions
* table lifecycle
* concurrent orders
* socket sync
* reconnect handling
* printer-related flows
* inventory updates

---

# 16. HUMAN REVIEW REQUIRED

Mandatory human approval before merging changes affecting:

* billing
* transactions
* authentication
* migrations
* payment calculations
* inventory deductions

---

# 17. FINAL RULE

When uncertain:

* preserve existing behavior
* avoid destructive changes
* prioritize data safety

This backend supports real operational workflows.

A small backend mistake can become:

* financial inconsistencies
* lost orders
* duplicate bills
* broken inventory
* production outages
* corrupted transaction history
