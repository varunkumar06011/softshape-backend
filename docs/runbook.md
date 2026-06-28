# SoftShape AI — Operations Runbook

## Table of Contents
1. [Backup Strategy](#1-backup-strategy)
2. [Restore Procedure](#2-restore-procedure)
3. [Deployment](#3-deployment)
4. [Superadmin Dashboard](#4-superadmin-dashboard)
5. [Incident Response](#5-incident-response)
6. [Common Operations](#6-common-operations)
7. [Environment Variables Reference](#7-environment-variables-reference)

---

## 1. Backup Strategy

### Schedule
| Type | Frequency | Retention | Cron |
|------|-----------|-----------|------|
| Daily | 2:00 AM IST | 7 days | `30 20 * * *` |
| Weekly | Sunday 3:00 AM IST | 4 weeks | `30 21 * * 6` |
| Monthly | 1st 4:00 AM IST | 12 months | `30 22 1 * *` |

### Setup
```bash
# 1. Ensure pg_dump is available (PostgreSQL client tools)
which pg_dump || apt-get install -y postgresql-client

# 2. (Optional) Install AWS CLI for S3 uploads
pip install awscli
aws configure  # set credentials

# 3. Add backup env vars to .env
echo 'S3_BACKUP_BUCKET=my-backup-bucket' >> .env
echo 'BACKUP_WEBHOOK_URL=https://hooks.slack.com/...' >> .env

# 4. Install cron schedule
crontab scripts/backup-cron

# 5. Test manually
bash scripts/backup.sh
bash scripts/backup.sh --weekly
```

### Backup Storage
- **Local**: `./backups/` directory (cleaned up by retention policy)
- **S3** (optional): `s3://$S3_BACKUP_BUCKET/backups/` (lifecycle policy recommended)
- **S3 Lifecycle**: Transition to Glacier after 30 days, delete after 365 days

### Monitoring
- Check `/var/log/softshape-backup.log` for cron output
- Failures send to `BACKUP_WEBHOOK_URL` (Slack-compatible webhook)
- Superadmin dashboard: `GET /api/superadmin/health` shows DB connectivity

### Verifying Backups
```bash
# List recent backups
ls -lt backups/

# Verify gzip integrity
gzip -t backups/softshape_daily_20260628_020000.sql.gz

# Inspect contents without restoring
gunzip -c backups/softshape_daily_20260628_020000.sql.gz | pg_restore --list | head -50
```

---

## 2. Restore Procedure

### When to Restore
- Database corruption
- Accidental data deletion
- Disaster recovery
- Migration rollback

### Steps
```bash
# 1. Stop the backend server
#    (Railway: Settings > Deployments > Stop)
#    (Docker: docker stop softshape-backend)

# 2. Run the restore script
bash scripts/restore.sh backups/softshape_daily_20260628_020000.sql.gz
#    Type CONFIRM when prompted

# 3. Run migrations to ensure schema is up to date
npx prisma migrate deploy

# 4. Restart the backend server
#    (Railway: Settings > Deployments > Deploy)
#    (Docker: docker start softshape-backend)

# 5. Verify
curl http://localhost:3000/api/health
curl -H "x-superadmin-secret: $SUPERADMIN_SECRET" http://localhost:3000/api/superadmin/health
```

### Rollback (Pre-Restore Backup)
The restore script automatically creates a pre-restore backup at
`backups/softshape_prerestore_<timestamp>.sql.gz`. If the restore causes issues,
restore from that file instead.

---

## 3. Deployment

### Railway (Primary)
```bash
# Railway auto-deploys on git push to main branch
git push origin main

# Manual deploy via CLI
railway up

# Run migrations after deploy
railway run npx prisma migrate deploy
```

### Docker
```bash
# Build
docker build -t softshape-backend .

# Run
docker run -p 3000:3000 --env-file .env softshape-backend
```

### Post-Deploy Checklist
- [ ] `GET /api/health` returns 200
- [ ] `GET /api/superadmin/health` returns DB + Redis status
- [ ] Sentry events flowing (check Sentry dashboard)
- [ ] Socket.IO connections working (test in frontend)
- [ ] Backup cron still installed (`crontab -l | grep backup`)

---

## 4. Superadmin Dashboard

### Access
- **URL**: `http://localhost:5174` (dev) or deployed URL
- **Auth**: SuperAdmin secret stored in localStorage, sent as `x-superadmin-secret` header
- **Backend**: All routes under `/api/superadmin/*` (no JWT auth, uses secret only)

### Frontend Dev Server
```bash
cd Softshapeai/apps/superadmin
npm install
npm run dev  # starts on port 5174
```

### Frontend Build
```bash
cd Softshapeai/apps/superadmin
npm run build  # outputs to dist/
```

### Key Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/superadmin/stats` | GET | Platform-wide stats |
| `/api/superadmin/restaurants` | GET | List all restaurants |
| `/api/superadmin/restaurants/:id` | GET | Restaurant detail |
| `/api/superadmin/restaurants/:id/suspend` | PATCH | Suspend org |
| `/api/superadmin/restaurants/:id/activate` | PATCH | Activate org |
| `/api/superadmin/restaurants/:id/extend-trial` | PATCH | Extend trial |
| `/api/superadmin/restaurants/:id/change-plan` | PATCH | Change plan |
| `/api/superadmin/plans` | GET/POST | List/create plan configs |
| `/api/superadmin/plans/:planId` | PATCH | Update plan config |
| `/api/superadmin/feature-flags` | GET/POST | List/create feature flags |
| `/api/superadmin/feature-flags/:id` | PATCH | Update feature flag |
| `/api/superadmin/announcements` | GET/POST | List/create announcements |
| `/api/superadmin/announcements/:id` | PATCH | Update announcement |
| `/api/superadmin/payments` | GET | List payments (paginated) |
| `/api/superadmin/revenue/monthly` | GET | Monthly revenue chart |
| `/api/superadmin/audit-logs` | GET | Audit logs (paginated) |
| `/api/superadmin/health` | GET | System health check |

### Public Endpoints (no auth required)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/announcements` | GET | Active announcements for outlet |
| `/api/feature-flags/:key` | GET | Feature flag status for outlet |

---

## 5. Incident Response

### Database Down
1. Check `GET /api/health` — if 500, DB is unreachable
2. Check Railway/Render dashboard for DB status
3. If DB deleted/corrupted: restore from latest backup (Section 2)
4. Notify via Slack: `#incidents` channel

### Redis Down
1. Check `GET /api/superadmin/health` — Redis status
2. Socket.IO scaling and OTP caching will degrade
3. App continues to function (Redis is optional)
4. Restart Redis instance or clear connection pool

### High Error Rate
1. Check Sentry dashboard for error spike
2. Filter by `restaurantId` tag to find affected tenant
3. Check `GET /api/superadmin/audit-logs?action=SUPERADMIN` for recent admin actions
4. If caused by bad migration: `npx prisma migrate resolve --rolled-back <migration>`

### Tenant Data Leak Suspected
1. Check audit logs: `GET /api/superadmin/audit-logs?restaurantId=<id>`
2. Review Sentry breadcrumbs for cross-tenant requests
3. All tenant-scoped routes use `authenticate` + `assertTenantScope` + `withTenantContext`
4. Run tenant isolation tests: `npx vitest run src/routes/__tests__/tenant-isolation.test.ts`

### Suspend a Tenant
```bash
curl -X PATCH \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  https://api.softshape.ai/api/superadmin/restaurants/<outlet-id>/suspend
```

### Activate a Tenant
```bash
curl -X PATCH \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  https://api.softshape.ai/api/superadmin/restaurants/<outlet-id>/activate
```

---

## 6. Common Operations

### Run a Migration
```bash
# Local dev
npx prisma migrate dev --name <description>

# Production (deploy only, no interactive prompts)
npx prisma migrate deploy
```

### Create a New Feature Flag
```bash
curl -X POST \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"key":"new_feature","description":"New feature toggle","enabledGlobally":false}' \
  https://api.softshape.ai/api/superadmin/feature-flags
```

### Enable Feature Flag for a Restaurant
```bash
curl -X PATCH \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabledRestaurants":["<outlet-id>"]}' \
  https://api.softshape.ai/api/superadmin/feature-flags/<flag-id>
```

### Create an Announcement
```bash
curl -X POST \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Scheduled Maintenance","body":"System will be down 2-4 AM","type":"warning","target":"all"}' \
  https://api.softshape.ai/api/superadmin/announcements
```

### Update Plan Pricing
```bash
curl -X PATCH \
  -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"basePrice":1499,"perExtraOutletPrice":699}' \
  https://api.softshape.ai/api/superadmin/plans/pro
```

### View Audit Logs
```bash
curl -H "x-superadmin-secret: $SUPERADMIN_SECRET" \
  "https://api.softshape.ai/api/superadmin/audit-logs?page=1&action=SUPERADMIN&limit=50"
```

---

## 7. Environment Variables Reference

### Required
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (pooled) |
| `DIRECT_URL` | PostgreSQL connection string (non-pooled, for migrations) |
| `JWT_SECRET` | JWT signing secret (32+ chars) |
| `SUPERADMIN_SECRET` | SuperAdmin API secret |

### Optional
| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis URL for Socket.IO adapter + OTP cache |
| `SENTRY_DSN` | Sentry error tracking DSN |
| `S3_BACKUP_BUCKET` | S3 bucket for offsite backups |
| `BACKUP_WEBHOOK_URL` | Slack webhook for backup failure alerts |
| `BACKUP_RETENTION_DAILY` | Days to keep daily backups (default: 7) |
| `RAZORPAY_KEY_ID` | Razorpay payment gateway key |
| `RAZORPAY_KEY_SECRET` | Razorpay payment gateway secret |
| `RESEND_API_KEY` | Resend email API key |
| `GROQ_API_KEY` | Groq AI API key for PDF parsing |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for image uploads |
