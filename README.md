# Handover

A shared move-in and move-out condition record for rentals, where landlord deposit deductions link to specific items and the tenant can accept or dispute each one.

## Requirements

- Node.js >= 20.6
- PostgreSQL >= 14 (running locally)
- npm >= 10

## Database Role Separation

Handover enforces database-level privilege separation:

- **Migration & Admin Role (Owner)**: Runs migrations and applies table grants (`MIGRATE_DATABASE_URL`, `TEST_MIGRATE_DATABASE_URL`).
- **Application Runtime Role (`monarch_app`)**: Limited `LOGIN` role used by the running web server (`DATABASE_URL`, `TEST_DATABASE_URL`).
  - Cannot create or drop tables (`REVOKE CREATE ON SCHEMA public`).
  - Cannot alter triggers (`ALTER TABLE ... DISABLE TRIGGER` rejected).
  - Cannot modify or delete audit events (`REVOKE UPDATE, DELETE, TRUNCATE ON events`).
  - Cannot read or tamper with migration history (`REVOKE ALL ON schema_migrations`).

## Setup

1. **Clone repository and install dependencies**:

   ```bash
   git clone https://github.com/Ayush-o1/monarch.git
   cd monarch
   npm install
   ```

2. **Configure environment**:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` to configure:
   - `SESSION_SECRET`: Random string of at least 32 characters.
   - `MIGRATE_DATABASE_URL`: PostgreSQL owner connection URL (e.g., `postgresql://postgres:postgres@localhost:5432/monarch_dev`).
   - `TEST_MIGRATE_DATABASE_URL`: PostgreSQL owner connection URL for tests (`monarch_test`).
   - `APP_DB_USER`: Runtime database role name (default: `monarch_app`).
   - `APP_DB_PASSWORD`: Strong password for the runtime application role.
   - `DATABASE_URL` & `TEST_DATABASE_URL`: Application connection strings using `APP_DB_USER` and `APP_DB_PASSWORD`.

3. **Create local PostgreSQL databases**:

   ```bash
   createdb monarch_dev
   createdb monarch_test
   ```

4. **Run database migrations and apply role grants**:

   ```bash
   npm run migrate
   npm run migrate:test
   ```

   _(Note: `npm run migrate` automatically configures `APP_DB_USER` permissions using `src/db/roles.js` whenever `APP_DB_PASSWORD` is configured.)_

5. **Seed demo data (Optional)**:

   ```bash
   DEMO_PASSWORD=YourSecureDemoPassword123 npm run seed:demo
   ```

## Running Locally

- **Development mode with watch reload**:

  ```bash
  npm run dev
  ```

  Open `http://localhost:3000` in your browser.

- **Production mode**:

  ```bash
  npm start
  ```

## Testing & Quality

- **Run all automated tests**:

  ```bash
  npm test
  ```

- **Run linting**:

  ```bash
  npm run lint
  ```

- **Check formatting**:

  ```bash
  npm run format:check
  ```

- **Fix formatting**:

  ```bash
  npm run format
  ```

## Project Structure

```
monarch/
├── src/                  # Express app, config, DB migrations, modules, and domain logic
│   ├── db/               # PostgreSQL pool, schema migrations (001-008), role grants
│   ├── lib/              # Errors, tokens, money, storage, settlement math, audit masking
│   ├── middleware/       # Auth guards, CSP/security headers, rate limiting, validation
│   └── modules/          # Auth, tenancies, items, media, landlord, deductions, report
├── public/               # Semantic HTML pages, vanilla CSS design tokens, browser JS
├── scripts/              # Project utilities (seed-demo.js)
├── tests/                # Node:test test suites (unit, integration, helpers)
└── docs/                 # ARCHITECTURE.md, TESTING.md, PLAN.md
```

## Security Model

