# Implementation Plan

- [x] **Phase 0 — Workspace inspection, documentation, foundation**
  - Inspect environment and repo status
  - Baseline project setup: `.gitignore`, `.env.example`, `package.json`, ESLint, Prettier
  - Express app foundation with Helmet, static files, health check, 404 handler, error handling
  - Configuration loader with fast fail on invalid/short secrets
  - Initial project documentation: README, PLAN, ARCHITECTURE, TESTING
  - Unit and integration tests passing

- [x] **Phase 1 — Database layer and migrations**
  - Install `pg`, create connection pool with bigint parsing
  - Migration runner with transaction safety and sha256 checksum tracking
  - Migration `001_users_sessions.sql` (users and session tables)
  - Enhanced health check running database query
  - Test database runner and tests

- [ ] **Phase 2 — Authentication**
  - Install `zod`, `bcryptjs`, `express-session`, `connect-pg-simple`, `express-rate-limit`
  - Auth module (register, login, logout, me) with bcrypt cost 12
  - Middleware: `requireUser`, `originCheck`, `rateLimits`, `validate`
  - Frontend auth pages (`register.html`, `login.html`), `api.js`, `ui.js`

- [ ] **Phase 3 — Tenancies, timeline, dashboard**
  - Migration `002_tenancies_inspections_events.sql` (tenancies, inspections with `inspections_guard`, events with append-only triggers)
  - Event recording helper (`lib/events.js`)
  - Tenancy creation (atomic creation of tenancy + move-in inspection draft + event)
  - Tenancies dashboard (`tenancies.html`, `tenancy.html`) and rupee/paise converter (`public/js/money.js`)

- [ ] **Phase 4 — Inspection items and editor**
  - Migration `003_inspection_items.sql` with `require_draft_inspection` trigger
  - Item CRUD APIs with 300 items max limit and duplicate checking
  - Inspection editor page (`inspection.html`) with room grouping and quick-add common items

- [ ] **Phase 5 — Photos**
  - Install `multer`, `sharp`
  - Migration `004_media.sql` with lock trigger and unique `(item_id, sha256)`
  - Storage abstraction (`lib/storage/local.js`)
  - Upload pipeline: resize to 1600x1600, strip EXIF, convert to JPEG quality 80, max 8 photos per item
  - Photo attachment UI in inspection editor

- [ ] **Phase 6 — Submit, landlord link, acknowledge and lock**
  - Migration `005_invites.sql` and token hashing helper (`lib/tokens.js`)
  - Inspection submit endpoint with validation
  - Landlord link generation (one-time return of URL, revocation of prior links)
  - Landlord token endpoints and read-only review view (`landlord.html`)
  - Acknowledge and request-changes actions

- [ ] **Phase 7 — Move-out and comparison**
  - Move-out start endpoint (cloning items without conditions/photos, atomic state transition)
  - Comparison pure logic (`lib/comparison.js`)
  - Move-out submission moving tenancy to `settling`
  - Comparison view (`compare.html`) for tenant and landlord

- [ ] **Phase 8 — Deductions, settlement, close**
  - Migration `006_deduction_lines.sql`
  - Deduction proposals by landlord linked to move-out items, capped at deposit
  - Tenant accept/dispute actions and landlord withdraw action
  - Settlement summary computation
  - Tenancy closing with unresolved deductions acknowledgement
  - Settlement page (`settlement.html`)

- [ ] **Phase 9 — PDF report**
  - Install `pdfkit`
  - Streamed PDF generator: tenancy details, timeline, comparison table, deductions, settlement, key photos
  - Download endpoint and UI button

- [ ] **Phase 10 — Hardening, accessibility, demo data**
  - Security review (IDOR coverage, rate limits, CSP headers)
  - Accessibility pass (touch targets >= 44px, keyboard navigation, contrast, text+icon indicators)
  - Demo seed script (`scripts/seed-demo.js`)
  - Finalized demo script and testing guide

- [ ] **Phase 11 — Deployment evaluation**
  - Evaluation of free-tier hosting candidates (Render + Neon / storage)
  - Deployment runbook (`docs/DEPLOYMENT.md`)
