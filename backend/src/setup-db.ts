import 'dotenv/config'
import { pool } from './db.js'
import { createJobsTableSql } from './schema.js'

await pool.query(createJobsTableSql)
await pool.end()

console.log('Database schema is ready')