- **Defense in Depth**: Application validation, database check constraints, and Postgres triggers work together to prevent illegal state transitions.
- **Strict Headers**: Comprehensive Content Security Policy without `'unsafe-inline'` or `'unsafe-eval'`, `frame-ancestors 'none'`, `no-referrer`, and `nosniff`.
- **Hashed Landlord Access**: Landlords access review links via 256-bit cryptographically secure tokens. Only SHA-256 digests are stored; links expire automatically and can be revoked instantly.
- **Privacy First**: Sensitive EXIF/GPS metadata is stripped on upload; tenant email and internal identifiers are omitted from landlord views. Sensitive tokens and landlord links are automatically masked in server logs.

For detailed architecture, schema designs, and role privilege definitions, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Demo Walkthrough Script (2–3 Minutes)

This walkthrough uses data created by `DEMO_PASSWORD=YourPassword npm run seed:demo`:

1. **Log In as Demo Tenant**:
   - Navigate to `http://localhost:3000/login.html`.
   - Log in with `demo@handover.local` and your configured demo password.
   - _Technical takeaway_: Authenticates via PostgreSQL session store (`connect-pg-simple`) with `HttpOnly`, `SameSite=Lax` cookies; passwords hashed with cost-12 bcrypt.

2. **Move-in Workflow & Landlord Lock (Tenancy B)**:
   - Open **DEMO - Lake View, Flat 12** (a draft move-in inspection with 5 items and photos).
   - Review the items, click **Submit Move-in Inspection**.
   - Under **Share with Landlord**, click **Create Review Link** and copy the link.
   - Open a private browsing window and paste the review URL (`http://localhost:3000/l/<token>`).
   - As landlord, enter "Demo Landlord" and click **Acknowledge Record**.
   - Switch back to the tenant window and refresh: notice the move-in inspection is now permanently locked (`ACKNOWLEDGED`).
   - _Technical takeaway_: Demonstrates atomic state transition via `inspections_guard` database trigger; landlord review links use SHA-256 token hashing with single-active-link partial index; draft lock triggers prevent post-acknowledgment tampering.

3. **Settlement, Dispute, & PDF Export (Tenancy A)**:
   - Open **DEMO - Palm Residency, Flat 3B** (already in `settling` status with move-out completed).
   - Click **View Condition Comparison**: observe the side-by-side comparison displaying 2 worse items (Granite Countertop, Ceiling Fan) and 1 better item (Main Door Lock) with photos.
   - Click **Settlement Details**: review the Rs 60,000 deposit ledger showing 1 accepted deduction (Rs 3,500), 1 disputed deduction (Rs 2,000), and 1 proposed deduction (Rs 1,500).
   - In the landlord private window, try proposing a deduction for Rs 65,000 (exceeding remaining deposit): the system immediately rejects the proposal with an error.
   - In the tenant window, locate the proposed Rs 1,500 deduction, enter a reason, and click **Dispute**.
   - Click **Download PDF report**: downloads `handover-demo-palm-residency-flat-3b-<date>.pdf`. Open the PDF to view the formatted legal disclaimer, item condition tables, comparison matrix, dispute history, and embedded photos.
   - _Technical takeaway_: Demonstrates `deduction_cap_guard` preventing deposit over-allocation; pure settlement math tracking window expiration; append-only audit event logging; and Latin-1 sanitized vector PDF generation via PDFKit.

## Known Limits

- **Not Legal Advice**: Handover records contemporaneous mutual agreement between tenant and landlord; it is not a court judgment or statutory dispute resolution.
- **Hosted Database Role Separation**: In hosted deployments (e.g. AWS RDS or Supabase), the DDL migration runner and the DML application pool must connect as distinct database users to maintain role hardening.
- **Latin-1 PDF Encoding**: The PDF report engine currently uses standard Latin-1 fonts; non-Latin characters and emojis are replaced with question marks.
- **File Storage**: Photos are stored locally on disk (`UPLOAD_DIR`); cloud deployments require a mounted persistent volume or S3 storage adapter.

For the full list of limits and architectural trade-offs, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
