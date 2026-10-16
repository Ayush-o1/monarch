# Testing Guide

## 1. Running Tests

Tests use Node.js built-in test runner (`node:test`) and `supertest`.

- **Run all tests:**

  ```bash
  npm test
  ```

- **Run only unit tests:**

  ```bash
  NODE_ENV=test node --env-file=.env --test 'tests/unit/**/*.test.js'
  ```

- **Run only integration tests:**

  ```bash
  NODE_ENV=test node --env-file=.env --test --test-concurrency=1 'tests/integration/**/*.test.js'
  ```

- **Run code quality checks:**
  ```bash
  npm run lint
  npm run format:check
  ```

## 2. Test Database Setup & Reset

The test suite runs against a dedicated test database (`monarch_test`).

1. **Create the database (one-time setup):**

   ```bash
   createdb monarch_test
   ```

2. **Run migrations against test DB:**

   ```bash
   npm run migrate:test
   ```

3. **Reset test database (if clean slate is needed):**
   ```bash
   dropdb --if-exists monarch_test
   createdb monarch_test
   npm run migrate:test
   ```

_Note: Tests isolate themselves by creating unique users with random emails. Do not use TRUNCATE on the `events` table because it is protected by append-only triggers._

## 3. Manual Testing Checklists

### Phase 0 Checklist

- [x] `npm test` passes without errors.
- [x] `npm run lint` and `npm run format:check` pass.
- [x] Run `npm run dev`:
  - `curl -i http://localhost:3000/api/health` returns HTTP 200 `{"status":"ok"}`.
  - `curl -i http://localhost:3000/api/nope` returns HTTP 404 with error JSON.
  - Open `http://localhost:3000` in browser: minimal page loads with product name and legal notice.
- [x] Start server with `SESSION_SECRET=short` to confirm fast failure.

### Phase 4 Checklist (Items & Lock Trigger)

- [x] Item CRUD in draft status: create, patch, delete, get inspection items.
- [x] Unique item constraint: duplicate room and name (case-insensitive) returns 409 DUPLICATE_ITEM.
- [x] Item cap: creating beyond 300 items per inspection returns 422 TOO_MANY_ITEMS.
- [x] Inspection lock trigger: updating, deleting, or inserting items when inspection status is not draft fails with 409 INSPECTION_LOCKED (`LOCKED:...`).
- [x] Item immutability: attempting to change an item's `inspection_id` fails.
- [x] Strict inspections guard: any update on an acknowledged inspection fails.
- [x] Concurrency: draft lock during status transition blocks concurrent item creation until resolution.

### Phase 5 Checklist (Photos & Media)

- [ ] Upload valid JPEG, PNG, and WebP: processed to JPEG <= 1600x1600 quality 80.
- [ ] Format refusal: non-image or corrupted files return 415 UNSUPPORTED_MEDIA.
- [ ] Size limit: file exceeding limit returns 413 FILE_TOO_LARGE.
- [ ] Validation: missing photo field returns 400 VALIDATION_ERROR.
- [ ] Photo cap: 9th photo on an item returns 422 TOO_MANY_PHOTOS.
- [ ] Deduplication: uploading identical photo to same item returns 409 DUPLICATE_PHOTO without leaving orphan storage files.
- [ ] Privacy: EXIF and GPS metadata stripped during processing; photos served only through authenticated routes.
- [ ] Draft lock: uploading or deleting photos on submitted/acknowledged inspections fails with 409 INSPECTION_LOCKED.
- [ ] Cascade delete: deleting an item cascades to delete media rows and deletes physical files from disk.
- [ ] Storage traversal defense: refusal of path traversal attempts outside UPLOAD_DIR.
- [ ] UI: thumbnail strip, loading="lazy", full-view in new tab, upload busy state, and deletion confirmation.

### Phase 6 Checklist (Submit, Landlord Link, Acknowledge, Lock)

