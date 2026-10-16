import crypto from 'node:crypto';
import sharp from 'sharp';
import { pool as defaultPool } from '../../db/pool.js';
import defaultStorage from '../../lib/storage/local.js';
import { AppError } from '../../lib/errors.js';

export async function uploadMedia({
  itemId,
  tenantId,
  fileBuffer,
  pool = defaultPool,
  storage = defaultStorage,
}) {
  // 1. Authorise before processing: find item joined to inspection and tenancy filtered by session user
  const authRes = await pool.query(
    `SELECT item.id, item.inspection_id, i.status AS inspection_status, t.id AS tenancy_id
     FROM inspection_items item
     JOIN inspections i ON i.id = item.inspection_id
     JOIN tenancies t ON t.id = i.tenancy_id
     WHERE item.id = $1 AND t.tenant_id = $2`,
    [itemId, tenantId]
  );

  if (authRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Item not found');
  }

  const { inspection_status: inspectionStatus, tenancy_id: tenancyId } =
    authRes.rows[0];

  if (inspectionStatus !== 'draft') {
    throw new AppError(
      409,
      'INSPECTION_LOCKED',
      'Inspection is not in draft status'
    );
  }

  // 2. Process image with sharp: limit pixels to 40M, decode and check format
  const image = sharp(fileBuffer, { limitInputPixels: 40_000_000 });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new AppError(415, 'UNSUPPORTED_MEDIA', 'Invalid image data');
  }

  const allowedFormats = ['jpeg', 'png', 'webp'];
  if (!metadata.format || !allowedFormats.includes(metadata.format)) {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA',
      'Only JPEG, PNG and WebP formats are allowed'
    );
  }

  let processedBuffer;
  try {
    // Rotate (apply EXIF orientation), resize inside 1600x1600 without enlargement, encode to JPEG quality 80
    // Do NOT call withMetadata (this strips EXIF and GPS)
    processedBuffer = await sharp(fileBuffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    throw new AppError(415, 'UNSUPPORTED_MEDIA', 'Error processing image');
  }

  // 3. Compute sha256 hash and file size
  const sha256 = crypto
    .createHash('sha256')
    .update(processedBuffer)
    .digest('hex');
  const sizeBytes = processedBuffer.length;

  // 4. Generate key and write file to storage FIRST
  const storageKey = `${tenancyId}/${crypto.randomUUID()}.jpg`;
  await storage.save(storageKey, processedBuffer);

  // 5. In one transaction: lock item FOR UPDATE, count photos, insert row
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemLock = await client.query(
      `SELECT item.id, i.status AS inspection_status
       FROM inspection_items item
       JOIN inspections i ON i.id = item.inspection_id
       WHERE item.id = $1
       FOR UPDATE OF item`,
      [itemId]
    );

    if (itemLock.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Item not found');
    }

    if (itemLock.rows[0].inspection_status !== 'draft') {
      throw new AppError(
        409,
        'INSPECTION_LOCKED',
        'Inspection is not in draft status'
      );
    }

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM media WHERE item_id = $1`,
      [itemId]
    );

    if (countRes.rows[0].count >= 8) {
      throw new AppError(
        422,
        'TOO_MANY_PHOTOS',
        'An item cannot have more than 8 photos'
      );
    }

    const insertRes = await client.query(
      `INSERT INTO media (item_id, storage_key, sha256, mime, size_bytes)
       VALUES ($1, $2, $3, 'image/jpeg', $4)
       RETURNING id, item_id, size_bytes, uploaded_at`,
      [itemId, storageKey, sha256, sizeBytes]
    );

    await client.query('COMMIT');

    const row = insertRes.rows[0];
    return {
      id: row.id,
      itemId: row.item_id,
      sizeBytes: row.size_bytes,
      uploadedAt: row.uploaded_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    // If anything fails, remove the file
    await storage
      .remove(storageKey)
      .catch((removeErr) =>
        console.warn('Failed to cleanup file on error:', removeErr.message)
      );

    if (err.code === '23505') {
      throw new AppError(
        409,
        'DUPLICATE_PHOTO',
        'This photo has already been uploaded for this item'
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getMediaStream({
  mediaId,
  tenantId,
  pool = defaultPool,
  storage = defaultStorage,
}) {
  const res = await pool.query(
    `SELECT m.id, m.storage_key, m.mime, m.size_bytes, m.uploaded_at
     FROM media m
     JOIN inspection_items item ON item.id = m.item_id
     JOIN inspections i ON i.id = item.inspection_id
     JOIN tenancies t ON t.id = i.tenancy_id
     WHERE m.id = $1 AND t.tenant_id = $2`,
    [mediaId, tenantId]
  );

  if (res.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Media not found');
  }

  const media = res.rows[0];

  try {
    const stream = storage.createReadStream(media.storage_key);
    return { stream, media };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`Media file missing on disk for media id: ${mediaId}`);
      throw new AppError(404, 'NOT_FOUND', 'Media file not found');
    }
    throw err;
  }
}

export async function deleteMedia({
  mediaId,
  tenantId,
  pool = defaultPool,
  storage = defaultStorage,
}) {
  const client = await pool.connect();
  let storageKey;

  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT m.id, m.storage_key, i.status AS inspection_status
       FROM media m
       JOIN inspection_items item ON item.id = m.item_id
       JOIN inspections i ON i.id = item.inspection_id
       JOIN tenancies t ON t.id = i.tenancy_id
       WHERE m.id = $1 AND t.tenant_id = $2
       FOR UPDATE OF m`,
      [mediaId, tenantId]
    );

    if (res.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Media not found');
    }

    const { storage_key: key, inspection_status: inspectionStatus } =
      res.rows[0];
    storageKey = key;

    if (inspectionStatus !== 'draft') {
      throw new AppError(
        409,
        'INSPECTION_LOCKED',
        'Inspection is not in draft status'
      );
    }

    await client.query(`DELETE FROM media WHERE id = $1`, [mediaId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Remove the file after commit. If it fails, log a warning, do not fail the request.
  if (storageKey) {
    await storage.remove(storageKey).catch((err) => {
      console.warn('Failed to remove media file from storage:', err.message);
    });
  }

  return { success: true };
}
