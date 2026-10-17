# Production Deployment Runbook

This guide provides end-to-end instructions for deploying Handover to production with database role separation, persistent media storage, HTTPS, and operational verification.

---

## 1. Hosting Architecture Comparison

Handover requires three components in production:

1. **Node.js Application Runtime** (Node.js >= 20.6)
2. **PostgreSQL Database** (PostgreSQL >= 14 with role separation support)
3. **Durable File Storage** (for uploaded item inspection photographs)

### Architecture Options Evaluated

| Dimension                    | Primary Reference Architecture: Render (Web Service + Disk) + Render Postgres        | Alternative A: Render Web Service + Neon Postgres + Cloudflare R2 / AWS S3                  | Alternative B: Self-Hosted Linux VM (Docker & Docker Compose)                |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Compute**                  | Render Web Service (Starter tier: $7/mo, 512 MB RAM, 0.5 CPU)                        | Render Web Service (Free tier or Starter tier)                                              | VPS (e.g. Hetzner €3.50/mo, DigitalOcean $4–6/mo, or AWS Lightsail $3.50/mo) |
| **Database**                 | Render Managed PostgreSQL (Basic tier: $6/mo, includes 1 GB storage)                 | Neon Serverless PostgreSQL (Free tier: 0.5 GB, or Launch plan: $5/mo base)                  | Self-managed PostgreSQL 16 container in Docker Compose                       |
| **Media Storage**            | Render Persistent Disk ($0.25/GB/mo mounted to `/var/data/uploads`)                  | Cloudflare R2 (10 GB free, $0 egress) or AWS S3 ($0.023/GB/mo)                              | Host directory mounted into container (`/opt/handover/uploads`)              |
| **Code Changes Needed**      | **None** (uses existing `LocalStorage` and `UPLOAD_DIR`)                             | **Requires code changes** (new S3/R2 storage adapter implementing `save`, `read`, `remove`) | **None** (uses existing `LocalStorage` and `UPLOAD_DIR`)                     |
| **Database Role Separation** | **Supported** via `src/db/roles.js` and custom role provisioning                     | **Supported** via standard Postgres RBAC or Neon console role management                    | **Full control** as native Postgres superuser                                |
| **Durability on Redeploy**   | High (persistent disk unmounts and remounts across deploys)                          | High (object storage persists independently of compute)                                     | High (host filesystem persists across container restarts)                    |
| **Zero-Downtime Deploys**    | Brief restart transition (~10–30s) during redeploy due to single-instance disk mount | Yes (true zero-downtime rolling deploys supported)                                          | Operator-controlled (typically brief container swap)                         |
| **Horizontal Scaling**       | Single instance only (disks cannot be shared across multiple instances)              | Supported (stateless compute scales horizontally)                                           | Single host (or multi-host with shared NFS/Ceph)                             |
| **Operational Complexity**   | Low (managed platform with auto-HTTPS and zero server maintenance)                   | Medium (multiple third-party services and APIs to coordinate)                               | High (operator manages OS patches, firewall, backups, and SSL renewal)       |
| **Estimated Base Cost**      | **~$13.25 – $15.50 / month** ($7 compute + $6 DB + $0.25–$2.50 disk)                 | Free tier eligible (or ~$12/mo on paid compute/DB)                                          | **~$4.00 – $6.00 / month**                                                   |

### Recommendation

**Use the Primary Reference Architecture (Render Web Service + Persistent Disk + Render PostgreSQL)**.  
It provides managed backups, automated TLS certificates, zero server maintenance, and requires **zero application code modifications** because it satisfies `LocalStorage` requirements natively through a persistent disk mount.

> [!WARNING]
> **Ephemeral Disk Risk**: Render Free Web Services do **NOT** support persistent disks and spin down after 15 minutes of inactivity. Deploying Handover to any stateless container without a persistent disk will cause all uploaded inspection photos to be permanently deleted on every redeploy or container restart.

