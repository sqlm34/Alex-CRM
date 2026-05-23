import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is required')
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
})
