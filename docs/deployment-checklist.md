# HypeRadar — Production Deployment Checklist

## 1. Supabase — Database Setup

### Create project
1. Go to supabase.com → New Project
2. Name: `hyperadar-production`
3. Region: choose closest to your Railway region
4. Copy the database password somewhere safe

### Run migrations (in order)
Run these in the Supabase SQL Editor:

```sql
-- Step 1: base schema
-- Paste contents of: src/config/schema.sql

-- Step 2: processed_receipts table
-- Paste contents of: src/config/migrations/004_processed_receipts.sql

-- Step 3: pipeline_logs table
-- Paste contents of: src/config/migrations/005_pipeline_logs.sql
```

### Verify all tables exist
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```
Expected: `ad_views`, `pipeline_logs`, `processed_receipts`, `queries`, `token_balances`, `token_packages`, `trends`, `users`

### Seed token_packages
```sql
INSERT INTO token_packages (id, name, token_amount, price_usd, is_active) VALUES
  (gen_random_uuid(), 'Küçük Paket', 1000,  6.99,  true),
  (gen_random_uuid(), 'Orta Paket',  2500, 14.99,  true),
  (gen_random_uuid(), 'Büyük Paket', 6000, 29.99,  true);
```

### Enable Row Level Security
```sql
-- Enable RLS
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_balances  ENABLE ROW LEVEL SECURITY;

-- Users can only read/update their own row
CREATE POLICY "users_self_read"
  ON users FOR SELECT
  USING (auth.uid()::text = id::text);

CREATE POLICY "users_self_update"
  ON users FOR UPDATE
  USING (auth.uid()::text = id::text);

CREATE POLICY "token_balances_self_read"
  ON token_balances FOR SELECT
  USING (auth.uid()::text = user_id::text);

CREATE POLICY "token_balances_self_update"
  ON token_balances FOR UPDATE
  USING (auth.uid()::text = user_id::text);
```

### Get pooler connection string
- Supabase Dashboard → Project Settings → Database → Connection Pooling
- Mode: **Transaction** (port **6543**)
- Copy the connection string — use this as `DATABASE_URL` in Railway
- **Never use the direct connection string (port 5432) in production**

---

## 2. Railway — Backend Deployment

### Create project
1. railway.app → New Project → Deploy from GitHub repo
2. Select `hyperadar-backend` repository
3. Railway auto-detects Node.js via `package.json`

### Set environment variables
In Railway Dashboard → Variables, set ALL of these:

```
DATABASE_URL=<supabase pooler connection string, port 6543>
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
ANTHROPIC_API_KEY=<your key>
YOUTUBE_API_KEY=<your key>
REDDIT_CLIENT_ID=<your key>
REDDIT_CLIENT_SECRET=<your key>
PRODUCT_HUNT_API_KEY=<your key>
APPLE_SHARED_SECRET=<your key>
GOOGLE_SERVICE_ACCOUNT_JSON=<stringified JSON>
GOOGLE_PLAY_PACKAGE_NAME=com.hyperadar.mobile
REVENUECAT_SECRET_KEY=<your sk_... key>
SENTRY_DSN=<your sentry DSN>
ALLOWED_ORIGINS=https://hyperadar-admin.vercel.app
ADMIN_EMAIL=<your admin email>
ADMIN_PASSWORD=<strong password>
PORT=3000
NODE_ENV=production
```

### Set health check
Railway Dashboard → Service → Settings → Health Check Path: `/health`

### Verify deployment
```bash
curl https://your-railway-url.railway.app/health
# Expected: {"status":"ok","timestamp":"..."}
```

---

## 3. Vercel — Admin Panel Deployment

### Deploy
```bash
cd hyperadar-admin
npx vercel --prod
```

### Set environment variables in Vercel Dashboard
```
NEXT_PUBLIC_API_URL=https://your-railway-url.railway.app
```

### After deployment
Update Railway `ALLOWED_ORIGINS` to include your Vercel domain:
```
ALLOWED_ORIGINS=https://hyperadar-admin.vercel.app
```

Then redeploy Railway service for CORS change to take effect.

---

## 4. API Smoke Tests

Run these in order after deployment (replace `$API` with your Railway URL):

```bash
export API=https://your-railway-url.railway.app

# Health
curl $API/health
# Expected: {"status":"ok","timestamp":"..."}

