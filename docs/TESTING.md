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

### Phase 8 Two-Window Manual Checklist (Deductions, Settlement, Close)

Follow this step-by-step procedure using two browser windows (Window A for Tenant, Window B for Landlord) to verify the end-to-end settlement lifecycle.

#### 1. Preflight and Setup

- **Window A (Tenant)**:
  1. Log in and navigate to an active tenancy.
  2. Complete and submit the move-in inspection; in Window B acknowledge it.
  3. Start the move-out inspection, fill in conditions/photos, and submit it.
  4. Tenancy status transitions to `settling`.
  5. In tenancy details, confirm the new card "Deposit Settlement & Deductions" appears with button "View Settlement →".

#### 2. Tenant Settlement Initial State

- **Window A (Tenant)**:
  1. Click "View Settlement →" (`/settlement.html?id=<tenancyId>`).
  2. Verify totals panel:
     - Total Deposit matches tenancy deposit.
     - Accepted: ₹0.00.
     - Awaiting Response: ₹0.00.
     - Disputed: ₹0.00.
     - Unclaimed Deposit: ₹<full deposit>.
  3. Verify timeline info displays days since move-out and agreed refund window with neutral, informative wording.
  4. Verify empty state displays "No deductions proposed yet."

#### 3. Landlord Deduction Proposals & Cap Enforcements

- **Window B (Landlord)**:
  1. Open `/l/:token`. Scroll to "Deposit Settlement Summary" and "Propose a Deduction".
  2. Verify move-out item select dropdown lists all move-out items with their change badges (e.g. `Condition worse at move-out`, `No change recorded`), plus "Not linked to an item".
  3. **Test Cap Enforcement**:
     - Enter an amount larger than the deposit (e.g. ₹999,999).
     - Click "Propose Deduction".
     - Observe error message stating the deposit is exceeded and showing the maximum remaining rupee amount.
     - Confirm form was disabled while submitting and re-enabled after error.
  4. **Propose Valid Linked Line**:
     - Select a move-out item (e.g. Fridge).
     - Enter Description: "Fridge shelf crack repair".
     - Enter Amount: `1500.00`.
     - Click "Propose Deduction".
     - Confirm line appears in list as "Awaiting response", linked to the item, and totals update.
  5. **Propose Unlinked Line**:
     - Select "Not linked to an item".
     - Enter Description: "Lost keys replacement".
     - Enter Amount: `500.00`.
     - Click "Propose Deduction".
     - Confirm line appears as "Not linked to an item".

#### 4. Tenant Responses (Accept & Dispute)

- **Window A (Tenant)**:
  1. Refresh `/settlement.html?id=<tenancyId>`.
  2. Observe both proposed lines with correct amounts and status "Awaiting response".
  3. For the linked line, verify move-in and move-out photo thumbnails are shown.
  4. Click a photo thumbnail; confirm the lightbox modal displays the full photo.
  5. **Accept Deduction**:
     - Click "Accept Deduction" on Line 1. Confirm the dialog prompt.
     - Observe line status updates to "Accepted".
     - Verify totals panel: Accepted = ₹1,500.00; Unclaimed decreased by ₹1,500.00.
  6. **Dispute Deduction**:
     - On Line 2, click "Dispute".
     - Verify note field appears.
     - Enter note: "Keys were returned in the mailbox on move-out day."
     - Click "Submit Dispute".
     - Observe line status updates to "Disputed" with the tenant note displayed.
     - Verify totals panel: Disputed = ₹500.00; Awaiting Response = ₹0.00.

#### 5. Landlord Withdrawal

- **Window B (Landlord)**:
  1. Refresh `/l/:token`.
  2. Observe Line 1 shows "Accepted" (Withdraw button is not available).
  3. Observe Line 2 shows "Disputed" with the tenant note and a "Withdraw Deduction" button.
  4. Click "Withdraw Deduction" on Line 2; confirm the prompt.
  5. Observe Line 2 updates to "Withdrawn".
  6. Confirm totals panel updates: Disputed returns to ₹0.00, and the ₹500.00 is returned to Unclaimed Deposit.

#### 6. Tenancy Closure & Finalization

- **Window B (Landlord)**:
  1. Propose one more line for ₹200.00 ("Minor cleaning fee") to leave an unresolved line.
