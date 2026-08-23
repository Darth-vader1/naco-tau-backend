# Security Deployment Checklist ✅

Quick checklist for deploying Phase 1 security enhancements.

## Pre-Deployment

- [ ] **Read** `documentation/PHASE_1_SECURITY_DEPLOYMENT.md`
- [ ] **Review** changes in `server.js`
- [ ] **Check** new files in `config/` folder exist

## Installation

```bash
cd backend
npm install
```

- [ ] **Verify** no installation errors
- [ ] **Check** 5 new packages installed:
  - cookie-parser
  - csurf
  - file-type
  - winston
  - @sentry/node

## Environment Variables (Railway)

### Required (Minimum - Add These)
- [ ] `NODE_ENV=production`
- [ ] `TRUST_PROXY=true`
- [ ] `LOG_LEVEL=info`

### Existing (Verify These)
- [ ] `FRONTEND_URL` is set correctly
- [ ] `SUPABASE_URL` is set
- [ ] `SUPABASE_ANON_KEY` is set
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set

### Optional (Recommended)
- [ ] `SENTRY_DSN=` (get from sentry.io)
- [ ] `SENTRY_TRACES_SAMPLE_RATE=0.1`
- [ ] `LOG_TO_FILE=true`

### Advanced (Optional)
- [ ] `ENABLE_CSRF=false` (enable later)
- [ ] `ADMIN_IP_WHITELIST=` (leave empty for now)
- [ ] `GLOBAL_RATE_LIMIT=100` (default is fine)

## Local Testing (Optional)

```bash
# Start server locally
npm start

# Should see security logs:
# ✅ HTTPS enforcement enabled
# ✅ Security headers configured
# ✅ Structured logging enabled
# ✅ XSS protection enabled
```

- [ ] Server starts without errors
- [ ] Security logs appear
- [ ] Health check works: http://localhost:5000/api/health

## Deployment

```bash
cd backend

# Stage changes
git add .

# Commit
git commit -m "feat: Phase 1 security - HTTPS, logging, Sentry, file security"

# Push to Railway
git push origin main
```

- [ ] Commit created successfully
- [ ] Push to Railway successful
- [ ] Railway build started

## Post-Deployment Verification

### 1. Check Railway Build
- [ ] Railway build completed (green checkmark)
- [ ] No build errors in logs
- [ ] Deployment successful

### 2. Check Startup Logs
Open Railway logs and verify you see:
- [ ] `✅ HTTPS enforcement enabled`
- [ ] `✅ Security headers configured`
- [ ] `✅ Structured logging enabled`
- [ ] `✅ XSS protection enabled`
- [ ] `✅ All security features initialized`

### 3. Test Health Endpoint

```bash
curl https://naco-tau-backend-production.up.railway.app/api/health
```

- [ ] Returns 200 OK
- [ ] Response includes:
  ```json
  {
    "status": "healthy",
    "environment": "production",
    "security": {
      "https": true,
      "csrf": false,
      "sentry": true/false
    }
  }
  ```

### 4. Test Security Headers

```bash
curl -I https://naco-tau-backend-production.up.railway.app/api/health
```

- [ ] `Strict-Transport-Security` header present
- [ ] `X-Frame-Options: DENY` present
- [ ] `X-Content-Type-Options: nosniff` present
- [ ] `Content-Security-Policy` present

### 5. Test Rate Limiting

```bash
# Send many requests (should get rate limited after 100)
for i in {1..105}; do curl https://naco-tau-backend-production.up.railway.app/api/health; done
```

- [ ] First 100 requests succeed
- [ ] Request 101+ returns rate limit error

### 6. Test Existing Functionality
- [ ] Frontend still loads correctly
- [ ] Login works
- [ ] Admin dashboard works
- [ ] File uploads work
- [ ] No existing features broken

## Optional: Sentry Setup

If you configured `SENTRY_DSN`:

- [ ] Sign up at https://sentry.io
- [ ] Create new Node.js project
- [ ] Copy DSN
- [ ] Add to Railway env vars
- [ ] Redeploy (automatic)
- [ ] Verify: Health endpoint shows `sentry: true`
- [ ] Test: Trigger an error, check Sentry dashboard

## Troubleshooting

### Server Won't Start
```bash
# Check Railway logs
railway logs

# Look for:
# - Module not found → npm install
# - Port issues → Restart deployment
# - Missing env vars → Add to Railway
```

### 500 Errors
- [ ] Check Railway logs for stack trace
- [ ] Check Sentry dashboard (if configured)
- [ ] Verify all env vars are set

### CORS Errors
- [ ] Verify `FRONTEND_URL` in Railway
- [ ] Check browser console for exact error
- [ ] Verify origin in allowedOrigins array

## Success Criteria

✅ **Must Have** (Required for success):
- [x] Server starts without errors
- [x] Security headers present
- [x] Rate limiting works
- [x] Existing features still work
- [x] No errors in Railway logs

✅ **Should Have** (Recommended):
- [ ] Sentry configured and capturing errors
- [ ] Security logs visible in Railway
- [ ] File upload security tested

✅ **Nice to Have** (Optional):
- [ ] CSRF enabled (after frontend integration)
- [ ] IP whitelist configured
- [ ] Custom rate limits set

## Final Checks

- [ ] **Documentation**: Team knows about changes
- [ ] **Monitoring**: Railway logs accessible
- [ ] **Backup**: Can rollback if needed (`git revert HEAD`)
- [ ] **Support**: Know where to check logs/errors

## Post-Deployment Tasks

### Immediate (Today)
- [ ] Monitor Railway logs for 1 hour
- [ ] Test all major features
- [ ] Check for any user-reported issues

### This Week
- [ ] Review security logs daily
- [ ] Set up Sentry alerts (if configured)
- [ ] Plan Phase 2 (token refresh, Redis)

### This Month
- [ ] Review security metrics
- [ ] Update dependencies
- [ ] Run security audit

## Rollback Plan

If critical issues arise:

```bash
# Revert last commit
git revert HEAD
git push origin main

# Wait for Railway to redeploy
```

Or temporarily disable features:
```bash
# In Railway env vars
ENABLE_CSRF=false
SENTRY_DSN=  # Remove value
LOG_LEVEL=warn  # Reduce logging
```

---

## Need Help?

1. **Documentation**: `documentation/PHASE_1_SECURITY_DEPLOYMENT.md`
2. **Logs**: Railway Dashboard → Your Service → Logs
3. **Errors**: Sentry Dashboard (if configured)
4. **Health**: `/api/health` endpoint

---

**Status**: Ready to deploy ✅  
**Time Required**: ~15 minutes  
**Risk Level**: LOW  
**Rollback**: Easy (single git revert)

👉 **Start Here**: `npm install` then deploy!

