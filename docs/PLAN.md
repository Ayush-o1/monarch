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
  - Migrations `001_users_sessions.sql` (users, session) and `002_users_checks.sql` (name/email checks)
  - Enhanced health check running database query
  - Test database runner and tests

- [x] **Phase 2 — Authentication**
  - Install `zod`, `bcryptjs`, `express-session`, `connect-pg-simple`, `express-rate-limit`
  - Auth module (register, login, logout, me) with bcrypt cost 12
  - Middleware: `requireUser`, `originCheck`, `rateLimits`, `validate`
  - Frontend auth pages (`register.html`, `login.html`), `api.js`, `ui.js`

- [x] **Phase 3 — Tenancies, timeline, dashboard**
  - Migration `003_tenancies_inspections_events.sql` (tenancies, inspections with `inspections_guard`, events with append-only triggers)
  - Event recording helper (`lib/events.js`)
  - Tenancy creation (atomic creation of tenancy + move-in inspection draft + event)
  - Tenancies dashboard (`tenancies.html`, `tenancy.html`) and rupee/paise converter (`public/js/money.js`)

- [x] **Phase 4 — Inspection items and editor**
  - Migration `004_inspection_items.sql` with tightened `inspections_guard` and `require_draft_inspection` trigger (FOR SHARE check)
  - Item CRUD APIs with 300 items max limit, position tracking, duplicate checking via unique index, and error mapping
  - Inspection editor page (`inspection.html`) with room grouping, auto-save, quick-add common items, and read-only mode for non-drafts

- [x] **Phase 5 — Photos**
  - Install `multer`, `sharp`
  - Migration `005_media.sql` with lock trigger and unique `(item_id, sha256)`
  - Storage abstraction (`lib/storage/local.js`)
  - Upload pipeline: resize to 1600x1600, strip EXIF, convert to JPEG quality 80, max 8 photos per item
  - Photo attachment UI in inspection editor

- [x] **Phase 6 — Submit, landlord link, acknowledge and lock**
  - Migration `006_invites.sql` and token hashing helper (`lib/tokens.js`)
  - Inspection submit endpoint with validation
  - Landlord link generation (one-time return of URL, revocation of prior links)
  - Landlord token endpoints and read-only review view (`landlord.html`)
  - Acknowledge and request-changes actions

- [x] **Phase 7 — Move-out and comparison**
  - Move-out start endpoint `POST /api/tenancies/:id/move-out` (cloning items without conditions/notes/photos, atomic transition to `move_out`, event `move_out_started`)
  - Comparison pure logic (`src/lib/comparison.js`) with outcomes: `worse`, `same`, `better`, `new_at_move_out`, `not_in_move_out`
  - Move-out inspection submission atomically transitioning tenancy to `settling`
  - Tenant comparison endpoint `GET /api/tenancies/:id/comparison`
  - Landlord comparison endpoint `GET /api/landlord/:token/comparison` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
  - Dual-mode comparison view (`compare.html`, `public/js/pages/compare.js`) supporting tenant and landlord (`/l/:token/compare`)

- [x] **Phase 8 — Deductions, settlement, close**
  - Migration `007_deduction_lines.sql` (immutable fields trigger, cap guard trigger, status transitions)
  - Pure settlement maths engine (`src/lib/settlement.js`) and unit test suite
  - Deduction proposals by landlord linked to move-out items, capped at deposit
  - Tenant accept/dispute conditional updates and landlord withdrawal
  - Pure comparison item linkage (`linkedChange` and photo thumbnails)
  - Tenancy closing with unresolved deductions acknowledgement
  - Dual UI: Tenant settlement page (`settlement.html`) and Landlord deduction management (`landlord.html`)

- [x] **Phase 9 — PDF report**
  - Install `pdfkit`
  - Streamed PDF generator: tenancy details, timeline, comparison, deductions, settlement summary, capped & shrunk photos
  - Pure sanitiser `toPdfText` and `formatPdfMoney` using "Rs"
  - Download endpoint `GET /api/tenancies/:id/report.pdf` (tenant session only) and UI download link with notice

- [ ] **Phase 10 — Hardening, accessibility, demo data**
  - Security review (IDOR coverage, rate limits, CSP headers)
  - Accessibility pass (touch targets >= 44px, keyboard navigation, contrast, text+icon indicators)
  - Demo seed script (`scripts/seed-demo.js`)
  - Finalized demo script and testing guide

- [ ] **Phase 11 — Deployment evaluation**
  - Evaluation of free-tier hosting candidates (Render + Neon / storage)
  - Deployment runbook (`docs/DEPLOYMENT.md`)
