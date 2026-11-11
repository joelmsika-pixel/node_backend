import 'dotenv/config'
import pg, { type PoolClient, type QueryResultRow } from 'pg'
import { Pool } from 'pg'

const { types } = pg
types.setTypeParser(20, (value) => Number(value))

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_DATABASE || 'biashara_manager',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
})

export async function rows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Pool | PoolClient = pool,
): Promise<T[]> {
  const result = await client.query<T>(sql, params)
  return result.rows
}

export async function row<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Pool | PoolClient = pool,
): Promise<T | undefined> {
  return (await rows<T>(sql, params, client))[0]
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_access_tokens (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      device_name VARCHAR(100) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS api_access_tokens_user_id_idx ON api_access_tokens(user_id);
    CREATE TABLE IF NOT EXISTS api_refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      access_token_id UUID NOT NULL REFERENCES api_access_tokens(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      device_name VARCHAR(100) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS api_refresh_tokens_user_expiry_idx ON api_refresh_tokens(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS api_password_resets (
      email VARCHAR(150) PRIMARY KEY,
      token_hash CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

export async function closeDatabase(): Promise<void> {
  await pool.end()
}