> [!NOTE]
> **Single-Instance Disk Lifecycle**: Attaching a persistent disk disables Render's rolling zero-downtime deployments. Because a disk can only be mounted to one container instance at a time, Render gracefully stops the running container before attaching the disk to the newly deployed container, resulting in a brief (~10–30s) transition. If multi-instance horizontal scaling or zero-downtime deploys are mandatory, adopt Alternative A with object storage (R2/S3).

---

## 2. Application & Database Prerequisites

Before deploying, ensure you have:

1. **GitHub Account & Repository**: Access to your cloned/forked repository (`Ayush-o1/monarch`).
2. **Render Account**: Signed up at [render.com](https://render.com).
3. **Local Tools**: `node >= 20.6`, `psql` (PostgreSQL client CLI), `openssl` (or Node.js crypto) for secret generation.

---

## 3. Provisioning the Reference Architecture (Render)

### Step 3.1: Create Managed PostgreSQL Database

1. In the Render Dashboard, click **New +** > **PostgreSQL**.
2. Fill in database parameters:
   - **Name**: `monarch-production-db`
   - **Database**: `monarch_prod`
   - **User**: Leave as default (Render assigns a database owner username, e.g. `monarch_user`)
   - **Region**: Choose the region closest to your users (e.g., `Frankfurt` or `Singapore`)
   - **Plan**: `Basic ($6/mo)` (do not use the 30-day expiring Free plan for production)
3. Click **Create Database**.
4. Once provisioned, locate the **Connections** panel:
   - Copy the **Internal Database URL** (used for communication within Render).
   - Copy the **External Database URL** (used for initial local/migration tasks if needed).

### Step 3.2: Create Persistent Disk

1. The persistent disk is attached directly to the Web Service during service creation or in the service's **Disks** tab:
   - **Disk Name**: `monarch-uploads`
   - **Mount Path**: `/var/data/uploads`
   - **Size**: `1 GB` (minimum; costs $0.25/mo, scalable at any time in the dashboard)

### Step 3.3: Create Web Service

1. Click **New +** > **Web Service**.
2. Connect your GitHub repository (`monarch`).
3. Configure the service settings:
   - **Name**: `handover-app`
   - **Region**: Same region as your database
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && touch .env` (installs dependencies; `touch .env` ensures a zero-byte file exists so Node's `--env-file=.env` falls back safely to Render's injected dashboard variables)
   - **Pre-Deploy Command**: `npm run migrate` (runs migrations via `MIGRATE_DATABASE_URL` before traffic shifts; aborts deployment if migrations fail)
   - **Start Command**: `npm start` (boots application via `DATABASE_URL` as `monarch_app`)
   - **Plan**: `Starter ($7/mo)` (required for persistent disk and pre-deploy commands)
4. Under **Advanced**:
   - **Health Check Path**: `/api/health` (Render verifies HTTP 200 before routing traffic to the instance)
   - **Disks**: Add the disk from Step 3.2:
     - **Mount Path**: `/var/data/uploads`
     - **Size**: `1 GB`

---

## 4. Production Environment Variables & Secret Generation

### Step 4.1: Generating Cryptographic Secrets

Generate strong, unguessable secrets locally. **Never print or log these values to shared terminals or commit them to Git**:

```bash
# Generate a 64-character hex string for SESSION_SECRET (32 bytes entropy)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate a 48-character hex string for APP_DB_PASSWORD (24 bytes entropy)
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### Step 4.2: Environment Variables Reference

In your Render Web Service dashboard under **Environment**, configure the following variables:

| Variable Name          | Required | Example / Recommended Value                                              | Description                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `NODE_ENV`             | Yes      | `production`                                                             | Enables production optimisations and placeholder secret checks     |
| `PORT`                 | Yes      | `10000`                                                                  | Port assigned by host (Render defaults to 10000)                   |
| `SESSION_SECRET`       | Yes      | `<OUTPUT_FROM_CRYPTO_RANDOMBYTES_32>`                                    | Minimum 32 characters; used for signing session cookies            |
| `MIGRATE_DATABASE_URL` | Yes      | `<INTERNAL_POSTGRES_OWNER_CONNECTION_URL>`                               | Owner connection string used by migration runner before app starts |
| `DATABASE_URL`         | Yes      | `postgresql://monarch_app:<APP_DB_PASSWORD>@<DB_HOST>:5432/monarch_prod` | Application runtime connection string using limited app role       |
| `APP_DB_USER`          | Yes      | `monarch_app`                                                            | Runtime role name (must match `/^[a-z_][a-z0-9_]{0,62}$/`)         |
| `APP_DB_PASSWORD`      | Yes      | `<OUTPUT_FROM_CRYPTO_RANDOMBYTES_24>`                                    | Strong password for `monarch_app`                                  |
| `COOKIE_SECURE`        | Yes      | `true`                                                                   | Ensures cookies carry `; Secure` flag over HTTPS                   |
| `PUBLIC_BASE_URL`      | Yes      | `https://handover-app.onrender.com`                                      | Canonical public URL used in invite links (without trailing slash) |
| `UPLOAD_DIR`           | Yes      | `/var/data/uploads`                                                      | Absolute path matching the mounted persistent disk                 |
| `MAX_UPLOAD_MB`        | No       | `5`                                                                      | Maximum upload size per photo in megabytes                         |
| `INVITE_TTL_DAYS`      | No       | `30`                                                                     | Default expiration lifetime for landlord review tokens             |

---

## 5. Database Owner / App Role Separation Setup

Handover enforces strict database least-privilege: the web application process connects as `monarch_app`, which **cannot** drop tables, alter triggers, mutate `events`, or access `schema_migrations`.

### Automated Role Grants

When `src/db/migrate.js` runs with `MIGRATE_DATABASE_URL` and `APP_DB_PASSWORD` set, it automatically calls `src/db/roles.js` (`applyAppRoleGrants`), creating the `monarch_app` role if missing, altering its password, and applying all least-privilege grants.

### Provider-Specific Notes & Standalone Setup

On managed cloud providers that do not allow non-superusers to run `CREATE ROLE` from migration connections, run the following SQL script directly in your database provider's SQL console (e.g. Render Web Console, Neon SQL Editor, or via `psql` using your owner connection string):

```sql
-- 1. Create or update limited application role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monarch_app') THEN
    CREATE ROLE monarch_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<REPLACE_WITH_APP_DB_PASSWORD>';
  ELSE
    ALTER ROLE monarch_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<REPLACE_WITH_APP_DB_PASSWORD>';
  END IF;
END $$;

-- 2. Grant connection and schema usage
GRANT CONNECT ON DATABASE monarch_prod TO monarch_app;
GRANT USAGE ON SCHEMA public TO monarch_app;
REVOKE CREATE ON SCHEMA public FROM monarch_app;

-- 3. Grant table permissions (DML only)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM monarch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monarch_app;

-- 4. Enforce immutability on audit trail & migration metadata
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM monarch_app;
REVOKE ALL ON schema_migrations FROM monarch_app;

-- 5. Grant sequence access for serial IDs
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO monarch_app;
```

---

## 6. Production Migrations & Deployment Ordering

### Three-Phase Render Deployment Lifecycle

Render paid web services execute deployments in three distinct lifecycle phases:

1. **Build Phase**: Executes `npm install && touch .env`.
   - Runs in Render's build cluster.
   - Installs production and dev dependencies required for build/tooling.
   - `touch .env` creates an empty `.env` in the project root so that Node's `--env-file=.env` argument does not error out on Render, where environment variables are injected directly via `process.env`.
   - **Note on Network Isolation**: Database migrations should **not** be chained in the build command (`npm install && npm run migrate`) because build environments may not have direct access to Render's internal database network or VPC hostnames.

2. **Pre-Deploy Phase**: Executes `npm run migrate`.
   - Runs in an isolated, ephemeral container with access to Render's internal database network.
   - Connects using the database owner credentials in `MIGRATE_DATABASE_URL`.
   - Applies pending migrations (`001_` through `008_`) inside individual transactions.
   - Validates SHA-256 checksums in `schema_migrations`.
   - Calls `applyAppRoleGrants` to ensure tables and sequences are granted to `monarch_app`.
   - **Deployment Abort on Failure**: If any migration fails or times out (Render enforces a 30-minute timeout), the deploy is immediately canceled. The previous release continues running without disruption.
   - **Disk Isolation**: The pre-deploy container does **not** have access to the persistent disk. Because migrations only communicate with PostgreSQL over the network, this is completely safe. Media-related tasks or demo seeding should not run in pre-deploy.

3. **Start & Health Check Phase**: Executes `npm start` (`node --env-file=.env src/server.js`).
   - The application boots and connects strictly through `DATABASE_URL` using the restricted `monarch_app` role.
   - The persistent disk is mounted at `/var/data/uploads` (`UPLOAD_DIR`).
   - Render polls `GET /api/health` every few seconds.
   - Traffic is only routed to the new container once `/api/health` returns HTTP 200 (`{"status":"ok"}`).

### Persistent Disk Redeploy Lifecycle & Downtime Trade-off

When deploying services with persistent disks on Render:

- **Single-Mount Constraint**: Render persistent disks can only be attached to a single instance at a time.
- **Restart Transition**: Unlike stateless services that support zero-downtime rolling deploys, Render must stop the running instance, detach the disk, attach the disk to the new instance, and start the new container. This swap typically takes between 10 to 30 seconds.
- **Future Horizontal Scaling**: If application growth requires zero-downtime redeploys or horizontal scaling (2+ instances), migrate media storage from the persistent disk to S3-compatible object storage (Alternative A: Cloudflare R2 or AWS S3).

---

## 7. Persistent Upload Directory & File Durability

### Disk Permissions & Verification

When Render mounts a disk at `/var/data/uploads`, the Node.js process must have write access:

1. `src/lib/storage/local.js` creates subdirectories automatically under `UPLOAD_DIR`.
2. Inspect directory creation in logs:
   - When photos are uploaded, files are written to `${UPLOAD_DIR}/${tenancyId}/${randomUUID()}.jpg`.

### Why Ephemeral Disks Fail

If `UPLOAD_DIR` points to `./uploads` on a container without a persistent disk:

- Every Git push, manual deploy, or container restart re-provisions a fresh container.
- Existing photos in `./uploads` are discarded, leaving broken photo links in reports and condition records.

### Scaling Consideration: Single-Instance Constraint

Persistent disks on Render are bound to a single container instance. Consequently:

- **No Multi-Instance Scaling**: You cannot scale the web service to 2 or more concurrent instances while a persistent disk is attached.
- **Migration Path**: If load requires scaling horizontally to multiple instances, implement the S3-compatible storage adapter (Alternative A) so that all instances read and write from centralized object storage.

---

## 8. HTTPS, Reverse Proxy, Secure Cookies, and Headers

### Reverse Proxy & Trust Proxy

- Render terminates TLS at its load balancer and forwards requests to your Node process with header `X-Forwarded-Proto: https`.
- `src/app.js` automatically enables `app.set('trust proxy', 1)` when `COOKIE_SECURE=true` (`config.cookieSecure`).
- This ensures Express properly recognizes the request as secure and attaches `; Secure` to the `monarch.sid` session cookie.

### Security Headers

Every HTTP response is guarded by Helmet with zero configuration overrides needed:

- `Content-Security-Policy`: `default-src 'self'`, `frame-ancestors 'none'`, no `'unsafe-inline'`, no `'unsafe-eval'`.
- `Referrer-Policy`: `no-referrer`.
- `X-Content-Type-Options`: `nosniff`.
- `Cache-Control`: `no-store` on landlord review pages (`/l/*`, `/api/landlord/*`).

---

## 9. Health Checks & Graceful Shutdown

### Health Check Endpoint

- **URL**: `GET /api/health`
- **Behavior**: Executes `SELECT 1` against PostgreSQL using the application connection pool.
  - Status 200: `{"status":"ok"}`
  - Status 503: `{"error":{"code":"DATABASE_UNAVAILABLE","message":"Database is unreachable"}}`
- **Render Configuration**: Set **Health Check Path** to `/api/health` in the Render service settings. Render will not route traffic to a newly deployed container until `/api/health` returns HTTP 200.
- **Probe Safety & Rate Limiting**: Render probes `/api/health` every few seconds. Because `/api/health` is exempt from authentication, CSRF origin verification (as a GET request), and application rate limiters, it functions as a lightweight, non-blocking readiness check.

### Graceful Shutdown

- `src/server.js` listens for `SIGTERM` and `SIGINT`:
  ```javascript
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  ```
- When Render sends `SIGTERM` during updates or restarts, the server stops accepting new connections, drains existing HTTP requests, and exits cleanly with code 0.

---

## 10. Optional Demo Data Seeding

To seed synthetic demo data into your production or staging instance:

```bash
# In Render Shell or locally targeting production DATABASE_URL:
DEMO_PASSWORD='<SECURE_DEMO_PASSWORD>' npm run seed:demo
```

- Creates demo user `demo@handover.local` with two synthetic tenancies (one in `settling` status with photos and deductions, one in `active` draft status).
- **Idempotent**: Exits cleanly with `"Demo data already exists"` if run a second time.
- Never prints passwords, tokens, or landlord links to console logs.
- **Run in Service Shell, Not Pre-Deploy**: Do **not** place `npm run seed:demo` inside Render's Pre-Deploy Command. Pre-deploy containers do not mount the persistent disk. Execute demo seeding via the Render web shell or SSH after the service and disk are mounted and live.

---

## 11. Production Smoke Tests

Execute these verification checks immediately following deployment:

1. **Health Verification**:
   ```bash
   curl -i https://<YOUR_APP_DOMAIN>/api/health
   # Expected: HTTP/2 200 OK, {"status":"ok"}
   ```
2. **Security Headers Verification**:
   ```bash
   curl -i https://<YOUR_APP_DOMAIN>/login.html | grep -iE 'content-security-policy|referrer-policy|x-content-type-options'
   # Expected:
   # content-security-policy: default-src 'self' ...
   # referrer-policy: no-referrer
   # x-content-type-options: nosniff
   ```
3. **Secure Cookie Verification**:
   ```bash
   curl -i -c - https://<YOUR_APP_DOMAIN>/api/auth/register \
     -H 'Content-Type: application/json' \
     -H "Origin: https://<YOUR_APP_DOMAIN>" \
     -d '{"name":"Smoke Tester","email":"smoke@example.com","password":"SmokeTestPassword123!"}'
   # Inspect Set-Cookie header: Must contain "Secure; HttpOnly; SameSite=Lax"
   ```

---

## 12. Two-Window Tenant & Landlord Walkthrough

Perform a manual end-to-end check using two browser windows:

1. **Window A (Tenant - Standard Mode)**:
   - Navigate to `https://<YOUR_APP_DOMAIN>/login.html`.
   - Log in or register an account.
   - Create a tenancy: deposit Rs 50,000, 15 days refund window.
   - Add 3 items in move-in inspection and attach at least one photo.
   - Click **Submit Move-in Inspection**.
   - Click **Create Review Link** and copy URL (`https://<YOUR_APP_DOMAIN>/l/<token>`).
2. **Window B (Landlord - Incognito / Private Mode)**:
   - Paste review URL.
   - Verify page renders without tenant email or user IDs visible.
   - Enter "Test Landlord" and click **Acknowledge Record**.
   - Verify inspection status immediately updates to `ACKNOWLEDGED`.
3. **Window A (Tenant)**:
   - Refresh inspection page: verify item editing and photo deletions are permanently locked.
   - Download PDF report: verify PDF downloads cleanly with running headers, footers, legal notice, and photo thumbnails.

---

## 13. Photo-Persistence Verification Across Restarts

To verify that persistent disk storage survives server restarts:

1. Log in to the application and upload a photo to an inspection item.
2. In the Render Dashboard, click **Manual Deploy** > **Restart Service** (or trigger a redeploy).
3. Wait for the service to restart and `/api/health` to turn green.
4. Navigate back to the inspection item and click the photo thumbnail:
   - The photo loads successfully (`GET /api/media/:id` returns 200 with `image/jpeg`).
   - If files disappear or return 404/500, verify that `UPLOAD_DIR` matches the exact mount path of your persistent disk.

---

## 14. Backup, Recovery, and Troubleshooting

### PostgreSQL Database Backups

Render provides automated daily backups for paid PostgreSQL instances. To create a manual snapshot before major updates:

```bash
# Run locally using owner connection string
pg_dump -Fc --no-acl --no-owner "<MIGRATE_DATABASE_URL>" -f "backup-$(date +%Y%m%d%H%M%S).dump"
```

### Media File Backups

Because database dumps do **not** include uploaded photo files on disk:

- Periodically archive the persistent disk directory:
  ```bash
  # Inside Render shell or via SSH:
  tar -czf /var/data/uploads-backup-$(date +%Y%m%d).tar.gz /var/data/uploads
  ```

### Rollback Procedure

If a release causes issues:

1. In Render Dashboard, go to **Deploys** and click **Rollback to this deploy** on the last working release.
2. If database schema was altered, restore the pre-migration snapshot:
   ```bash
   pg_restore --clean --if-exists --no-acl --no-owner -d "<MIGRATE_DATABASE_URL>" backup-file.dump
   ```

### Common Deployment Issues

| Symptom                                               | Cause                                                    | Solution                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `node: .env: not found`                               | Node `--env-file=.env` cannot find `.env` file           | Ensure Build Command is `npm install && touch .env` or add an empty `.env` in Render Secret Files. |
| `Pre-deploy failed: MIGRATE_DATABASE_URL is required` | Environment variable missing in service settings         | Add `MIGRATE_DATABASE_URL` in service environment settings.                                        |
| `Permission denied for table events` during migration | Migration runner connecting as app role instead of owner | Verify `MIGRATE_DATABASE_URL` uses the database owner user.                                        |
| Pre-deploy command timed out (30m limit)              | Migration hung waiting on active lock or blocked query   | Check `pg_stat_activity` in Postgres console for lock contention.                                  |
| Session cookie missing `Secure` attribute             | `COOKIE_SECURE=true` not set or `trust proxy` disabled   | Ensure `COOKIE_SECURE=true` is present in Render environment variables.                            |
| Photos 404 after service redeploy                     | `UPLOAD_DIR` pointing to ephemeral `./uploads`           | Configure persistent disk mount at `/var/data/uploads` and set `UPLOAD_DIR=/var/data/uploads`.     |
| 403 `BAD_ORIGIN` on non-GET requests                  | Request `Origin` does not match `PUBLIC_BASE_URL`        | Ensure `PUBLIC_BASE_URL` exactly matches the browser URL scheme and domain.                        |

---

## 15. Final Production Release Checklist

Before announcing the deployment to users, complete this checklist:

- [ ] **Database Provisioned**: Managed PostgreSQL 14+ running on paid tier with automated backups enabled.
- [ ] **Role Separation Verified**:
  - `MIGRATE_DATABASE_URL` configured for owner migrations.
  - `DATABASE_URL` configured for application runtime as `monarch_app`.
  - Verified `monarch_app` cannot modify `events` or disable triggers.
- [ ] **Render Service Lifecycle Commands Configured**:
  - **Build Command**: `npm install && touch .env`
  - **Pre-Deploy Command**: `npm run migrate`
  - **Start Command**: `npm start`
  - **Health Check Path**: `/api/health`
- [ ] **Secrets Configured**:
  - `SESSION_SECRET` generated with >= 32 characters of random bytes.
  - `APP_DB_PASSWORD` generated with >= 24 characters of random bytes.
  - Zero placeholder secrets used in production.
- [ ] **Persistent Disk Attached**:
  - Disk mounted to `/var/data/uploads`.
  - `UPLOAD_DIR=/var/data/uploads` set in environment.
  - Photo persistence verified across a test restart.
- [ ] **HTTPS & Security Policies**:
  - `COOKIE_SECURE=true` enabled.
  - `PUBLIC_BASE_URL` configured with `https://`.
  - CSP and security headers verified via `curl -i`.
- [ ] **Operational Verification**:
  - `/api/health` returns HTTP 200 with database check.
  - Render Health Check path configured to `/api/health`.
  - Two-window tenant/landlord flow completed successfully.
