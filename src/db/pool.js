import pg from 'pg';
import config from '../config.js';

// Parse PostgreSQL bigint (int8, oid 20) as JavaScript Number
pg.types.setTypeParser(pg.types.builtins.INT8, (val) => {
  return val === null ? null : Number(val);
});

export function createPool(connectionString = config.databaseUrl) {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 1000,
  });
}

export const pool = createPool();

export default pool;