- **Window A (Tenant)**:
  1. Refresh `/settlement.html?id=<tenancyId>`.
  2. Click "Close Tenancy".
  3. Verify confirm modal opens and states: "There are 1 unresolved deduction line(s) (1 awaiting response, 0 disputed)."
  4. Verify the "Confirm Close" button is disabled until the acknowledgment checkbox is ticked.
  5. Tick "[x] I acknowledge that there are 1 unresolved deduction(s) and wish to close the tenancy."
  6. Click "Confirm Close".
  7. Tenancy status updates to `CLOSED`.
  8. Observe the page enters read-only mode: "Close Tenancy" section is hidden, and no Accept/Dispute action buttons are visible.
- **Window B (Landlord)**:
  1. Refresh `/l/:token`.
  2. Observe Propose Deduction form is hidden.
  3. Tenancy status displays `CLOSED`.
  4. Verify calling propose or withdraw APIs returns 409 `TENANCY_CLOSED`.
- **Window A (Tenant)**:
  1. Navigate back to `/tenancy.html?id=<tenancyId>`.
  2. Review the Timeline: confirm `deduction_proposed`, `deduction_accepted`, `deduction_disputed`, `deduction_withdrawn`, and `tenancy_closed` events are rendered in chronological order with plain, informative wording.

### Phase 9 Checklist (Handover PDF Report)

#### 1. Download Link and Notice in UI

- [ ] Log in as a tenant and navigate to `/tenancy.html?id=<tenancyId>`.
- [ ] Verify "Download PDF report" link is present in the tenancy details section.
- [ ] Verify the muted helper note next to the link reads:
      `The PDF includes up to 40 photos (items linked to deductions or marked worse). Text in non-Latin scripts may appear as question marks.`
- [ ] Click the link: browser downloads `handover-<slug>-<YYYY-MM-DD>.pdf`.

#### 2. Manual Visual PDF Review Checklist

Open the generated PDF document (e.g. `/tmp/handover-manual-test.pdf`) in a standard PDF viewer (such as Preview, Adobe Acrobat, or Chrome) and verify:

- [ ] **Page Count & Progression**: The total page count is exact (e.g. 2 pages for standard flow).
- [ ] **No Blank Pages**: The last page and intermediate pages contain actual content without any trailing or accidental blank pages.
- [ ] **Running Footers on Every Page**:
  - Top line: `Handover records what the parties entered and acknowledged. It is not legal advice.` (centered, muted text).
  - Bottom line: `Page X of Y • YYYY-MM-DD HH:mm:ss UTC` (centered, muted text).
  - Footer does not collide with page body content (50pt margins maintained).
- [ ] **Document Structure & Flow**:
  - Title: "Handover record: <Property Label>" in bold, large heading.
  - Tenancy Details block: Property label, address, tenant name, landlord name, deposit in `Rs X,XX,XXX.XX`, refund window in days, lease start date, status, generated UTC time.
  - Move-in record: Status, submitted time, acknowledged time, acknowledged by name, items grouped cleanly by room with conditions and notes.
  - Move-out record: Same layout as move-in record.
  - Comparison: One line per item matching `Room - Item: <move-in condition> -> <move-out condition> [Outcome]`.
  - Deductions: Description, amount in `Rs X,XX,XXX.XX`, status, linked item, tenant note, who proposed it, created/responded UTC times.
  - Settlement summary: Clean breakdown of Deposit, Accepted, Awaiting, Disputed, and Unclaimed amounts.
  - Timeline: Every tenancy event listed in chronological order with UTC timestamp, actor label/type, and plain-words description matching UI wording.
  - Photos section: Embedded photos with captions `Room • Item • Move-in/Move-out • YYYY-MM-DD HH:mm:ss UTC`.
- [ ] **Text Wrapping**: Descriptions, notes, long addresses, and multi-line event details wrap gracefully without horizontal clipping or overflow.
- [ ] **Headings & Orphans**: Section headings do not sit alone at the bottom of a page without content underneath.
- [ ] **Photos Quality & Proportions**: Shrunk photos maintain clear aspect ratio, are centered/aligned, and are visually legible without pixelation or bloating.
- [ ] **Edge Cases**:
  - Missing inspection or deduction displays `"Not yet recorded"`.
  - Missing photo file on disk renders `"Photo unavailable"`.
  - Tenancies exceeding 40 photos display `"N more photos not shown"`.
- [ ] **Privacy Inspection**: Confirm zero instances of tenant email, user UUIDs, raw invite tokens, or internal storage keys anywhere in the visible PDF or text layers.
