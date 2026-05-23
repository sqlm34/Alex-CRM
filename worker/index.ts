import { neon } from '@neondatabase/serverless'

type Env = {
  DATABASE_URL: string
  ALLOWED_ORIGIN?: string
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) })
    }

    const url = new URL(request.url)

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true, service: 'alex-crm-worker' }, request, env)
      }

      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        const sql = getSql(env)
        const rows = await sql('select * from jobs order by created_at desc')
        return json(rows, request, env)
      }

      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const job = (await request.json()) as JobPayload
        const sql = getSql(env)

        await sql(
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

        return json(job, request, env, 201)
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
      if (jobMatch && request.method === 'PATCH') {
        const patch = (await request.json()) as Partial<Pick<JobPayload, 'paid' | 'status'>>
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
          return json({ error: 'No valid fields to update' }, request, env, 400)
        }

        values.push(decodeURIComponent(jobMatch[1]))
        const sql = getSql(env)
        const rows = await sql(
          `update jobs set ${updates.join(', ')} where id = $${values.length} returning *`,
          values,
        )

        if (!rows.length) {
          return json({ error: 'Job not found' }, request, env, 404)
        }

        return json(rows[0], request, env)
      }

      return json({ error: 'Not found' }, request, env, 404)
    } catch (error) {
      console.error(error)
      return json({ error: 'Server error' }, request, env, 500)
    }
  },
}

function getSql(env: Env) {
  return neon(env.DATABASE_URL)
}

function json(body: unknown, request: Request, env: Env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
    },
  })
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get('Origin') || ''
  const allowedOrigins = (env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((allowedOrigin) => allowedOrigin.trim())
    .filter(Boolean)

  const allowOrigin = allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin) ? origin || '*' : allowedOrigins[0]

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
