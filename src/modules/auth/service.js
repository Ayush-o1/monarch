import bcrypt from 'bcryptjs';
import { AppError } from '../../lib/errors.js';
import { pool as defaultPool } from '../../db/pool.js';

const DUMMY_HASH =
  '$2b$12$Kq67ZHXNxwVs5.w4vuincenWr6eEsayV9mkuA3iAUetBJ.Uxm5076';
const BCRYPT_ROUNDS = 12;

export function toUserResponse(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

export async function registerUser(
  { name, email, password },
  pool = defaultPool
) {
  const normalizedEmail = email.trim().toLowerCase();
  const trimmedName = name.trim();

  // Check if email already exists
  const existing = await pool.query(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [normalizedEmail]
  );
  if (existing.rowCount > 0) {
    throw new AppError(
      409,
      'EMAIL_TAKEN',
      'An account with this email already exists'
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at`,
      [trimmedName, normalizedEmail, passwordHash]
    );

    return toUserResponse(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(
        409,
        'EMAIL_TAKEN',
        'An account with this email already exists'
      );
    }
    throw err;
  }
}

export async function loginUser({ email, password }, pool = defaultPool) {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    'SELECT id, name, email, password_hash, created_at FROM users WHERE lower(email) = lower($1)',
    [normalizedEmail]
  );

  if (result.rowCount === 0) {
    // Run dummy compare to mitigate timing side-channel
    await bcrypt.compare(password, DUMMY_HASH);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user.password_hash);

  if (!isMatch) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  return toUserResponse(user);
}

export async function getUserById(id, pool = defaultPool) {
  const result = await pool.query(
    'SELECT id, name, email, created_at FROM users WHERE id = $1',
    [id]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return toUserResponse(result.rows[0]);
}