# Register test user
curl -X POST $API/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"smoketest@hyperadar.com","password":"TestPass123!"}'
# Expected: {"token":"...","user":{...}}

# Save the token
export TOKEN=<token from above>

# Login
curl -X POST $API/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"smoketest@hyperadar.com","password":"TestPass123!"}'
# Expected: {"token":"..."}

# Get profile
curl $API/user/me \
  -H "Authorization: Bearer $TOKEN"
# Expected: {"id":"...","email":"...","plan":"free",...}

# Submit query
curl -X POST $API/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"regions":["Global"],"categories":["github"]}'
# Expected: {"query_id":"...","trends":[...]} (may take 10-30s)

# Token packages
curl $API/tokens/packages \
  -H "Authorization: Bearer $TOKEN"
# Expected: [{"id":"...","name":"Küçük Paket",...},...]

# Admin login
curl -X POST $API/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"$ADMIN_EMAIL","password":"$ADMIN_PASSWORD"}'
# Expected: {"token":"...","role":"admin"}

export ADMIN_TOKEN=<admin token from above>

# Admin stats
curl $API/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: {"total_users":1,...}

# Pipeline status
curl $API/admin/pipeline/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: {"last_run":null,"is_running":false,...}

# Trigger manual pipeline run
curl -X POST $API/admin/pipeline/run \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: {"success":true,"message":"Pipeline started"}
```

---

## 5. Security Checks

```bash
# CORS should block unlisted origins
curl -H "Origin: https://evil.com" $API/health -v 2>&1 | grep -E "(origin|cors|CORS|< HTTP)"

# Rate limiting — send 31 requests quickly, last should return 429
for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code}\n" $API/health; done

# Admin routes require auth
curl $API/admin/stats
# Expected: {"error":"Unauthorized"}

# User routes require auth
curl $API/user/me
# Expected: {"error":"Unauthorized"}
```

---

## 6. Pre-Launch Checklist

### Database
- [ ] All migrations ran successfully
- [ ] All 8 tables exist in Supabase
- [ ] `token_packages` table has 3 rows
- [ ] RLS enabled on `users` and `token_balances`
- [ ] Using pooler connection string (port 6543), not direct

### Railway
- [ ] All environment variables set
- [ ] `NODE_ENV=production`
- [ ] Health check path set to `/health` and returning 200
- [ ] Deployment logs show no startup errors
- [ ] `[Cron]` log lines visible (pipeline scheduled, heartbeat)

### Admin Panel (Vercel)
- [ ] Admin login working
- [ ] Dashboard stats loading (may be zeros — that's fine)
- [ ] Manual pipeline trigger working
- [ ] At least one successful pipeline run (`pipeline_logs` has a `success` row)
- [ ] Trends visible in database after first pipeline run

### Security
- [ ] CORS blocking unlisted origins
- [ ] Rate limiting active (429 after 30 req/min)
- [ ] Admin routes return 401 without token
- [ ] No real env values committed to git (`.env` in `.gitignore`)

### Monitoring
- [ ] Sentry project created and DSN set
- [ ] Railway logs showing 5-minute heartbeat (`[Cron] Heartbeat`)
- [ ] First pipeline run completed without errors

---

## 7. Mobile App Final Config

Update `hyperadar-mobile/.env` with production values:

```
EXPO_PUBLIC_API_URL=https://your-railway-url.railway.app
EXPO_PUBLIC_REVENUECAT_IOS_KEY=<production RC iOS key>
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=<production RC Android key>
EXPO_PUBLIC_ADMOB_REWARDED_IOS=<production ad unit ID>
EXPO_PUBLIC_ADMOB_REWARDED_ANDROID=<production ad unit ID>
```

Note: `lib/admob.js` uses `__DEV__` to automatically switch to test IDs in development builds.
Production IDs only activate in `eas build --profile production` builds.

---

## 8. Post-Go-Live (Day 1)

- [ ] Monitor Railway logs for errors
- [ ] Check Sentry for any captured exceptions
- [ ] Verify second scheduled pipeline run at 08:00 or 16:00 UTC succeeds
- [ ] Confirm cron heartbeat visible every 5 minutes in Railway logs
- [ ] Test purchase flow with sandbox accounts (iOS TestFlight + Android internal track)
