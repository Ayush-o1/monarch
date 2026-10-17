import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import config from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { compareInspections } from '../../lib/comparison.js';
import { computeSettlement } from '../../lib/settlement.js';
import defaultStorage from '../../lib/storage/local.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Loads and prepares all tenancy data for report generation.
 * All DB queries and image processing are performed up front.
 *
 * @param {string} tenancyId
 * @param {string} userId
 * @param {object} options
 * @param {object} options.pool
 * @param {object} [options.storage]
 * @returns {Promise<object>} Report data payload
 */
export async function loadReportData(
  tenancyId,
  userId,
  { pool, storage = defaultStorage } = {}
) {
  if (!tenancyId || !UUID_REGEX.test(tenancyId)) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  // 1. Fetch tenancy with tenant name (never expose email)
  const tenancyRes = await pool.query(
    `SELECT
       t.id,
       t.property_label,
       t.address,
       t.landlord_name,
       t.deposit_paise,
       t.refund_window_days,
       t.lease_start_date,
       t.status,
       t.created_at,
       t.updated_at,
       u.name AS tenant_name
     FROM tenancies t
     JOIN users u ON u.id = t.tenant_id
     WHERE t.id = $1 AND t.tenant_id = $2`,
    [tenancyId, userId]
  );

  if (tenancyRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const tenancy = tenancyRes.rows[0];

  // 2. Fetch inspections
  const inspRes = await pool.query(
    `SELECT
       id,
       type,
       status,
       submitted_at,
       acknowledged_at,
       acknowledged_by_name,
       created_at
     FROM inspections
     WHERE tenancy_id = $1
     ORDER BY created_at ASC`,
    [tenancyId]
  );

  const moveInInsp = inspRes.rows.find((i) => i.type === 'move_in');
  const moveOutInsp = inspRes.rows.find((i) => i.type === 'move_out');

  const inspectionIds = inspRes.rows.map((i) => i.id);

  // 3. Fetch items with media
  let moveInItems = [];
  let moveOutItems = [];

  if (inspectionIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT
         ii.id,
         ii.inspection_id,
         ii.room,
         ii.name,
         ii.condition,
         ii.note,
         COALESCE(
           json_agg(
             json_build_object(
               'id', m.id,
               'storage_key', m.storage_key,
               'uploaded_at', m.uploaded_at
             ) ORDER BY m.uploaded_at ASC
           ) FILTER (WHERE m.id IS NOT NULL),
           '[]'
         ) AS media
       FROM inspection_items ii
       LEFT JOIN media m ON m.item_id = ii.id
       WHERE ii.inspection_id = ANY($1::uuid[])
       GROUP BY ii.id
       ORDER BY ii.room ASC, ii.name ASC`,
      [inspectionIds]
    );

    for (const it of itemsRes.rows) {
      if (moveInInsp && it.inspection_id === moveInInsp.id) {
        moveInItems.push(it);
      } else if (moveOutInsp && it.inspection_id === moveOutInsp.id) {
        moveOutItems.push(it);
      }
    }
  }

  // 4. Group items by room for move-in and move-out records
  const groupItemsByRoom = (items) => {
    const map = new Map();
    for (const it of items) {
      const room = it.room || 'General';
      if (!map.has(room)) {
        map.set(room, []);
      }
      map.get(room).push({
        id: it.id,
        name: it.name,
        condition: it.condition,
        note: it.note,
      });
    }
    return Array.from(map.entries()).map(([room, roomItems]) => ({
      room,
      items: roomItems,
    }));
  };

  const moveInRecord = moveInInsp
    ? {
        status: moveInInsp.status,
        submittedAt: moveInInsp.submitted_at,
        acknowledgedAt: moveInInsp.acknowledged_at,
        acknowledgedByName: moveInInsp.acknowledged_by_name,
        rooms: groupItemsByRoom(moveInItems),
      }
    : null;

  const moveOutRecord = moveOutInsp
    ? {
        status: moveOutInsp.status,
        submittedAt: moveOutInsp.submitted_at,
        acknowledgedAt: moveOutInsp.acknowledged_at,
        acknowledgedByName: moveOutInsp.acknowledged_by_name,
        rooms: groupItemsByRoom(moveOutItems),
      }
    : null;

  // 5. Comparison (available once move-out is submitted or acknowledged)
  let comparison = null;
  if (moveOutInsp && moveOutInsp.status !== 'draft') {
    comparison = compareInspections(moveInItems, moveOutItems);
  }

  // 6. Deductions and settlement
  const linesRes = await pool.query(
    `SELECT
       dl.id,
       dl.item_id,
       dl.description,
       dl.amount_paise,
       dl.status,
       dl.tenant_note,
       dl.created_by_name,
       dl.created_at,
       dl.responded_at,
       ii.room AS item_room,
       ii.name AS item_name
     FROM deduction_lines dl
     LEFT JOIN inspection_items ii ON ii.id = dl.item_id
     WHERE dl.tenancy_id = $1
     ORDER BY dl.created_at ASC`,
    [tenancyId]
  );

  const deductions = linesRes.rows.map((row) => ({
    id: row.id,
    itemId: row.item_id || null,
    itemRoom: row.item_room || null,
    itemName: row.item_name || null,
    description: row.description,
    amountPaise: Number(row.amount_paise),
    status: row.status,
    tenantNote: row.tenant_note || null,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    respondedAt: row.responded_at || null,
  }));

  const settlement = computeSettlement({
    depositPaise: tenancy.deposit_paise,
    lines: deductions,
    moveOutSubmittedAt: moveOutInsp?.submitted_at,
    refundWindowDays: tenancy.refund_window_days,
    now: new Date(),
  });

  // 7. Events (Timeline)
  const eventsRes = await pool.query(
    `SELECT
       id,
       tenancy_id,
       actor_type,
       actor_label,
       type,
       payload,
       created_at
     FROM events
     WHERE tenancy_id = $1
     ORDER BY created_at ASC`,
    [tenancyId]
  );

  // 8. Photos selection
  // "include one photo per side (move-in and move-out) only for items that are linked
  // to a non-withdrawn deduction line OR have comparison result worse, at most 40 images in total."
  const nonWithdrawnItemIds = new Set(
    deductions
      .filter((l) => l.status !== 'withdrawn' && l.itemId)
      .map((l) => l.itemId)
  );

  const moveInById = new Map(moveInItems.map((it) => [it.id, it]));
  const moveOutById = new Map(moveOutItems.map((it) => [it.id, it]));

  const qualifyingCandidatePhotos = [];

  if (comparison && comparison.items) {
    for (const item of comparison.items) {
      const isWorse = item.outcome === 'worse';
      const isLinkedDeduction =
        item.moveOut?.id && nonWithdrawnItemIds.has(item.moveOut.id);

      if (isWorse || isLinkedDeduction) {
        const origIn = item.moveIn?.id ? moveInById.get(item.moveIn.id) : null;
        const origOut = item.moveOut?.id
          ? moveOutById.get(item.moveOut.id)
          : null;

        // Move-in side photo
        if (origIn && origIn.media && origIn.media.length > 0) {
          const m = origIn.media[0];
          qualifyingCandidatePhotos.push({
            room: item.room,
            itemName: item.name,
            side: 'Move-in',
            uploadedAt: m.uploaded_at,
            storageKey: m.storage_key,
          });
        }

        // Move-out side photo
        if (origOut && origOut.media && origOut.media.length > 0) {
          const m = origOut.media[0];
          qualifyingCandidatePhotos.push({
            room: item.room,
            itemName: item.name,
            side: 'Move-out',
            uploadedAt: m.uploaded_at,
            storageKey: m.storage_key,
          });
        }
      }
    }
  }

  const totalQualifyingCount = qualifyingCandidatePhotos.length;
  const photosToLoad = qualifyingCandidatePhotos.slice(0, 40);
  const morePhotosCount = Math.max(0, totalQualifyingCount - 40);

  const uploadDir = path.resolve(
    storage.uploadDir || process.env.UPLOAD_DIR || config.uploadDir
  );

  const loadedPhotos = [];
  for (const photo of photosToLoad) {
    let buffer = null;
    let unavailable = false;

    try {
      const filePath = path.resolve(uploadDir, photo.storageKey);
      const relative = path.relative(uploadDir, filePath);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !fs.existsSync(filePath)
      ) {
        unavailable = true;
      } else {
        const rawBuffer = await fsPromises.readFile(filePath);
        buffer = await sharp(rawBuffer)
          .resize(640, 480, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
      }
    } catch {
      unavailable = true;
    }

    // Do NOT include storageKey in the output object
    loadedPhotos.push({
      room: photo.room,
      itemName: photo.itemName,
      side: photo.side,
      uploadedAt: photo.uploadedAt,
      buffer,
      unavailable,
    });
  }

  return {
    tenancy: {
      id: tenancy.id,
      propertyLabel: tenancy.property_label,
      address: tenancy.address,
      tenantName: tenancy.tenant_name,
      landlordName: tenancy.landlord_name,
      depositPaise: Number(tenancy.deposit_paise),
      refundWindowDays: tenancy.refund_window_days,
      leaseStartDate: tenancy.lease_start_date,
      status: tenancy.status,
      createdAt: tenancy.created_at,
      updatedAt: tenancy.updated_at,
    },
    generatedAt: new Date().toISOString(),
    moveIn: moveInRecord,
    moveOut: moveOutRecord,
    comparison: comparison ? comparison.items : null,
    deductions,
    settlement,
    events: eventsRes.rows,
    photos: loadedPhotos,
    morePhotosCount,
  };
}
