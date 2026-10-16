import { pool as defaultPool } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import defaultStorage from '../../lib/storage/local.js';

export async function createInspectionItem(
  inspectionId,
  tenantId,
  { room, name, condition = null, note = null },
  pool = defaultPool
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. SELECT inspection joined to its tenancy with FOR UPDATE, filtered by tenant_id
    const inspRes = await client.query(
      `SELECT i.id, i.status
       FROM inspections i
       JOIN tenancies t ON t.id = i.tenancy_id
       WHERE i.id = $1 AND t.tenant_id = $2
       FOR UPDATE`,
      [inspectionId, tenantId]
    );

    if (inspRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Inspection not found');
    }

    const inspection = inspRes.rows[0];

    // 2. If status is not draft, return 409 INSPECTION_LOCKED
    if (inspection.status !== 'draft') {
      throw new AppError(
        409,
        'INSPECTION_LOCKED',
        'Inspection is not in draft status'
      );
    }

    // 3. Count items; if 300 or more return 422 TOO_MANY_ITEMS
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(MAX(position), -1)::int AS max_pos
       FROM inspection_items
       WHERE inspection_id = $1`,
      [inspectionId]
    );

    const itemCount = countRes.rows[0].count;
    if (itemCount >= 300) {
      throw new AppError(
        422,
        'TOO_MANY_ITEMS',
        'An inspection cannot exceed 300 items'
      );
    }

    const nextPosition = countRes.rows[0].max_pos + 1;
    const trimmedRoom = room.trim();
    const trimmedName = name.trim();

    // 4. Insert item (relying on unique index for duplicate detection)
    const insertRes = await client.query(
      `INSERT INTO inspection_items (
        inspection_id, room, name, condition, note, position
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        inspectionId,
        trimmedRoom,
        trimmedName,
        condition,
        note ? note.trim() : null,
        nextPosition,
      ]
    );

    await client.query('COMMIT');
    return insertRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function patchInspectionItem(
  itemId,
  tenantId,
  data,
  pool = defaultPool
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Find item by joining item -> inspection -> tenancy filtered by tenant_id
    const itemRes = await client.query(
      `SELECT item.*, i.status AS inspection_status
       FROM inspection_items item
       JOIN inspections i ON i.id = item.inspection_id
       JOIN tenancies t ON t.id = i.tenancy_id
       WHERE item.id = $1 AND t.tenant_id = $2
       FOR UPDATE`,
      [itemId, tenantId]
    );

    if (itemRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Item not found');
    }

    const current = itemRes.rows[0];

    if (current.inspection_status !== 'draft') {
      throw new AppError(
        409,
        'INSPECTION_LOCKED',
        'Inspection is not in draft status'
      );
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (data.room !== undefined) {
      updates.push(`room = $${idx++}`);
      values.push(data.room.trim());
    }

    if (data.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(data.name.trim());
    }

    if (data.condition !== undefined) {
      updates.push(`condition = $${idx++}`);
      values.push(data.condition);
    }

    if (data.note !== undefined) {
      updates.push(`note = $${idx++}`);
      values.push(data.note ? data.note.trim() : null);
    }

    if (updates.length === 0) {
      await client.query('COMMIT');
      return current;
    }

    updates.push(`updated_at = now()`);
    values.push(itemId);

    const updateQuery = `
      UPDATE inspection_items
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const result = await client.query(updateQuery, values);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteInspectionItem(
  itemId,
  tenantId,
  pool = defaultPool,
  storage = defaultStorage
) {
  const client = await pool.connect();
  let mediaKeys = [];

  try {
    await client.query('BEGIN');

    // Find item by joining item -> inspection -> tenancy filtered by tenant_id
    const itemRes = await client.query(
      `SELECT item.id, i.status AS inspection_status
       FROM inspection_items item
       JOIN inspections i ON i.id = item.inspection_id
       JOIN tenancies t ON t.id = i.tenancy_id
       WHERE item.id = $1 AND t.tenant_id = $2
       FOR UPDATE`,
      [itemId, tenantId]
    );

    if (itemRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Item not found');
    }

    const current = itemRes.rows[0];

    if (current.inspection_status !== 'draft') {
      throw new AppError(
        409,
        'INSPECTION_LOCKED',
        'Inspection is not in draft status'
      );
    }

    // Select storage keys before deleting item so photos can be cleaned up from disk
    const mediaRes = await client.query(
      `SELECT storage_key FROM media WHERE item_id = $1`,
      [itemId]
    );
    mediaKeys = mediaRes.rows.map((r) => r.storage_key);

    await client.query(`DELETE FROM inspection_items WHERE id = $1`, [itemId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Delete the files of its photos from storage after commit
  for (const key of mediaKeys) {
    await storage.remove(key).catch((err) => {
      console.warn('Failed to remove media file on item delete:', err.message);
    });
  }

  return { success: true };
}

export async function getInspectionWithItems(
  inspectionId,
  tenantId,
  pool = defaultPool
) {
  // Find inspection joined to tenancy
  const inspRes = await pool.query(
    `SELECT i.*, t.property_label
     FROM inspections i
     JOIN tenancies t ON t.id = i.tenancy_id
     WHERE i.id = $1 AND t.tenant_id = $2`,
    [inspectionId, tenantId]
  );

  if (inspRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Inspection not found');
  }

  const inspection = inspRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT id, inspection_id, room, name, condition, note, position, created_at, updated_at
     FROM inspection_items
     WHERE inspection_id = $1
     ORDER BY position ASC, created_at ASC`,
    [inspectionId]
  );

  const items = itemsRes.rows;

  if (items.length > 0) {
    const itemIds = items.map((it) => it.id);
    const mediaRes = await pool.query(
      `SELECT id, item_id, uploaded_at
       FROM media
       WHERE item_id = ANY($1::uuid[])
       ORDER BY uploaded_at ASC`,
      [itemIds]
    );

    const mediaByItem = new Map();
    for (const m of mediaRes.rows) {
      if (!mediaByItem.has(m.item_id)) {
        mediaByItem.set(m.item_id, []);
      }
      mediaByItem.get(m.item_id).push({
        id: m.id,
        uploadedAt: m.uploaded_at,
      });
    }

    for (const it of items) {
      it.media = mediaByItem.get(it.id) || [];
    }
  }

  return {
    ...inspection,
    items,
  };
}
