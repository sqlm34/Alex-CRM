import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { pool } from './db.js'
import { createJobsTableSql } from './schema.js'

type JobPayload = {
  id: string
  customer: string
  phone: string
  address: string
  appliance: string
  issue: string
  service_date: string
  service_window: string
  status: 'new' | 'scheduled' | 'in_progress' | 'complete'
  invoice: number
  paid: boolean
  lat: number
  lng: number
}

const app = express()
const port = Number(process.env.PORT || 5000)
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173'

app.use(cors({ origin: allowedOrigin }))
app.use(express.json())

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'alex-crm-backend' })
})

app.get('/api/jobs', async (_request, response, next) => {
  try {
    const result = await pool.query('select * from jobs order by created_at desc')
    response.json(result.rows)
  } catch (error) {
    next(error)
  }
})

app.post('/api/jobs', async (request, response, next) => {
  try {
    const job = request.body as JobPayload

    await pool.query(
      `insert into jobs (
        id, customer, phone, address, appliance, issue, service_date, service_window,
        status, invoice, paid, lat, lng
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
      on conflict (id) do update set
        customer = excluded.customer,
        phone = excluded.phone,
        address = excluded.address,
        appliance = excluded.appliance,
        issue = excluded.issue,
        service_date = excluded.service_date,
        service_window = excluded.service_window,
        status = excluded.status,
        invoice = excluded.invoice,
        paid = excluded.paid,
        lat = excluded.lat,
        lng = excluded.lng`,
      [
        job.id,
        job.customer,
        job.phone,
        job.address,
        job.appliance,
        job.issue,
        job.service_date,
        job.service_window,
        job.status,
        job.invoice,
        job.paid,
        job.lat,
        job.lng,
      ],
    )

    response.status(201).json(job)
  } catch (error) {
    next(error)
  }
})

app.patch('/api/jobs/:id', async (request, response, next) => {
  try {
    const patch = request.body as Partial<Pick<JobPayload, 'paid' | 'status'>>
    const updates: string[] = []
    const values: unknown[] = []

    if (typeof patch.paid === 'boolean') {
      values.push(patch.paid)
      updates.push(`paid = $${values.length}`)
    }

    if (patch.status) {
      values.push(patch.status)
      updates.push(`status = $${values.length}`)
    }

    if (!updates.length) {
      response.status(400).json({ error: 'No valid fields to update' })
      return
    }

    values.push(request.params.id)
    const result = await pool.query(
      `update jobs set ${updates.join(', ')} where id = $${values.length} returning *`,
      values,
    )

    if (!result.rowCount) {
      response.status(404).json({ error: 'Job not found' })
      return
    }

    response.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'Server error' })
})

await pool.query(createJobsTableSql)

app.listen(port, () => {
  console.log(`Alex backend running on http://127.0.0.1:${port}`)
})