- [ ] Inspection submission validation:
  - Empty inspection returns 422 NO_ITEMS.
  - Items missing condition return 422 INCOMPLETE_ITEMS with item details.
  - Submitting when not in draft returns 409 INSPECTION_NOT_DRAFT.
  - Move-in submission when tenancy is not active returns 409.
- [ ] Submission success: sets status to submitted, captures submitted_at timestamp, records inspection_submitted event with photo counts.
- [ ] Draft lock: editing items, creating items, or uploading/deleting media on submitted inspections returns 409 INSPECTION_LOCKED.
- [ ] Landlord link creation:
  - Generates 43-character base64url token; stores only SHA-256 hash in database.
  - Displayed once in read-only input with Copy button and expiry date.
  - Creating a new link automatically revokes previous link.
  - Revoking link sets revoked_at and returns 204.
- [ ] Landlord review page (`/l/:token`):
  - Invalid format returns 404 without querying database.
  - Revoked link returns 410 LINK_REVOKED.
  - Expired link returns 410 LINK_EXPIRED.
  - Tenant email, user id, and password_hash are strictly absent from response.
  - Draft inspections are completely hidden.
- [ ] Two-window manual walkthrough:
  - **Window A (Tenant)**:
    1. Create tenancy, add items with conditions and photos.
    2. Click "Submit for review", observe confirm prompt detailing items without photos.
    3. Click "Create Review Link" under "Share with Landlord"; copy link.
  - **Window B (Landlord in Private Window)**:
    1. Open the copied URL (`http://localhost:3000/l/<token>`).
    2. Confirm property details, deposit, items grouped by room with condition icons and photo thumbnails.
    3. Enter name, click "Request Changes" with note "Please check sink faucet".
  - **Window A (Tenant)**:
    1. Reload inspection editor; observe red banner displaying landlord's note and name.
    2. Edit item and click "Submit for review" again.
  - **Window B (Landlord)**:
    1. Reload page; observe inspection updated.
    2. Enter name, click "Acknowledge Record".
    3. Confirm card updates to acknowledged state with permanent lock.
  - **Window A (Tenant)**:
    1. Reload tenancy; observe move-in inspection status is ACKNOWLEDGED.
    2. Click "Revoke Link"; observe link status updating to "No active link".
  - **Window B (Landlord)**:
    1. Reload page; confirm 410 "This link has expired or was replaced".

### Phase 7 Checklist (Move-out and Comparison)

- [ ] Move-out start requirements:
  - Tenancy must be active and move-in inspection submitted or acknowledged.
  - Calling before move-in is submitted returns 409 INVALID_STATE.
  - Clones move-in items with blank condition and note; 0 media rows copied.
  - Updates tenancy status to `move_out` and records `move_out_started` event.
  - Exactly one move-out inspection allowed per tenancy.
- [ ] Move-out submission:
  - Tenancy must be in `move_out` status.
  - Requires >= 1 item and condition assigned on every item.
  - Submitting transitions tenancy status to `settling` and records `inspection_submitted` event.
  - Permanently locks move-out inspection items and media from mutation.
- [ ] Comparison availability & privacy:
  - Unavailable (409 INVALID_STATE) while move-out is in draft for both tenant and landlord.
  - Draft move-out inspection is invisible to landlord.
  - Tenant comparison available at `/compare.html?id=<tenancyId>`.
  - Landlord comparison available at `/l/:token/compare`.
  - Landlord responses strictly omit tenant email, user id, password hashes, and tokens.
  - Both `/api/landlord/:token/comparison` and `/l/:token/compare` set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- [ ] Landlord move-out review:
  - Move-out inspection displayed with room-grouped items, conditions, notes, and photos.
  - Landlord can acknowledge move-out, permanently locking the record.
  - Requesting changes on move-out returns 409 INVALID_STATE.
- [ ] Comparison page features:
  - Side-by-side comparison of move-in and move-out conditions and photos.
  - Visual indicators for outcomes: worse, same, better, added at move-out, not in move-out.
  - Summary metric cards for total, worse, same, better, added, missing items.
  - Photo thumbnail strip with lightbox full-size viewer.
