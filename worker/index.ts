import { neon } from '@neondatabase/serverless'

type Env = {
  DATABASE_URL: string
  ALLOWED_ORIGIN?: string
  FIREBASE_PROJECT_ID?: string
  FIREBASE_CLIENT_EMAIL?: string
  FIREBASE_PRIVATE_KEY?: string
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

type PushTokenPayload = {
  token: string
  platform?: string
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) })
    }

    const url = new URL(request.url)

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true, service: 'alex-crm-worker' }, request, env)
      }

      if (url.pathname === '/api/push-status' && request.method === 'GET') {
        const sql = getSql(env)
        await ensurePushTokensTable(sql)
        const rows = (await sql.query(
          `select platform, updated_at from push_tokens order by updated_at desc`,
        )) as Array<{ platform: string; updated_at: string }>

        return json(
          {
            firebaseConfigured: Boolean(
              env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
            ),
            tokenCount: rows.length,
            tokens: rows.map((row) => ({
              platform: row.platform,
              updated_at: row.updated_at,
            })),
          },
          request,
          env,
        )
      }

      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        const sql = getSql(env)
        const rows = await sql.query('select * from jobs order by created_at desc')
        return json(rows, request, env)
      }

      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const job = (await request.json()) as JobPayload
        const sql = getSql(env)

        const savedJob = await insertJob(sql, job)

        ctx.waitUntil(
          sendJobPush(env, {
            job: savedJob,
            title: 'New job in Alex',
            body: `${savedJob.customer} - ${savedJob.appliance}`,
            event: 'created',
          }).catch((error) => console.error('Push notification failed', error)),
        )
        return json(savedJob, request, env, 201)
      }

      if (url.pathname === '/api/push-tokens' && request.method === 'POST') {
        const payload = (await request.json()) as PushTokenPayload
        if (!payload.token) return json({ error: 'Token is required' }, request, env, 400)

        const sql = getSql(env)
        await ensurePushTokensTable(sql)
        await sql.query(
          `insert into push_tokens (token, platform, updated_at)
           values ($1, $2, now())
           on conflict (token) do update set
             platform = excluded.platform,
             updated_at = now()`,
          [payload.token, payload.platform || 'android'],
        )

        return json({ ok: true }, request, env)
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
      if (jobMatch && request.method === 'PATCH') {
        const patch = (await request.json()) as Partial<Pick<JobPayload, 'customer' | 'phone' | 'address' | 'paid' | 'status'>>
        const updates: string[] = []
        const values: unknown[] = []

        const fields = ['customer', 'phone', 'address', 'status', 'paid'] as const

        for (const field of fields) {
          if (patch[field] === undefined) continue

          values.push(patch[field])
          updates.push(`${field} = $${values.length}`)
        }

        if (!updates.length) {
          return json({ error: 'No valid fields to update' }, request, env, 400)
        }

        values.push(decodeURIComponent(jobMatch[1]))
        const sql = getSql(env)
        const rows = await sql.query(
          `update jobs set ${updates.join(', ')} where id = $${values.length} returning *`,
          values,
        )

        if (!rows.length) {
          return json({ error: 'Job not found' }, request, env, 404)
        }

        const updatedJob = rows[0] as JobPayload
        ctx.waitUntil(
          sendJobPush(env, {
            job: updatedJob,
            title: 'Alex job updated',
            body: `${updatedJob.customer} - ${updatedJob.status.replace(/_/g, ' ')}`,
            event: 'updated',
          }).catch((error) => console.error('Push notification failed', error)),
        )

        return json(rows[0], request, env)
      }

      return json({ error: 'Not found' }, request, env, 404)
    } catch (error) {
      console.error(error)
      return json({ error: 'Server error' }, request, env, 500)
    }
  },
}

async function insertJob(sql: ReturnType<typeof neon>, job: JobPayload) {
  const firstAttempt = await insertJobWithId(sql, job)
  if (firstAttempt) return firstAttempt

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const retryJob = { ...job, id: createJobId() }
    const inserted = await insertJobWithId(sql, retryJob)
    if (inserted) return inserted
  }

  throw new Error('Unable to create unique job id')
}

async function insertJobWithId(sql: ReturnType<typeof neon>, job: JobPayload) {
  const rows = await sql.query(
          `insert into jobs (
            id, customer, phone, address, appliance, issue, service_date, service_window,
            status, invoice, paid, lat, lng
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          )
          on conflict (id) do nothing
          returning *`,
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

  return (rows[0] as JobPayload | undefined) || null
}

function getSql(env: Env) {
  return neon(env.DATABASE_URL)
}

function createJobId() {
  return `J-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
}

function json(body: unknown, request: Request, env: Env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
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

async function ensurePushTokensTable(sql: ReturnType<typeof neon>) {
  await sql.query(`
    create table if not exists push_tokens (
      token text primary key,
      platform text not null default 'android',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
}

async function sendJobPush(
  env: Env,
  {
    job,
    title,
    body,
    event,
  }: {
    job: JobPayload
    title: string
    body: string
    event: 'created' | 'updated'
  },
) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return

  const sql = getSql(env)
  await ensurePushTokensTable(sql)
  const tokens = (await sql.query('select token from push_tokens')) as Array<{ token: string }>
  if (!tokens.length) return

  const accessToken = await getFirebaseAccessToken(env)

  await Promise.all(
    tokens.map(async ({ token }) => {
      const response = await sendFirebaseMessage(env, accessToken, token, { job, title, body, event })
      if (response.ok) return

      const errorText = await response.text()
      console.error('FCM error', response.status, errorText)

      if (response.status === 400 || response.status === 404) {
        await sql.query('delete from push_tokens where token = $1', [token])
      }
    }),
  )
}

function sendFirebaseMessage(
  env: Env,
  accessToken: string,
  token: string,
  {
    job,
    title,
    body,
    event,
  }: {
    job: JobPayload
    title: string
    body: string
    event: 'created' | 'updated'
  },
) {
  return fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          data: {
            title,
            body,
            event,
            jobId: job.id,
            address: job.address,
            status: job.status,
            customer: job.customer,
            appliance: job.appliance,
          },
          android: {
            priority: 'HIGH',
            ttl: '60s',
            collapse_key: `job-${job.id}`,
          },
        },
      }),
    },
  )
}

async function getFirebaseAccessToken(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await signJwt(
    {
      alg: 'RS256',
      typ: 'JWT',
    },
    {
      iss: env.FIREBASE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    env.FIREBASE_PRIVATE_KEY || '',
  )

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!response.ok) throw new Error(`Firebase auth failed: ${response.status}`)

  const data = (await response.json()) as { access_token: string }
  return data.access_token
}

async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: string) {
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  return `${unsigned}.${base64Url(signature)}`
}

function pemToArrayBuffer(pem: string) {
  const normalized = pem.replace(/\\n/g, '\n')
  const base64 = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function base64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
