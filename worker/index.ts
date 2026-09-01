import { neon } from '@neondatabase/serverless'

type Env = {
  DATABASE_URL: string
  ALLOWED_ORIGIN?: string
  FIREBASE_PROJECT_ID?: string
  FIREBASE_CLIENT_EMAIL?: string
  FIREBASE_PRIVATE_KEY?: string
  GOOGLE_CLIENT_ID?: string
  APPROVED_EMAILS?: string
  APPROVED_USER_PHONES?: string
  OWNER_PHONE?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_FROM_PHONE?: string
  TWILIO_VERIFY_SERVICE_SID?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_TERMINAL_LOCATION_ID?: string
  STRIPE_CURRENCY?: string
  RESEND_API_KEY?: string
  INVOICE_FROM_EMAIL?: string
  BOOKING_NOTIFY_EMAIL?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
}

type JobPayload = {
  id: string
  created_by_user_id?: string | null
  technician_name?: string | null
  technician_email?: string | null
  customer: string
  phone: string
  email?: string | null
  address: string
  appliance: string
  issue: string
  service_date: string
  service_window: string
  status: 'new' | 'scheduled' | 'in_progress' | 'complete' | 'canceled'
  invoice: number
  paid: boolean
  finance_items?: FinanceItemPayload[]
  payments?: PaymentPayload[]
  model_photo_attachments?: PublicBookingPhoto[]
  lat: number
  lng: number
}

type FinanceItemPayload = {
  id: string
  label: string
  amount: number
}

type PaymentPayload = {
  id: string
  amount: number
  createdAt: string
  method?: string
  paymentIntentId?: string
  status?: string
}

type PushTokenPayload = {
  token: string
  platform?: string
}

type UserRole = 'owner' | 'technician'

type AuthUser = {
  id: string
  email: string
  name: string
  provider: string
  role: UserRole
  phone?: string | null
}

type ApprovedUser = {
  user_id?: string | null
  email: string
  role: UserRole
  name?: string | null
  phone?: string | null
  invited_by_user_id?: string | null
  created_at?: string
  online_until?: string | null
  now_online?: boolean
  approved?: boolean
}

type BookingSession = {
  id: string
  device_hash: string
  ip_hash: string
  phone?: string | null
  phone_verified_at?: string | null
  risk_score: number
  risk_decision: 'ACCEPT' | 'REVIEW' | 'BLOCK'
  risk_reasons: string[] | string
}

type AuthPayload = {
  email?: string
  password?: string
  name?: string
  idToken?: string
  ownerOnly?: boolean
  phone?: string
  challengeId?: string
  code?: string
  trustedDeviceId?: string
  platform?: string
}

type PublicBookingPayload = Partial<JobPayload> & {
  session_id?: string
  device_id?: string
  started_at?: number
  turnstile_token?: string
  website?: string
  referrer?: string
  source?: string
  model_photo_names?: string[]
  model_photo_attachments?: PublicBookingPhoto[]
}

type PublicBookingPhoto = {
  filename: string
  contentType: string
  content: string
  size: number
}

type GoogleTokenInfo = {
  aud?: string
  email?: string
  email_verified?: string | boolean
  name?: string
  sub?: string
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

      if (url.pathname === '/api/public/booking/config' && request.method === 'GET') {
        return json(
          {
            turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
            smsRequired: true,
          },
          request,
          env,
        )
      }

      if (url.pathname === '/api/public/booking/availability' && request.method === 'GET') {
        const date = String(url.searchParams.get('date') || '').trim()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiHttpError('Valid appointment date is required', 400)

        const sql = getSql(env)
        const bookedWindows = await getBookedBookingWindows(sql, date)
        return json({ date, bookedWindows }, request, env)
      }

      if (url.pathname === '/api/public/booking/start' && request.method === 'POST') {
        const payload = (await request.json()) as PublicBookingPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await ensureBookingTables(sql)

        const session = await createBookingSession(sql, env, request, payload)
        return json(session, request, env, 201)
      }

      if (url.pathname === '/api/public/booking/send-otp' && request.method === 'POST') {
        const payload = (await request.json()) as { sessionId?: string; phone?: string; sms_domain?: string }
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await ensureBookingTables(sql)

        const challenge = await sendBookingOtp(sql, env, payload)
        return json(challenge, request, env, 201)
      }

      if (url.pathname === '/api/public/booking/verify-otp' && request.method === 'POST') {
        const payload = (await request.json()) as { sessionId?: string; challengeId?: string; code?: string }
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await ensureBookingTables(sql)

        await verifyBookingOtp(sql, env, payload)
        return json({ ok: true, phoneVerified: true }, request, env)
      }

      if (url.pathname === '/api/public/bookings' && request.method === 'POST') {
        const { payload, photos } = await readPublicBookingRequest(request)
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await ensureBookingTables(sql)

        const session = await requireVerifiedBookingSession(sql, payload)
        const job = await normalizePublicBooking(sql, payload, session, photos)
        await requireAvailableBookingWindow(sql, job.service_date, job.service_window)
        const savedJob = await insertJob(sql, job, null)
        await recordBookingAccepted(sql, session.id, savedJob.id, job)

        ctx.waitUntil(
          sendPublicBookingEmail(env, savedJob, photos).catch((error) => console.error('Public booking email failed', error)),
        )

        ctx.waitUntil(
          sendJobPush(env, {
            job: savedJob,
            title: 'New job in Alex',
            body: `${savedJob.customer} - ${savedJob.appliance}`,
            event: 'created',
          }).catch((error) => console.error('Public booking push notification failed', error)),
        )

        return json(normalizeJobForResponse(savedJob), request, env, 201)
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        const payload = (await request.json()) as AuthPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)

        const session = await registerPasswordUser(sql, env, payload)
        return json(session, request, env, 201)
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const payload = (await request.json()) as AuthPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)

        const session = await loginPasswordUser(sql, env, payload)
        return json(session, request, env)
      }

      if (url.pathname === '/api/auth/request-sms-login' && request.method === 'POST') {
        const payload = (await request.json()) as AuthPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)

        const challenge = await requestSmsLogin(sql, env, payload)
        return json(challenge, request, env)
      }

      if (url.pathname === '/api/auth/verify-sms' && request.method === 'POST') {
        const payload = (await request.json()) as AuthPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)

        const session = await verifySmsCode(sql, env, payload)
        return json(session, request, env)
      }

      if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        const payload = (await request.json()) as AuthPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)

        const session = await loginGoogleUser(sql, env, payload)
        return json(session, request, env)
      }

      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        return json(user, request, env)
      }

      if (url.pathname === '/api/auth/heartbeat' && request.method === 'POST') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const tokenHash = await authTokenHashFromRequest(request)
        const rows = await sql.query(
          `update auth_sessions
           set last_seen_at = now(),
               online_until = now() + interval '12 seconds'
           where token_hash = $1 and expires_at > now()
           returning id`,
          [tokenHash],
        )
        if (!rows.length) throw new ApiHttpError('Session expired. Please sign in again.', 401)
        return json({ ok: true }, request, env)
      }

      if (url.pathname === '/api/auth/offline' && request.method === 'POST') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const tokenHash = await authTokenHashFromOfflineRequest(request)
        const rows = await sql.query(
          `update auth_sessions
           set last_seen_at = now() - interval '10 minutes',
               online_until = now() - interval '10 minutes'
           where token_hash = $1 and expires_at > now()
           returning id`,
          [tokenHash],
        )
        if (!rows.length) throw new ApiHttpError('Session expired. Please sign in again.', 401)
        return json({ ok: true }, request, env)
      }

      if (url.pathname === '/api/approved-users' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        requireOwner(user)

        const rows = await sql.query(
          `with approved_list as (
             select approved_users.email,
                    users.id as user_id,
                    approved_users.role,
                    users.name,
                    coalesce(users.phone, approved_users.phone) as phone,
                    approved_users.invited_by_user_id,
                    approved_users.created_at,
                    max(auth_sessions.online_until) as online_until,
                    coalesce(max(auth_sessions.online_until) > now(), false) as now_online,
                    true as approved
             from approved_users
             left join users on users.email = approved_users.email
             left join auth_sessions
               on auth_sessions.user_id = users.id
              and auth_sessions.expires_at > now()
             group by approved_users.email,
                     approved_users.role,
                     users.id,
                     users.name,
                      users.phone,
                      approved_users.phone,
                      approved_users.invited_by_user_id,
                      approved_users.created_at
           ),
           pending_list as (
             select users.email,
                    users.id as user_id,
                    'technician' as role,
                    users.name,
                    users.phone,
                    null::text as invited_by_user_id,
                    users.created_at,
                    max(auth_sessions.online_until) as online_until,
                    coalesce(max(auth_sessions.online_until) > now(), false) as now_online,
                    false as approved
             from users
             left join approved_users on approved_users.email = users.email
             left join auth_sessions
               on auth_sessions.user_id = users.id
              and auth_sessions.expires_at > now()
             where approved_users.email is null and users.role = 'technician'
             group by users.email, users.id, users.name, users.phone, users.created_at
           )
           select * from pending_list
           union all
           select * from approved_list
           order by approved asc, created_at desc, email asc`,
        )
        return json(rows, request, env)
      }

      if (url.pathname === '/api/approved-users' && request.method === 'POST') {
        const payload = (await request.json()) as { email?: string; phone?: string }
        const email = normalizeEmail(payload.email)
        if (!email) return json({ error: 'Valid technician email is required' }, request, env, 400)

        const phone = normalizePhone(payload.phone)

        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        requireOwner(user)

        const rows = (await sql.query(
          `insert into approved_users (email, role, phone, invited_by_user_id)
           values ($1, 'technician', $2, $3)
           on conflict (email) do update set
             role = case when approved_users.role = 'owner' then 'owner' else excluded.role end,
             phone = coalesce(excluded.phone, approved_users.phone),
             invited_by_user_id = excluded.invited_by_user_id
           returning email, role, phone, invited_by_user_id, created_at`,
          [email, phone, user.id],
        )) as ApprovedUser[]

        await sql.query(
          `update users
           set role = case when role = 'owner' then role else 'technician' end,
               phone = coalesce(phone, $2),
               updated_at = now()
           where email = $1`,
          [email, phone],
        )

        return json({ ...rows[0], approved: true }, request, env, 201)
      }

      if (url.pathname === '/api/push-status' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
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

      if (url.pathname === '/api/stripe/terminal/config' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await requireAuth(request, sql)

        return json(
          {
            ready: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_TERMINAL_LOCATION_ID),
            locationId: env.STRIPE_TERMINAL_LOCATION_ID || '',
            currency: stripeCurrency(env),
          },
          request,
          env,
        )
      }

      if (url.pathname === '/api/stripe/terminal/connection-token' && request.method === 'POST') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        await requireAuth(request, sql)

        const token = await createStripeConnectionToken(env)
        return json({ secret: token.secret }, request, env)
      }

      if (url.pathname === '/api/stripe/terminal/payment-intent' && request.method === 'POST') {
        const payload = (await request.json()) as { jobId?: string; amount?: number; currency?: string }
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        const job = await requireJobAccess(sql, user, payload.jobId)
        const amount = normalizeStripeAmount(payload.amount ?? dollarsToCents(job.invoice))
        const currency = stripeCurrency(env, payload.currency)

        const intent = await createStripePaymentIntent(env, job, user, amount, currency)
        return json(
          {
            id: intent.id,
            clientSecret: intent.client_secret,
            amount,
            currency,
            locationId: env.STRIPE_TERMINAL_LOCATION_ID || '',
          },
          request,
          env,
        )
      }

      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        const rows =
          user.role === 'owner'
            ? await sql.query(`
                select jobs.*, users.name as technician_name, users.email as technician_email
                from jobs
                left join users on users.id = jobs.created_by_user_id
                order by jobs.service_date asc, jobs.service_window asc, jobs.created_at asc
              `)
            : await sql.query(
                `select jobs.*, users.name as technician_name, users.email as technician_email
                 from jobs
                 left join users on users.id = jobs.created_by_user_id
                 where jobs.created_by_user_id = $1
                 order by jobs.service_date asc, jobs.service_window asc, jobs.created_at asc`,
                [user.id],
              )
        return json(rows.map((row) => normalizeJobForResponse(row as JobPayload)), request, env)
      }

      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const job = (await request.json()) as JobPayload
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)

        const savedJob = await insertJob(sql, job, user.id)

        ctx.waitUntil(
          sendJobPush(env, {
            job: savedJob,
            title: 'New job in Alex',
            body: `${savedJob.customer} - ${savedJob.appliance}`,
            event: 'created',
          }).catch((error) => console.error('Push notification failed', error)),
        )
        return json(normalizeJobForResponse(savedJob), request, env, 201)
      }

      if (url.pathname === '/api/push-tokens' && request.method === 'POST') {
        const payload = (await request.json()) as PushTokenPayload
        if (!payload.token) return json({ error: 'Token is required' }, request, env, 400)

        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        await ensurePushTokensTable(sql)
        await sql.query(
          `insert into push_tokens (token, platform, user_id, updated_at)
           values ($1, $2, $3, now())
           on conflict (token) do update set
             platform = excluded.platform,
             user_id = excluded.user_id,
             updated_at = now()`,
          [payload.token, payload.platform || 'android', user.id],
        )

        return json({ ok: true }, request, env)
      }

      const invoiceEmailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/invoice\/email$/)
      if (invoiceEmailMatch && request.method === 'POST') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        const job = await requireJobAccess(sql, user, decodeURIComponent(invoiceEmailMatch[1]))
        const invoiceNumber = await invoiceOrderNumber(sql, user, job)
        await sendInvoiceEmail(env, job, invoiceNumber)
        return json({ ok: true, email: job.email }, request, env)
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
      if (jobMatch && request.method === 'PATCH') {
        const patch = (await request.json()) as Partial<Pick<JobPayload, 'customer' | 'phone' | 'email' | 'address' | 'paid' | 'status' | 'invoice' | 'finance_items' | 'payments' | 'created_by_user_id'>>
        const updates: string[] = []
        const values: unknown[] = []
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)

        if (patch.created_by_user_id !== undefined) {
          requireOwner(user)
          const technicianId = String(patch.created_by_user_id || '').trim()

          if (technicianId) {
            const technicianRows = await sql.query(
              `select users.id
               from users
               join approved_users on approved_users.email = users.email
               where users.id = $1 and approved_users.role = 'technician'
               limit 1`,
              [technicianId],
            )

            if (!technicianRows.length) {
              return json({ error: 'Approved technician not found' }, request, env, 400)
            }
          }

          values.push(technicianId || null)
          updates.push(`created_by_user_id = $${values.length}`)
        }

        const fields = ['customer', 'phone', 'email', 'address', 'status', 'paid', 'invoice', 'finance_items', 'payments'] as const

        for (const field of fields) {
          if (patch[field] === undefined) continue

          if (field === 'invoice') {
            values.push(normalizeInvoiceValue(patch[field]))
          } else if (field === 'finance_items') {
            values.push(JSON.stringify(normalizeFinanceItems(patch[field])))
            updates.push(`${field} = $${values.length}::jsonb`)
            continue
          } else if (field === 'payments') {
            values.push(JSON.stringify(normalizePayments(patch[field])))
            updates.push(`${field} = $${values.length}::jsonb`)
            continue
          } else {
            values.push(patch[field])
          }
          updates.push(`${field} = $${values.length}`)
        }

        if (!updates.length) {
          return json({ error: 'No valid fields to update' }, request, env, 400)
        }

        values.push(decodeURIComponent(jobMatch[1]))
        const jobIdIndex = values.length
        let query = `update jobs set ${updates.join(', ')} where id = $${jobIdIndex} returning *`

        if (user.role !== 'owner') {
          values.push(user.id)
          query = `update jobs set ${updates.join(', ')} where id = $${jobIdIndex} and created_by_user_id = $${values.length} returning *`
        }

        const rows = await sql.query(
          query,
          values,
        )

        if (!rows.length) {
          return json({ error: 'Job not found' }, request, env, 404)
        }

        const updatedRows = await sql.query(
          `select jobs.*, users.name as technician_name, users.email as technician_email
           from jobs
           left join users on users.id = jobs.created_by_user_id
           where jobs.id = $1
           limit 1`,
          [(rows[0] as JobPayload).id],
        )
        const updatedJob = (updatedRows[0] || rows[0]) as JobPayload
        ctx.waitUntil(
          sendJobPush(env, {
            job: updatedJob,
            title: 'Alex job updated',
            body: `${updatedJob.customer} - ${updatedJob.status.replace(/_/g, ' ')}`,
            event: 'updated',
          }).catch((error) => console.error('Push notification failed', error)),
        )

        return json(normalizeJobForResponse(updatedJob), request, env)
      }

      if (jobMatch && request.method === 'DELETE') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)

        const orderNumber = normalizeOrderNumber(url.searchParams.get('orderNumber'))
        const rows =
          user.role === 'owner'
            ? await sql.query('delete from jobs where id = $1 returning *', [decodeURIComponent(jobMatch[1])])
            : await sql.query('delete from jobs where id = $1 and created_by_user_id = $2 returning *', [
                decodeURIComponent(jobMatch[1]),
                user.id,
              ])
        if (!rows.length) {
          return json({ error: 'Job not found' }, request, env, 404)
        }

        const deletedJob = rows[0] as JobPayload
        const orderLabel = orderNumber ? `ORDER# ${orderNumber}` : 'Order'
        ctx.waitUntil(
          sendJobPush(env, {
            job: deletedJob,
            title: `${orderLabel} was deleted`,
            body: `${deletedJob.customer} - ${deletedJob.appliance}`,
            event: 'deleted',
          }).catch((error) => console.error('Push notification failed', error)),
        )

        return json({ ok: true }, request, env)
      }

      return json({ error: 'Not found' }, request, env, 404)
    } catch (error) {
      console.error(error)
      if (error instanceof ApiHttpError) {
        return json({ error: error.message }, request, env, error.status)
      }
      return json({ error: 'Server error' }, request, env, 500)
    }
  },
}

class ApiHttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function readPublicBookingRequest(request: Request) {
  const contentType = request.headers.get('content-type') || ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    const payload = (await request.json()) as PublicBookingPayload
    const photos = normalizePublicBookingPhotos(payload.model_photo_attachments || [])
    const modelPhotoNames = photos.length ? photos.map((photo) => photo.filename) : normalizePhotoNames(payload.model_photo_names)
    return { payload: { ...payload, model_photo_names: modelPhotoNames }, photos }
  }

  const formData = await request.formData()
  const rawBooking = formData.get('booking')
  if (typeof rawBooking !== 'string') throw new ApiHttpError('Booking information is missing', 400)

  let payload: PublicBookingPayload
  try {
    payload = JSON.parse(rawBooking) as PublicBookingPayload
  } catch {
    throw new ApiHttpError('Booking information is invalid', 400)
  }

  const files = formData.getAll('model_photos').filter((value): value is File => typeof value !== 'string')
  const fallbackNames = normalizePhotoNames(payload.model_photo_names)
  if (!files.length && !fallbackNames.length) throw new ApiHttpError('Model number sticker photo is required', 400)
  if (files.length > 5) throw new ApiHttpError('Upload no more than 5 model sticker photos', 400)

  const photos: PublicBookingPhoto[] = []
  let totalSize = 0
  for (const file of files) {
    totalSize += file.size
    if (!file.type.startsWith('image/')) throw new ApiHttpError('Model sticker upload must be an image file', 400)
    if (file.size > 8 * 1024 * 1024) throw new ApiHttpError('Each model sticker photo must be under 8 MB', 400)
    if (totalSize > 16 * 1024 * 1024) throw new ApiHttpError('Model sticker photos must be under 16 MB total', 400)

    photos.push({
      filename: sanitizeFileName(file.name || 'model-sticker.jpg'),
      contentType: file.type || 'application/octet-stream',
      content: arrayBufferToBase64(await file.arrayBuffer()),
      size: file.size,
    })
  }

  return {
    payload: {
      ...payload,
      model_photo_names: photos.length ? photos.map((photo) => photo.filename) : fallbackNames,
    },
    photos,
  }
}

function normalizePublicBookingPhotos(photos: PublicBookingPhoto[]) {
  if (!Array.isArray(photos)) return []
  if (photos.length > 5) throw new ApiHttpError('Upload no more than 5 model sticker photos', 400)

  let totalSize = 0
  return photos.map((photo) => {
    const filename = sanitizeFileName(photo.filename || 'model-sticker.jpg')
    const contentType = String(photo.contentType || 'application/octet-stream')
    const content = String(photo.content || '').trim()
    const size = Number(photo.size || Math.ceil((content.length * 3) / 4))
    totalSize += size
    if (!contentType.startsWith('image/')) throw new ApiHttpError('Model sticker upload must be an image file', 400)
    if (!/^[A-Za-z0-9+/=]+$/.test(content)) throw new ApiHttpError('Model sticker photo is invalid', 400)
    if (size > 8 * 1024 * 1024) throw new ApiHttpError('Each model sticker photo must be under 8 MB', 400)
    if (totalSize > 16 * 1024 * 1024) throw new ApiHttpError('Model sticker photos must be under 16 MB total', 400)
    return { filename, contentType, content, size }
  })
}

function normalizeStoredModelPhotoAttachments(photos?: PublicBookingPhoto[]) {
  if (!Array.isArray(photos)) return []
  return normalizePublicBookingPhotos(photos)
}

function normalizePhotoNames(names?: string[]) {
  return Array.isArray(names) ? names.map((name) => sanitizeFileName(name)).filter(Boolean).slice(0, 8) : []
}

async function ensureAuthTables(sql: ReturnType<typeof neon>, env?: Env) {
  await sql.query(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      name text not null,
      provider text not null default 'password',
      role text not null default 'technician',
      phone text,
      password_hash text,
      password_salt text,
      google_sub text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)

  await sql.query(`alter table users add column if not exists role text not null default 'technician'`)
  await sql.query(`alter table users add column if not exists phone text`)

  await sql.query(`
    create table if not exists auth_sessions (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      token_hash text not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      last_seen_at timestamptz not null default now(),
      online_until timestamptz
    )
  `)

  await sql.query(`alter table auth_sessions add column if not exists online_until timestamptz`)

  await sql.query(`
    create table if not exists approved_users (
      email text primary key,
      role text not null default 'technician',
      phone text,
      invited_by_user_id text references users(id) on delete set null,
      created_at timestamptz not null default now()
    )
  `)

  await sql.query(`alter table approved_users add column if not exists phone text`)

  await sql.query(`
    create table if not exists auth_sms_challenges (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      code_hash text not null,
      phone text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `)

  await sql.query(`
    create table if not exists auth_trusted_devices (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      device_hash text not null,
      created_at timestamptz not null default now(),
      last_verified_at timestamptz not null default now(),
      expires_at timestamptz not null,
      unique (user_id, device_hash)
    )
  `)

  const jobTable = (await sql.query(`select to_regclass('public.jobs') as table_name`)) as Array<{ table_name: string | null }>
  if (jobTable[0]?.table_name) {
    await sql.query(`alter table jobs add column if not exists created_by_user_id text references users(id) on delete set null`)
    await sql.query(`alter table jobs add column if not exists finance_items jsonb not null default '[]'::jsonb`)
    await sql.query(`alter table jobs add column if not exists payments jsonb not null default '[]'::jsonb`)
    await sql.query(`alter table jobs add column if not exists model_photo_attachments jsonb not null default '[]'::jsonb`)
    await sql.query(`alter table jobs add column if not exists email text`)
  }

  if (env) await seedApprovedOwners(sql, env)
}

async function ensureBookingTables(sql: ReturnType<typeof neon>) {
  await sql.query(`
    create table if not exists booking_sessions (
      id text primary key,
      device_hash text not null,
      ip_hash text not null,
      user_agent text,
      country text,
      asn text,
      ray_id text,
      referrer text,
      source text,
      started_at timestamptz,
      turnstile_success boolean not null default false,
      turnstile_error text,
      phone text,
      phone_verified_at timestamptz,
      risk_score integer not null default 0,
      risk_decision text not null default 'ACCEPT',
      risk_reasons jsonb not null default '[]'::jsonb,
      job_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)

  await sql.query(`alter table booking_sessions add column if not exists job_id text`)

  await sql.query(`
    create table if not exists booking_sms_challenges (
      id text primary key,
      session_id text not null references booking_sessions(id) on delete cascade,
      code_hash text not null,
      phone text not null,
      attempts integer not null default 0,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `)

  await sql.query(`
    create table if not exists booking_watchlist (
      id text primary key,
      kind text not null,
      value_hash text not null,
      action text not null default 'review',
      reason text,
      created_at timestamptz not null default now(),
      unique (kind, value_hash)
    )
  `)

  await sql.query(`
    create table if not exists booking_risk_events (
      id text primary key,
      session_id text references booking_sessions(id) on delete set null,
      job_id text,
      event text not null,
      risk_score integer not null,
      decision text not null,
      reasons jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    )
  `)
}

async function registerPasswordUser(sql: ReturnType<typeof neon>, env: Env, payload: AuthPayload) {
  const email = normalizeEmail(payload.email)
  const password = payload.password || ''
  const name = (payload.name || '').trim()

  if (!email || !name || password.length < 8) {
    throw new ApiHttpError('Name, valid email, and password with 8+ characters are required', 400)
  }

  const existing = await sql.query('select id from users where email = $1', [email])
  if (existing.length) {
    throw new ApiHttpError('Account already exists', 409)
  }

  const approved = await findApprovedEmail(sql, env, email)
  const passwordSalt = randomToken()
  const passwordHash = await hashPassword(password, passwordSalt)
  const phone = normalizeSmsPhone(approved?.phone) || normalizeSmsPhone(payload.phone)
  const role: UserRole = approved?.role || 'technician'
  const user = {
    id: crypto.randomUUID(),
    email,
    name,
    provider: 'password',
    role,
    phone,
  }

  if (user.role === 'technician' && !user.phone) {
    throw new ApiHttpError('Technician phone is required for SMS verification', 400)
  }

  await sql.query(
    `insert into users (id, email, name, provider, role, phone, password_hash, password_salt)
     values ($1, $2, $3, 'password', $4, $5, $6, $7)`,
    [user.id, user.email, user.name, user.role, user.phone, passwordHash, passwordSalt],
  )

  if (!approved && user.role === 'technician') {
    return {
      pendingApproval: true,
      email: user.email,
      message: 'Account created. The owner must approve this technician before app access is enabled.',
    }
  }

  if (shouldRequireSmsForLogin(user, payload) && user.phone && isSmsConfigured(env)) {
    return createSmsChallenge(sql, env, user, user.phone)
  }

  return createSession(sql, user)
}

async function loginPasswordUser(sql: ReturnType<typeof neon>, env: Env, payload: AuthPayload) {
  const email = normalizeEmail(payload.email)
  const password = payload.password || ''

  if (!email || !password) {
    throw new ApiHttpError('Email and password are required', 400)
  }

  const approved = await requireApprovedEmail(sql, env, email)

  const rows = (await sql.query(
    'select id, email, name, provider, role, phone, password_hash, password_salt from users where email = $1',
    [email],
  )) as Array<AuthUser & { password_hash: string | null; password_salt: string | null }>

  const row = rows[0]
  if (!row?.password_hash || !row.password_salt) {
    throw new ApiHttpError('Invalid email or password', 401)
  }

  const passwordHash = await hashPassword(password, row.password_salt)
  if (passwordHash !== row.password_hash) {
    throw new ApiHttpError('Invalid email or password', 401)
  }

  if (row.role !== approved.role) {
    await sql.query('update users set role = $1, updated_at = now() where id = $2', [approved.role, row.id])
  }

  const user = {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    role: approved.role,
    phone: row.phone || approved.phone || null,
  }

  if (user.phone && user.phone !== row.phone) {
    await sql.query('update users set phone = $1, updated_at = now() where id = $2', [user.phone, row.id])
  }

  if (await isTrustedDevice(sql, user.id, payload.trustedDeviceId)) {
    return createSession(sql, user)
  }

  if (shouldRequireSmsForLogin(user, payload)) {
    if (!user.phone) {
      throw new ApiHttpError('Technician phone is required for SMS verification', 400)
    }

    if (isSmsConfigured(env)) {
      return createSmsChallenge(sql, env, user, user.phone)
    }
  }

  return createSession(sql, user)
}

async function requestSmsLogin(sql: ReturnType<typeof neon>, env: Env, payload: AuthPayload) {
  const email = normalizeEmail(payload.email)
  if (!email) {
    throw new ApiHttpError('Valid technician email is required', 400)
  }

  const approved = await requireApprovedEmail(sql, env, email)
  if (approved.role !== 'technician') {
    throw new ApiHttpError('SMS login is available for technicians only', 403)
  }

  const rows = (await sql.query('select id, email, name, provider, role, phone from users where email = $1', [
    email,
  ])) as AuthUser[]
  const row = rows[0]
  if (!row) {
    throw new ApiHttpError('Technician account is not registered yet', 404)
  }

  const phone = normalizeSmsPhone(row.phone) || normalizeSmsPhone(approved.phone)
  if (!phone) {
    throw new ApiHttpError('A valid technician phone number is required for SMS login', 400)
  }

  if (!isSmsConfigured(env)) {
    throw new ApiHttpError('SMS login is not configured', 503)
  }

  const user = {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    role: 'technician' as const,
    phone,
  }

  if (row.role !== 'technician' || row.phone !== phone) {
    await sql.query('update users set role = $1, phone = $2, updated_at = now() where id = $3', [
      'technician',
      phone,
      row.id,
    ])
  }

  return createSmsChallenge(sql, env, user, phone)
}

async function loginGoogleUser(sql: ReturnType<typeof neon>, env: Env, payload: AuthPayload) {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ApiHttpError('Google sign in is not configured', 503)
  }

  if (!payload.idToken) {
    throw new ApiHttpError('Google token is required', 400)
  }

  const tokenInfo = await verifyGoogleToken(payload.idToken, env.GOOGLE_CLIENT_ID)
  const email = normalizeEmail(tokenInfo.email)
  const name = (tokenInfo.name || email).trim()

  if (!email || !tokenInfo.sub) {
    throw new ApiHttpError('Google account is missing required profile data', 400)
  }

  const approved = await requireApprovedEmail(sql, env, email)
  if (payload.ownerOnly && approved.role !== 'owner') {
    throw new ApiHttpError('Owner Google sign in is only available for the owner account', 403)
  }

  const rows = (await sql.query('select id, email, name, provider, role, phone from users where email = $1', [email])) as AuthUser[]
  let user = rows[0]

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email,
      name,
      provider: 'google',
      role: approved.role,
      phone: approved.phone || null,
    }

    await sql.query(
      `insert into users (id, email, name, provider, role, phone, google_sub)
       values ($1, $2, $3, 'google', $4, $5, $6)`,
      [user.id, user.email, user.name, user.role, user.phone, tokenInfo.sub],
    )
  } else {
    await sql.query(
      `update users
       set name = $1, google_sub = $2, role = $3, phone = coalesce(phone, $4), updated_at = now()
       where id = $5`,
      [name, tokenInfo.sub, approved.role, approved.phone || null, user.id],
    )
    user = { ...user, name, role: approved.role, phone: user.phone || approved.phone || null }
  }

  return createSession(sql, user)
}

async function verifyGoogleToken(idToken: string, googleClientId: string) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
  if (!response.ok) {
    throw new ApiHttpError('Google token could not be verified', 401)
  }

  const tokenInfo = (await response.json()) as GoogleTokenInfo
  const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === 'true'

  if (tokenInfo.aud !== googleClientId || !emailVerified) {
    throw new ApiHttpError('Google token is not valid for this app', 401)
  }

  return tokenInfo
}

async function createSession(sql: ReturnType<typeof neon>, user: AuthUser) {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)

  await sql.query(
    `insert into auth_sessions (id, user_id, token_hash, expires_at, online_until)
     values ($1, $2, $3, now() + interval '30 days', now() + interval '12 seconds')`,
    [crypto.randomUUID(), user.id, tokenHash],
  )

  return { token, user }
}

async function createSmsChallenge(sql: ReturnType<typeof neon>, env: Env, user: AuthUser, phone: string) {
  const code = createSmsCode()
  const challengeId = crypto.randomUUID()
  const useTwilioVerify = isTwilioVerifyConfigured(env)
  const codeHash = useTwilioVerify ? 'twilio-verify' : await hashSmsCode(challengeId, code)

  await sql.query(
    `insert into auth_sms_challenges (id, user_id, code_hash, phone, expires_at)
     values ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [challengeId, user.id, codeHash, phone],
  )

  if (useTwilioVerify) {
    await sendTwilioVerifyCode(env, phone)
  } else {
    await sendSmsCode(env, phone, code)
  }

  return {
    requiresTwoFactor: true,
    challengeId,
    maskedPhone: maskPhone(phone),
    expiresInSeconds: 600,
  }
}

async function verifySmsCode(sql: ReturnType<typeof neon>, env: Env, payload: AuthPayload) {
  const challengeId = (payload.challengeId || '').trim()
  const code = (payload.code || '').trim()

  if (!challengeId || !/^\d{6}$/.test(code)) {
    throw new ApiHttpError('Valid 6 digit code is required', 400)
  }

  const rows = (await sql.query(
    `select auth_sms_challenges.id, auth_sms_challenges.code_hash,
            users.id as user_id, users.email, users.name, users.provider, users.role, users.phone
     from auth_sms_challenges
     join users on users.id = auth_sms_challenges.user_id
     where auth_sms_challenges.id = $1
       and auth_sms_challenges.used_at is null
       and auth_sms_challenges.expires_at > now()
     limit 1`,
    [challengeId],
  )) as Array<AuthUser & { user_id: string; code_hash: string }>

  const row = rows[0]
  if (!row) {
    throw new ApiHttpError('Invalid or expired code', 401)
  }

  if (row.code_hash === 'twilio-verify') {
    await verifyTwilioCode(env, row.phone || '', code)
  } else if (row.code_hash !== (await hashSmsCode(challengeId, code))) {
    throw new ApiHttpError('Invalid or expired code', 401)
  }

  await sql.query('update auth_sms_challenges set used_at = now() where id = $1', [challengeId])
  await trustDevice(sql, row.user_id, payload.trustedDeviceId)

  return createSession(sql, {
    id: row.user_id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    role: row.role,
    phone: row.phone,
  })
}

async function isTrustedDevice(sql: ReturnType<typeof neon>, userId: string, trustedDeviceId?: string) {
  const deviceId = normalizeTrustedDeviceId(trustedDeviceId)
  if (!deviceId) return false

  const deviceHash = await sha256Hex(deviceId)
  const rows = await sql.query(
    `select id from auth_trusted_devices
     where user_id = $1 and device_hash = $2 and expires_at > now()
     limit 1`,
    [userId, deviceHash],
  )

  return rows.length > 0
}

async function trustDevice(sql: ReturnType<typeof neon>, userId: string, trustedDeviceId?: string) {
  const deviceId = normalizeTrustedDeviceId(trustedDeviceId)
  if (!deviceId) return

  const deviceHash = await sha256Hex(deviceId)
  await sql.query(
    `insert into auth_trusted_devices (id, user_id, device_hash, expires_at)
     values ($1, $2, $3, now() + interval '14 days')
     on conflict (user_id, device_hash) do update set
       last_verified_at = now(),
       expires_at = now() + interval '14 days'`,
    [crypto.randomUUID(), userId, deviceHash],
  )
}

function shouldRequireSmsForLogin(user: AuthUser, payload: AuthPayload) {
  return user.role === 'technician' && payload.platform === 'android'
}

async function requireAuth(request: Request, sql: ReturnType<typeof neon>) {
  await ensureAuthTables(sql)

  const tokenHash = await authTokenHashFromRequest(request)
  const rows = (await sql.query(
    `select users.id, users.email, users.name, users.provider, users.role, users.phone
     from auth_sessions
     join users on users.id = auth_sessions.user_id
     where auth_sessions.token_hash = $1 and auth_sessions.expires_at > now()
     limit 1`,
    [tokenHash],
  )) as AuthUser[]

  const user = rows[0]
  if (!user) {
    throw new ApiHttpError('Session expired. Please sign in again.', 401)
  }

  await sql.query('update auth_sessions set last_seen_at = now() where token_hash = $1', [tokenHash])
  return user
}

async function authTokenHashFromRequest(request: Request) {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    throw new ApiHttpError('Authorization is required', 401)
  }

  return sha256Hex(match[1])
}

async function authTokenHashFromOfflineRequest(request: Request) {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (match) return sha256Hex(match[1])

  let token = ''
  try {
    const text = await request.text()
    const data = JSON.parse(text) as { token?: string }
    token = data.token || ''
  } catch {
    token = ''
  }

  if (!token) {
    throw new ApiHttpError('Authorization is required', 401)
  }

  return sha256Hex(token)
}

function normalizeEmail(email?: string) {
  return (email || '').trim().toLowerCase()
}

function normalizePhone(phone?: string | null) {
  const value = (phone || '').trim()
  if (!value) return null

  const digits = value.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+') && digits.length >= 10) return digits
  if (/^\d{10}$/.test(digits)) return `+1${digits}`
  if (/^1\d{10}$/.test(digits)) return `+${digits}`

  return value.length >= 10 ? value : null
}

function normalizeSmsPhone(phone?: string | null) {
  const digits = (phone || '').replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null
  return `+1${national}`
}

function normalizeInvoiceValue(value: unknown) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return 0
  return Math.round(amount * 100) / 100
}

function normalizeFinanceItems(value: unknown): FinanceItemPayload[] {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      const row = item as Partial<FinanceItemPayload>
      return {
        id: cleanFinanceId(row.id, 'item'),
        label: String(row.label || '').trim().slice(0, 80),
        amount: normalizeInvoiceValue(row.amount),
      }
    })
    .filter((item) => item.label || item.amount > 0)
}

function normalizePayments(value: unknown): PaymentPayload[] {
  if (!Array.isArray(value)) return []

  return value
    .map((payment) => {
      const row = payment as Partial<PaymentPayload>
      return {
        id: cleanFinanceId(row.id, 'payment'),
        amount: normalizeInvoiceValue(row.amount),
        createdAt: validIsoDate(row.createdAt) || new Date().toISOString(),
        method: row.method ? String(row.method).trim().slice(0, 40) : undefined,
        paymentIntentId: row.paymentIntentId ? String(row.paymentIntentId).trim().slice(0, 120) : undefined,
        status: row.status ? String(row.status).trim().slice(0, 80) : undefined,
      }
    })
    .filter((payment) => payment.amount > 0)
}

async function createBookingSession(
  sql: ReturnType<typeof neon>,
  env: Env,
  request: Request,
  payload: PublicBookingPayload,
) {
  const deviceId = String(payload.device_id || '').trim()
  const startedAt = Number(payload.started_at)
  const elapsedMs = Date.now() - startedAt
  const botField = String(payload.website || '').trim()

  if (botField) throw new ApiHttpError('Unable to confirm this appointment. Please call us to schedule service.', 400)
  if (!/^[a-z0-9_-]{12,160}$/i.test(deviceId)) {
    throw new ApiHttpError('Unable to verify this booking session. Please refresh and try again.', 400)
  }
  if (!Number.isFinite(startedAt) || elapsedMs < 4000) {
    throw new ApiHttpError('Please review the appointment details and try again.', 400)
  }

  const deviceHash = await sha256Hex(deviceId)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown'
  const ipHash = await sha256Hex(ip)
  const turnstile = await verifyTurnstile(env, payload.turnstile_token, ip)
  const risk = await calculateBookingRisk(sql, {
    deviceHash,
    ipHash,
    phone: null,
    address: null,
    turnstile,
    elapsedMs,
  })

  if (risk.decision === 'BLOCK') {
    await recordBookingRiskEvent(sql, null, null, 'blocked_start', risk)
    throw new ApiHttpError('We could not automatically confirm this appointment. Please call us to schedule service.', 429)
  }

  const sessionId = crypto.randomUUID()
  await sql.query(
    `insert into booking_sessions (
       id, device_hash, ip_hash, user_agent, country, asn, ray_id, referrer, source,
       started_at, turnstile_success, turnstile_error, risk_score, risk_decision, risk_reasons
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0), $11, $12, $13, $14, $15::jsonb)`,
    [
      sessionId,
      deviceHash,
      ipHash,
      (request.headers.get('User-Agent') || '').slice(0, 300),
      String(request.cf?.country || ''),
      String(request.cf?.asn || ''),
      request.headers.get('CF-Ray') || '',
      String(payload.referrer || request.headers.get('Referer') || '').slice(0, 500),
      String(payload.source || '').slice(0, 120),
      startedAt,
      turnstile.success,
      turnstile.error || null,
      risk.score,
      risk.decision,
      JSON.stringify(risk.reasons),
    ],
  )

  await recordBookingRiskEvent(sql, sessionId, null, 'started', risk)

  return {
    sessionId,
    riskScore: risk.score,
    decision: risk.decision,
  }
}

async function sendBookingOtp(
  sql: ReturnType<typeof neon>,
  env: Env,
  payload: { sessionId?: string; phone?: string; sms_domain?: string },
) {
  const sessionId = String(payload.sessionId || '').trim()
  const phone = normalizeSmsPhone(payload.phone) || normalizePhone(payload.phone)
  if (!sessionId || !phone) throw new ApiHttpError('Valid booking session and phone number are required', 400)
  if (!isSmsConfigured(env)) throw new ApiHttpError('SMS verification is not configured yet', 503)

  const sessions = (await sql.query(
    `select id, device_hash, ip_hash, phone, phone_verified_at, risk_score, risk_decision, risk_reasons
     from booking_sessions
     where id = $1 and created_at > now() - interval '30 minutes'
     limit 1`,
    [sessionId],
  )) as BookingSession[]
  const session = sessions[0]
  if (!session) throw new ApiHttpError('Booking session expired. Please refresh and try again.', 401)

  const phoneHash = await sha256Hex(phone)
  const otpLimit = await countRows(
    sql,
    `select count(*)::int as count
     from booking_sms_challenges
     where phone = $1 and created_at > now() - interval '10 minutes'`,
    [phone],
  )
  const deviceOtpLimit = await countRows(
    sql,
    `select count(*)::int as count
     from booking_sms_challenges
     join booking_sessions on booking_sessions.id = booking_sms_challenges.session_id
     where booking_sessions.device_hash = $1
       and booking_sms_challenges.created_at > now() - interval '1 hour'`,
    [session.device_hash],
  )

  if (otpLimit >= 2 || deviceOtpLimit >= 5) {
    await recordBookingRiskEvent(sql, sessionId, null, 'otp_rate_limited', {
      score: 75,
      decision: 'BLOCK',
      reasons: ['Too many SMS verification requests.'],
    })
    throw new ApiHttpError('Too many SMS requests. Please try again later or call us to schedule service.', 429)
  }

  const challengeId = crypto.randomUUID()
  const code = createSmsCode()
  const useTwilioVerify = isTwilioVerifyConfigured(env)
  const codeHash = useTwilioVerify ? 'twilio-verify' : await hashSmsCode(challengeId, code)

  await sql.query(
    `insert into booking_sms_challenges (id, session_id, code_hash, phone, expires_at)
     values ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [challengeId, sessionId, codeHash, phone],
  )
  await sql.query('update booking_sessions set phone = $1, updated_at = now() where id = $2', [phone, sessionId])

  if (useTwilioVerify) {
    await sendTwilioVerifyCode(env, phone)
  } else {
    await sendSmsCode(env, phone, code, normalizeSmsDomain(payload.sms_domain))
  }

  await recordBookingRiskEvent(sql, sessionId, null, 'otp_sent', {
    score: session.risk_score,
    decision: session.risk_decision,
    reasons: [`Phone hash ${phoneHash.slice(0, 8)} queued for verification.`],
  })

  return {
    challengeId,
    maskedPhone: maskPhone(phone),
    expiresInSeconds: 600,
  }
}

async function verifyBookingOtp(
  sql: ReturnType<typeof neon>,
  env: Env,
  payload: { sessionId?: string; challengeId?: string; code?: string },
) {
  const sessionId = String(payload.sessionId || '').trim()
  const challengeId = String(payload.challengeId || '').trim()
  const code = String(payload.code || '').trim()

  if (!sessionId || !challengeId || !/^\d{6}$/.test(code)) {
    throw new ApiHttpError('Valid 6 digit code is required', 400)
  }

  const rows = (await sql.query(
    `select booking_sms_challenges.id, booking_sms_challenges.code_hash, booking_sms_challenges.phone,
            booking_sms_challenges.attempts, booking_sessions.id as session_id
     from booking_sms_challenges
     join booking_sessions on booking_sessions.id = booking_sms_challenges.session_id
     where booking_sms_challenges.id = $1
       and booking_sms_challenges.session_id = $2
       and booking_sms_challenges.used_at is null
       and booking_sms_challenges.expires_at > now()
     limit 1`,
    [challengeId, sessionId],
  )) as Array<{ id: string; code_hash: string; phone: string; attempts: number; session_id: string }>

  const row = rows[0]
  if (!row) throw new ApiHttpError('Invalid or expired code', 401)
  if (row.attempts >= 5) throw new ApiHttpError('Too many code attempts. Please request a new code.', 429)

  await sql.query('update booking_sms_challenges set attempts = attempts + 1 where id = $1', [challengeId])

  if (row.code_hash === 'twilio-verify') {
    await verifyTwilioCode(env, row.phone, code)
  } else if (row.code_hash !== (await hashSmsCode(challengeId, code))) {
    throw new ApiHttpError('Invalid or expired code', 401)
  }

  await sql.query('update booking_sms_challenges set used_at = now() where id = $1', [challengeId])
  await sql.query(
    `update booking_sessions
     set phone = $1, phone_verified_at = now(), updated_at = now()
     where id = $2`,
    [row.phone, sessionId],
  )
  await recordBookingRiskEvent(sql, sessionId, null, 'phone_verified', {
    score: 0,
    decision: 'ACCEPT',
    reasons: ['Phone ownership verified by SMS OTP.'],
  })
}

async function requireVerifiedBookingSession(sql: ReturnType<typeof neon>, payload: PublicBookingPayload) {
  const sessionId = String(payload.session_id || '').trim()
  if (!sessionId) throw new ApiHttpError('Verified booking session is required', 401)

  const rows = (await sql.query(
    `select id, device_hash, ip_hash, phone, phone_verified_at, risk_score, risk_decision, risk_reasons
     from booking_sessions
     where id = $1 and created_at > now() - interval '45 minutes'
     limit 1`,
    [sessionId],
  )) as BookingSession[]
  const session = rows[0]
  if (!session) throw new ApiHttpError('Booking session expired. Please refresh and try again.', 401)
  if (!session.phone_verified_at) throw new ApiHttpError('Phone verification is required before booking', 401)

  const phone = normalizeSmsPhone(payload.phone) || normalizePhone(payload.phone)
  if (!phone || phone !== session.phone) {
    throw new ApiHttpError('Verified phone number does not match this booking', 400)
  }

  return session
}

async function normalizePublicBooking(
  sql: ReturnType<typeof neon>,
  payload: PublicBookingPayload,
  session: BookingSession,
  photos: PublicBookingPhoto[],
): Promise<JobPayload> {
  const customer = String(payload.customer || '').trim()
  const phone = normalizeSmsPhone(payload.phone) || normalizePhone(payload.phone)
  const email = normalizeEmail(payload.email || undefined)
  const address = String(payload.address || '').trim()
  const appliance = String(payload.appliance || '').trim()
  const issue = String(payload.issue || '').trim()
  const modelPhotoNames = Array.isArray(payload.model_photo_names)
    ? payload.model_photo_names.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 8)
    : []
  const serviceDate = String(payload.service_date || '').trim()
  const serviceWindow = String(payload.service_window || '').trim()
  const lat = Number(payload.lat)
  const lng = Number(payload.lng)

  if (!customer) throw new ApiHttpError('Customer name is required', 400)
  if (!phone) throw new ApiHttpError('Valid phone number is required', 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiHttpError('Valid email is required', 400)
  if (address.length < 6) throw new ApiHttpError('Service address is required', 400)
  if (!bookingServices().includes(appliance)) throw new ApiHttpError('Valid service is required', 400)
  if (!issue) throw new ApiHttpError('Problem description is required', 400)
  if (!modelPhotoNames.length) throw new ApiHttpError('Model number sticker photo is required', 400)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new ApiHttpError('Valid appointment date is required', 400)
  if (!bookingWindows().includes(serviceWindow)) throw new ApiHttpError('Valid appointment time is required', 400)

  const risk = await calculateBookingRisk(sql, {
    deviceHash: session.device_hash,
    ipHash: session.ip_hash,
    phone,
    address,
    turnstile: { success: true },
    elapsedMs: 10000,
  })
  const combinedRisk = {
    score: Math.max(risk.score, session.risk_score),
    decision: highestRiskDecision(risk.decision, session.risk_decision),
    reasons: [...normalizeRiskReasons(session.risk_reasons), ...risk.reasons],
  }

  await sql.query(
    `update booking_sessions
     set risk_score = $1, risk_decision = $2, risk_reasons = $3::jsonb, updated_at = now()
     where id = $4`,
    [combinedRisk.score, combinedRisk.decision, JSON.stringify(combinedRisk.reasons), session.id],
  )
  await recordBookingRiskEvent(sql, session.id, null, 'scored_submit', combinedRisk)

  if (combinedRisk.decision === 'BLOCK') {
    throw new ApiHttpError('We could not automatically confirm this appointment. Please call us to schedule service.', 429)
  }

  const bookingIssue = `${issue}\n\nModel sticker photo(s): ${modelPhotoNames.join(', ')}`.slice(0, 1200)

  return {
    id: createJobId(),
    created_by_user_id: null,
    customer,
    phone,
    email,
    address,
    appliance,
    issue: combinedRisk.decision === 'REVIEW'
      ? `Suspicious lead - manual confirmation required. ${combinedRisk.reasons.join(' ')} ${bookingIssue}`.slice(0, 1200)
      : bookingIssue,
    service_date: serviceDate,
    service_window: serviceWindow,
    status: combinedRisk.decision === 'REVIEW' ? 'new' : 'scheduled',
    invoice: 0,
    paid: false,
    finance_items: [],
    payments: [],
    model_photo_attachments: photos,
    lat: Number.isFinite(lat) ? lat : 39.7684,
    lng: Number.isFinite(lng) ? lng : -86.1581,
  }
}

function bookingServices() {
  return ['Dryer repair', 'Washer repair', 'Dishwasher repair', 'Oven repair', 'Refrigerator repair']
}

function bookingWindows() {
  return ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM']
}

async function getBookedBookingWindows(sql: ReturnType<typeof neon>, date: string) {
  const rows = (await sql.query(
    `select distinct service_window
     from jobs
     where service_date = $1
       and status in ('new', 'scheduled', 'in_progress')
       and service_window = any($2::text[])
     order by service_window asc`,
    [date, bookingWindows()],
  )) as Array<{ service_window: string }>

  return rows.map((row) => row.service_window).filter(Boolean)
}

async function requireAvailableBookingWindow(sql: ReturnType<typeof neon>, date: string, window: string) {
  const bookedWindows = await getBookedBookingWindows(sql, date)
  if (bookedWindows.includes(window)) {
    throw new ApiHttpError('This appointment time is already booked. Please choose another time.', 409)
  }
}

async function verifyTurnstile(env: Env, token?: string, remoteIp?: string) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { success: false, error: 'Turnstile is not configured.' }
  }

  if (!token) {
    return { success: false, error: 'Turnstile token is missing.' }
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  })
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp)

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  })
  const result = (await response.json().catch(() => ({}))) as {
    success?: boolean
    'error-codes'?: string[]
  }

  return {
    success: Boolean(response.ok && result.success),
    error: result['error-codes']?.join(', ') || (response.ok ? '' : 'Turnstile verification failed.'),
  }
}

async function calculateBookingRisk(
  sql: ReturnType<typeof neon>,
  {
    deviceHash,
    ipHash,
    phone,
    address,
    turnstile,
    elapsedMs,
  }: {
    deviceHash: string
    ipHash: string
    phone: string | null
    address: string | null
    turnstile: { success: boolean; error?: string }
    elapsedMs: number
  },
) {
  let score = 0
  const reasons: string[] = []

  if (!turnstile.success) {
    score += 25
    reasons.push(turnstile.error || 'Turnstile verification was not completed.')
  }

  if (elapsedMs < 10000) {
    score += 15
    reasons.push('Booking form was submitted unusually fast.')
  }

  const recentIpBookings = await countRows(
    sql,
    `select count(*)::int as count
     from booking_sessions
     where ip_hash = $1 and created_at > now() - interval '1 hour'`,
    [ipHash],
  )
  if (recentIpBookings >= 3) {
    score += 20
    reasons.push('Multiple booking attempts came from the same network recently.')
  }

  const recentDeviceSessions = await countRows(
    sql,
    `select count(*)::int as count
     from booking_sessions
     where device_hash = $1 and created_at > now() - interval '1 hour'`,
    [deviceHash],
  )
  if (recentDeviceSessions >= 5) {
    score += 25
    reasons.push('This device created too many booking sessions recently.')
  }

  if (phone) {
    const phonesFromDevice = await countDistinctRows(
      sql,
      `select count(distinct phone)::int as count
       from booking_sessions
       where device_hash = $1
         and phone is not null
         and created_at > now() - interval '24 hours'`,
      [deviceHash],
    )
    if (phonesFromDevice >= 3) {
      score += 30
      reasons.push('Several phone numbers were used from the same device.')
    }

    const phoneHash = await sha256Hex(phone)
    const phoneWatchlist = await watchlistAction(sql, 'phone', phoneHash)
    if (phoneWatchlist === 'block') {
      score += 80
      reasons.push('Phone number is blocked by the booking watchlist.')
    } else if (phoneWatchlist === 'review') {
      score += 35
      reasons.push('Phone number is on the booking watchlist.')
    }
  }

  if (address) {
    const addressHash = await sha256Hex(normalizeAddressForRisk(address))
    const addressWatchlist = await watchlistAction(sql, 'address', addressHash)
    if (addressWatchlist === 'block') {
      score += 80
      reasons.push('Service address is blocked by the booking watchlist.')
    } else if (addressWatchlist === 'review') {
      score += 30
      reasons.push('Service address is on the booking watchlist.')
    }

    const addressesFromDevice = await countDistinctRows(
      sql,
      `select count(distinct jobs.address)::int as count
       from jobs
       join booking_sessions on booking_sessions.job_id = jobs.id
       where booking_sessions.device_hash = $1
         and jobs.created_at > now() - interval '30 days'`,
      [deviceHash],
    )
    if (addressesFromDevice >= 5) {
      score += 25
      reasons.push('This device has submitted many service addresses.')
    }
  }

  const deviceWatchlist = await watchlistAction(sql, 'device', deviceHash)
  if (deviceWatchlist === 'block') {
    score += 80
    reasons.push('Device is blocked by the booking watchlist.')
  } else if (deviceWatchlist === 'review') {
    score += 35
    reasons.push('Device is on the booking watchlist.')
  }

  const ipWatchlist = await watchlistAction(sql, 'ip', ipHash)
  if (ipWatchlist === 'block') {
    score += 80
    reasons.push('Network is blocked by the booking watchlist.')
  } else if (ipWatchlist === 'review') {
    score += 35
    reasons.push('Network is on the booking watchlist.')
  }

  return {
    score,
    decision: riskDecision(score),
    reasons,
  }
}

async function countRows(sql: ReturnType<typeof neon>, query: string, values: unknown[]) {
  const rows = (await sql.query(query, values)) as Array<{ count: number | string }>
  return Number(rows[0]?.count || 0)
}

async function countDistinctRows(sql: ReturnType<typeof neon>, query: string, values: unknown[]) {
  return countRows(sql, query, values)
}

async function watchlistAction(sql: ReturnType<typeof neon>, kind: string, valueHash: string) {
  const rows = (await sql.query(
    `select action from booking_watchlist
     where kind = $1 and value_hash = $2
     limit 1`,
    [kind, valueHash],
  )) as Array<{ action: string }>
  const action = rows[0]?.action
  return action === 'block' || action === 'review' ? action : ''
}

function normalizeAddressForRisk(address: string) {
  return address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function riskDecision(score: number): 'ACCEPT' | 'REVIEW' | 'BLOCK' {
  if (score >= 60) return 'BLOCK'
  if (score >= 30) return 'REVIEW'
  return 'ACCEPT'
}

function highestRiskDecision(
  first: 'ACCEPT' | 'REVIEW' | 'BLOCK',
  second: 'ACCEPT' | 'REVIEW' | 'BLOCK',
) {
  if (first === 'BLOCK' || second === 'BLOCK') return 'BLOCK'
  if (first === 'REVIEW' || second === 'REVIEW') return 'REVIEW'
  return 'ACCEPT'
}

function normalizeRiskReasons(value: string[] | string) {
  if (Array.isArray(value)) return value.map((reason) => String(reason)).filter(Boolean)
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    return Array.isArray(parsed) ? parsed.map((reason) => String(reason)).filter(Boolean) : []
  } catch {
    return []
  }
}

async function recordBookingAccepted(
  sql: ReturnType<typeof neon>,
  sessionId: string,
  jobId: string,
  job: JobPayload,
) {
  await sql.query('update booking_sessions set job_id = $1, updated_at = now() where id = $2', [jobId, sessionId])
  await recordBookingRiskEvent(sql, sessionId, jobId, 'appointment_created', {
    score: 0,
    decision: job.status === 'new' ? 'REVIEW' : 'ACCEPT',
    reasons: job.status === 'new' ? ['Appointment created for manual review.'] : ['Appointment created automatically.'],
  })
}

async function recordBookingRiskEvent(
  sql: ReturnType<typeof neon>,
  sessionId: string | null,
  jobId: string | null,
  event: string,
  risk: { score: number; decision: 'ACCEPT' | 'REVIEW' | 'BLOCK'; reasons: string[] },
) {
  await sql.query(
    `insert into booking_risk_events (id, session_id, job_id, event, risk_score, decision, reasons)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [crypto.randomUUID(), sessionId, jobId, event, risk.score, risk.decision, JSON.stringify(risk.reasons)],
  )
}

function cleanFinanceId(value: unknown, prefix: string) {
  const id = String(value || '').trim()
  if (/^[a-z0-9_-]{6,80}$/i.test(id)) return id
  return `${prefix}-${crypto.randomUUID()}`
}

function validIsoDate(value: unknown) {
  const text = String(value || '')
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeServiceDateValue(value: unknown) {
  const text = String(value || '')
  return text.includes('T') ? text.slice(0, 10) : text
}

function normalizeJobForResponse<T extends { service_date?: unknown }>(job: T): T {
  return {
    ...job,
    service_date: normalizeServiceDateValue(job.service_date),
  }
}

function normalizeStripeAmount(value: unknown) {
  const amount = Number(value)
  if (!Number.isInteger(amount) || amount < 50) {
    throw new ApiHttpError('Payment amount must be at least $0.50', 400)
  }
  return amount
}

function dollarsToCents(value: number) {
  return Math.round(Number(value || 0) * 100)
}

function stripeCurrency(env: Env, requested?: string) {
  const value = (requested || env.STRIPE_CURRENCY || 'usd').trim().toLowerCase()
  if (!/^[a-z]{3}$/.test(value)) throw new ApiHttpError('Valid currency is required', 400)
  return value
}

async function requireJobAccess(sql: ReturnType<typeof neon>, user: AuthUser, jobId?: string) {
  const id = (jobId || '').trim()
  if (!id) throw new ApiHttpError('Job is required', 400)

  const rows =
    user.role === 'owner'
      ? await sql.query('select * from jobs where id = $1 limit 1', [id])
      : await sql.query('select * from jobs where id = $1 and created_by_user_id = $2 limit 1', [id, user.id])
  const job = rows[0] as JobPayload | undefined
  if (!job) throw new ApiHttpError('Job not found', 404)
  return job
}

async function invoiceOrderNumber(sql: ReturnType<typeof neon>, user: AuthUser, job: JobPayload) {
  const rows =
    user.role === 'owner'
      ? await sql.query('select id from jobs order by created_at asc, id asc')
      : await sql.query('select id from jobs where created_by_user_id = $1 order by created_at asc, id asc', [user.id])
  const index = (rows as Array<{ id: string }>).findIndex((row) => row.id === job.id)
  return index >= 0 ? formatOrderIndex(index + 1) : fallbackInvoiceNumber(job.id)
}

function requireStripeEnv(env: Env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new ApiHttpError('Stripe secret key is not configured', 503)
  }
  if (!env.STRIPE_TERMINAL_LOCATION_ID) {
    throw new ApiHttpError('Stripe Terminal location is not configured', 503)
  }
}

async function createStripeConnectionToken(env: Env) {
  requireStripeEnv(env)
  return stripePost<{ secret: string }>(env, '/v1/terminal/connection_tokens', new URLSearchParams())
}

async function createStripePaymentIntent(
  env: Env,
  job: JobPayload,
  user: AuthUser,
  amount: number,
  currency: string,
) {
  requireStripeEnv(env)

  const body = new URLSearchParams({
    amount: String(amount),
    currency,
    capture_method: 'automatic',
    description: `Alex Appliance Repair ${job.id}`,
    'payment_method_types[]': 'card_present',
    'metadata[job_id]': job.id,
    'metadata[customer]': job.customer.slice(0, 120),
    'metadata[created_by_user_id]': job.created_by_user_id || '',
    'metadata[requested_by_user_id]': user.id,
  })

  return stripePost<{ id: string; client_secret: string }>(env, '/v1/payment_intents', body)
}

async function stripePost<T>(env: Env, path: string, body: URLSearchParams) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new ApiHttpError('Stripe secret key is not configured', 503)
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!response.ok) {
    throw new ApiHttpError(data.error?.message || 'Stripe request failed', response.status >= 500 ? 502 : 400)
  }
  return data
}

async function seedApprovedOwners(sql: ReturnType<typeof neon>, env: Env) {
  const approvedEmails = parseApprovedEmails(env.APPROVED_EMAILS)
  if (!approvedEmails.length) return

  for (const email of approvedEmails) {
    const phone = approvedPhoneForEmail(email, env) || normalizePhone(env.OWNER_PHONE)
    await sql.query(
      `insert into approved_users (email, role, phone)
       values ($1, 'owner', $2)
       on conflict (email) do update set
         role = 'owner',
         phone = coalesce(excluded.phone, approved_users.phone)`,
      [email, phone],
    )
    await sql.query('update users set role = $1, phone = coalesce(phone, $2), updated_at = now() where email = $3', [
      'owner',
      phone,
      email,
    ])
  }
}

async function requireApprovedEmail(sql: ReturnType<typeof neon>, env: Env, email: string) {
  const approved = await findApprovedEmail(sql, env, email)
  if (approved) return approved

  throw new ApiHttpError('This email is not approved by the owner yet', 403)
}

async function findApprovedEmail(sql: ReturnType<typeof neon>, env: Env, email: string) {
  const rows = (await sql.query('select email, role, phone from approved_users where email = $1', [email])) as ApprovedUser[]
  const approved = rows[0]
  if (approved) return { ...approved, role: normalizeRole(approved.role), phone: normalizePhone(approved.phone) }

  const ownerEmails = parseApprovedEmails(env.APPROVED_EMAILS)
  if (ownerEmails.includes(email)) return { email, role: 'owner' as const, phone: approvedPhoneForEmail(email, env) || normalizePhone(env.OWNER_PHONE) }

  return null
}

function requireOwner(user: AuthUser) {
  if (user.role !== 'owner') {
    throw new ApiHttpError('Owner access is required', 403)
  }
}

function normalizeRole(role: string): UserRole {
  return role === 'owner' ? 'owner' : 'technician'
}

function approvedPhoneForEmail(email: string, env: Env) {
  const pairs = (env.APPROVED_USER_PHONES || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)

  for (const pair of pairs) {
    const separatorIndex = pair.indexOf(':')
    if (separatorIndex === -1) continue

    const pairEmail = normalizeEmail(pair.slice(0, separatorIndex))
    if (pairEmail === email) return normalizePhone(pair.slice(separatorIndex + 1))
  }

  return null
}

function parseApprovedEmails(value?: string) {
  return (value || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean)
}

function createSmsCode() {
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  return (array[0] % 1000000).toString().padStart(6, '0')
}

function hashSmsCode(challengeId: string, code: string) {
  return sha256Hex(`${challengeId}:${code}`)
}

function normalizeTrustedDeviceId(value?: string) {
  const id = (value || '').trim()
  return id.length >= 24 && id.length <= 160 ? id : null
}

function isSmsConfigured(env: Env) {
  return isTwilioVerifyConfigured(env) || Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_PHONE)
}

function isTwilioVerifyConfigured(env: Env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID)
}

async function sendTwilioVerifyCode(env: Env, phone: string) {
  if (!isTwilioVerifyConfigured(env)) {
    throw new ApiHttpError('SMS verification is not configured yet', 503)
  }

  const response = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
    method: 'POST',
    headers: twilioHeaders(env),
    body: new URLSearchParams({
      To: phone,
      Channel: 'sms',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    console.error('Twilio Verify send failed', response.status, errorText)
    throw new ApiHttpError('SMS code could not be sent', 502)
  }
}

async function verifyTwilioCode(env: Env, phone: string, code: string) {
  if (!isTwilioVerifyConfigured(env)) {
    throw new ApiHttpError('SMS verification is not configured yet', 503)
  }

  const response = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
    method: 'POST',
    headers: twilioHeaders(env),
    body: new URLSearchParams({
      To: phone,
      Code: code,
    }),
  })

  if (!response.ok) {
    throw new ApiHttpError('Invalid or expired code', 401)
  }

  const result = (await response.json()) as { status?: string }
  if (result.status !== 'approved') {
    throw new ApiHttpError('Invalid or expired code', 401)
  }
}

function twilioHeaders(env: Env) {
  const accountSid = env.TWILIO_ACCOUNT_SID as string
  const authToken = env.TWILIO_AUTH_TOKEN as string
  return {
    Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
}

function normalizeSmsDomain(value?: string) {
  const domain = String(value || '').trim().toLowerCase()
  if (domain === 'alex-repair.com' || domain === 'www.alex-repair.com') return 'alex-repair.com'
  if (domain === 'aleksappliancerepair.com' || domain === 'www.aleksappliancerepair.com') return 'aleksappliancerepair.com'
  return 'aleksappliancerepair.com'
}

async function sendSmsCode(env: Env, phone: string, code: string, smsDomain = 'aleksappliancerepair.com') {
  if (!isSmsConfigured(env)) {
    throw new ApiHttpError('SMS verification is not configured yet', 503)
  }

  const accountSid = env.TWILIO_ACCOUNT_SID as string
  const body = new URLSearchParams({
    To: phone,
    From: env.TWILIO_FROM_PHONE as string,
    Body: `Your Alex CRM code is ${code}. It expires in 10 minutes.\n\n@${smsDomain} #${code}`,
  })

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: twilioHeaders(env),
    body,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    console.error('Twilio SMS failed', response.status, errorText)
    throw new ApiHttpError('SMS code could not be sent', 502)
  }
}

async function sendInvoiceEmail(env: Env, job: JobPayload, invoiceNumber?: string) {
  const to = normalizeEmail(job.email || '')
  if (!to) throw new ApiHttpError('Client email is missing', 400)
  if (!env.RESEND_API_KEY || !env.INVOICE_FROM_EMAIL) {
    throw new ApiHttpError('Invoice email is not configured. Add RESEND_API_KEY and INVOICE_FROM_EMAIL secrets in Cloudflare.', 501)
  }

  const total = invoiceTotal(job)
  const paid = paymentsTotal(job.payments)
  const balance = Math.max(0, total - paid)
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.INVOICE_FROM_EMAIL,
      to,
      subject: `Alex Appliance Repair invoice ${job.id}`,
      html: `<p>Hello ${escapeHtml(job.customer)},</p><p>Your invoice from Alex Appliance Repair is attached.</p><p>Total: ${formatMoney(total)}<br>Paid: ${formatMoney(paid)}<br>Balance: ${formatMoney(balance)}</p><p>Thank you for your business!</p>`,
      attachments: [
        {
          filename: `invoice-${job.id}.pdf`,
          content: createInvoicePdf(job, invoiceNumber),
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new ApiHttpError(`Invoice email failed: ${errorText}`, 502)
  }
}

async function sendPublicBookingEmail(env: Env, job: JobPayload, photos: PublicBookingPhoto[]) {
  if (!env.RESEND_API_KEY || !env.INVOICE_FROM_EMAIL) {
    console.error('Public booking email is not configured: missing RESEND_API_KEY or INVOICE_FROM_EMAIL')
    return
  }

  const to = normalizeEmail(env.BOOKING_NOTIFY_EMAIL || 'alexeasyrepair@gmail.com')
  if (!to) {
    console.error('Public booking email recipient is invalid')
    return
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.INVOICE_FROM_EMAIL,
      to,
      subject: `New booking: ${job.customer} - ${job.appliance}`,
      html: [
        `<p><strong>New booking from Alex Appliance Repair website</strong></p>`,
        `<p><strong>Customer:</strong> ${escapeHtml(job.customer)}<br>`,
        `<strong>Phone:</strong> ${escapeHtml(job.phone)}<br>`,
        `<strong>Email:</strong> ${escapeHtml(job.email || '')}<br>`,
        `<strong>Address:</strong> ${escapeHtml(job.address)}<br>`,
        `<strong>Service:</strong> ${escapeHtml(job.appliance)}<br>`,
        `<strong>Date:</strong> ${escapeHtml(job.service_date)}<br>`,
        `<strong>Window:</strong> ${escapeHtml(job.service_window)}</p>`,
        `<p><strong>Description:</strong><br>${escapeHtml(job.issue).replace(/\n/g, '<br>')}</p>`,
        photos.length ? `<p>Model sticker photo is attached.</p>` : `<p>No model sticker photo was attached.</p>`,
      ].join(''),
      attachments: photos.map((photo) => ({
        filename: photo.filename,
        content: photo.content,
      })),
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new ApiHttpError(`Public booking email failed: ${errorText}`, 502)
  }
}

function createInvoicePdf(job: JobPayload, invoiceNumber?: string) {
  const total = invoiceTotal(job)
  const paid = paymentsTotal(job.payments)
  const balance = Math.max(0, total - paid)
  const items = normalizeFinanceItems(job.finance_items)
  const payments = normalizePayments(job.payments)

  return buildInvoicePdf({
    invoiceNumber: invoiceNumber || fallbackInvoiceNumber(job.id),
    invoiceDate: formatInvoiceDateOnly(new Date().toISOString()),
    dueDate: formatInvoiceDateOnly(job.service_date || new Date().toISOString()),
    customerName: job.customer,
    customerAddress: job.address,
    customerPhone: job.phone,
    customerEmail: job.email || '',
    items: items.length ? items : [{ id: 'service', label: 'Service', amount: total }],
    payments,
    total,
    paid,
    balance,
  })
}

const INVOICE_LOGO_JPEG_BASE64 =
  "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"

type InvoicePdfModel = {
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  customerName: string
  customerAddress: string
  customerPhone: string
  customerEmail: string
  items: FinanceItemPayload[]
  payments: PaymentPayload[]
  total: number
  paid: number
  balance: number
}

function buildInvoicePdf(invoice: InvoicePdfModel) {
  const objects: string[] = []
  const addObject = (value: string) => {
    objects.push(value)
    return objects.length
  }
  const content: string[] = []
  const pageWidth = 612
  const left = 42
  const right = 570
  const gray = '0.42'
  const dark = '0.32'
  const light = '0.90'
  const rows = invoice.items.length ? invoice.items : [{ id: 'service', label: 'Service', amount: invoice.total }]
  const rowHeight = Math.max(34, Math.min(58, Math.floor(175 / Math.max(rows.length, 1))))
  const tableTop = 416
  const headerY = tableTop - 21
  const bodyTop = tableTop - 52
  const tableBottom = bodyTop - rowHeight * rows.length
  const totalsTop = tableBottom - 14
  const historyTop = Math.max(142, totalsTop - 104)

  const textWidth = (text: string, size: number) => escapePdfText(text).length * size * 0.5
  const drawText = (text: string, x: number, y: number, size = 10, font = 'F1', color = gray, align: 'left' | 'right' | 'center' = 'left') => {
    const safe = escapePdfText(text)
    const tx = align === 'right' ? x - textWidth(safe, size) : align === 'center' ? x - textWidth(safe, size) / 2 : x
    content.push(`BT ${color} g /${font} ${size} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td (${safe}) Tj ET`)
  }
  const drawLine = (x1: number, y1: number, x2: number, y2: number, width = 1, color = light) => {
    content.push(`q ${color} G ${width} w ${x1} ${y1} m ${x2} ${y2} l S Q`)
  }
  const drawRect = (x: number, y: number, w: number, h: number, width = 1, color = light) => {
    content.push(`q ${color} G ${width} w ${x} ${y} ${w} ${h} re S Q`)
  }
  const drawWrapped = (text: string, x: number, y: number, maxChars: number, lineHeight = 12, size = 10, font = 'F1') => {
    const lines = wrapPdfText(text, maxChars)
    lines.forEach((line, index) => drawText(line, x, y - index * lineHeight, size, font))
    return y - lines.length * lineHeight
  }

  content.push('q 76 0 0 76 42 680 cm /Im1 Do Q')
  drawText('INVOICE', right, 736, 16, 'F1', dark, 'right')

  drawText('Aksenov LLC', left, 660, 9, 'F1')
  drawText('6463 Bayside S Dr Indianapolis IN 46250', left, 648, 9, 'F1')
  drawText('(463) 248-8429', left, 636, 9, 'F1')
  drawText('alexeasyrepair@gmail.com', left, 624, 9, 'F1')

  const metaLabelX = 410
  const metaValueX = right
  ;[
    ['Invoice #', invoice.invoiceNumber],
    ['Date', invoice.invoiceDate],
    ['Balance', formatMoney(invoice.balance)],
    ['Due On', invoice.dueDate],
  ].forEach(([label, value], index) => {
    const y = 606 - index * 15
    drawText(label, metaLabelX, y, 9, 'F1')
    drawText(value, metaValueX, y, 9, 'F1', gray, 'right')
  })

  drawText('Bill To:', left, 535, 10, 'F2')
  let billY = 520
  ;[invoice.customerName, invoice.customerAddress, invoice.customerPhone, invoice.customerEmail].filter(Boolean).forEach((line) => {
    billY = drawWrapped(line, left, billY, 37, 12, 10)
  })

  drawText('Service Location:', 305, 535, 10, 'F2')
  let serviceY = 520
  ;[invoice.customerName, invoice.customerAddress, invoice.customerPhone].filter(Boolean).forEach((line) => {
    serviceY = drawWrapped(line, 305, serviceY, 37, 12, 10)
  })

  drawLine(left, tableTop, right, tableTop, 2, dark)
  drawText('Description', left + 8, headerY, 10, 'F2')
  drawText('QTY', 360, headerY, 10, 'F2', gray, 'center')
  drawText('Price', 448, headerY, 10, 'F2', gray, 'center')
  drawText('Amount', 540, headerY, 10, 'F2', gray, 'center')
  drawLine(left, tableTop - 35, right, tableTop - 35, 2, dark)
  drawLine(350, tableTop - 35, 350, tableBottom, 0.5)
  drawLine(432, tableTop - 35, 432, tableBottom, 0.5)
  drawLine(514, tableTop - 35, 514, tableBottom, 0.5)

  rows.forEach((item, index) => {
    const top = bodyTop - index * rowHeight
    const y = top - 18
    drawText(item.label || 'Service', left + 8, y, 10, 'F2')
    drawText('1.00', 360, y, 10, 'F1', gray, 'center')
    drawText(formatMoney(item.amount), 478, y, 10, 'F1', gray, 'right')
    drawText(formatMoney(item.amount), right - 8, y, 10, 'F1', gray, 'right')
    drawLine(left, top - rowHeight, right, top - rowHeight, 0.5)
  })

  const totals = [
    ['Sub total', formatMoney(invoice.total), 'F1'],
    ['Total', formatMoney(invoice.total), 'F1'],
    ['Balance\\nDue', formatMoney(invoice.balance), 'F2'],
  ]
  totals.forEach(([label, value, font], index) => {
    const y = totalsTop - index * 20
    const labels = String(label).split('\\n')
    labels.forEach((line, labelIndex) => drawText(line, 438, y - labelIndex * 10, 10, font, gray))
    drawText(String(value), 550, y, 10, font, gray, 'right')
  })
  drawLine(420, totalsTop + 12, 420, totalsTop - 60, 0.5)
  drawLine(514, totalsTop + 12, 514, totalsTop - 60, 0.5)

  drawText('Payment history', pageWidth / 2, historyTop, 14, 'F2', dark, 'center')
  const paymentRows = invoice.payments.length ? invoice.payments : [{ id: 'none', amount: 0, createdAt: '', method: 'No payments yet' }]
  paymentRows.forEach((payment, index) => {
    const y = historyTop - 32 - index * 22
    drawText(payment.createdAt ? formatInvoicePaymentDate(payment.createdAt) : '', 305, y, 9, 'F1')
    drawText(payment.method || 'Payment', 420, y, 9, 'F1')
    drawText(payment.amount ? formatMoney(payment.amount) : '', 550, y, 9, 'F1', gray, 'right')
  })
  drawLine(398, historyTop - 20, 398, historyTop - 44 - Math.max(paymentRows.length - 1, 0) * 22, 0.5)
  drawLine(512, historyTop - 20, 512, historyTop - 44 - Math.max(paymentRows.length - 1, 0) * 22, 0.5)

  drawText('Terms:', left, 152, 10, 'F2')
  drawWrapped(
    'By paying the due balance on invoices provided, the Client hereby acknowledges that all requested service items for this date and/or any other dates listed above in the description section of the table, have been performed and have been tested showing successful satisfactory install/repair, unless otherwise stated on the invoice, in which labor service charges still apply if any repairs have been made. By accepting this invoice, the Client agrees to pay in full the amount listed in the Total section of the invoice.',
    left,
    138,
    104,
    10,
    9,
  )
  drawText('Notes:', left, 62, 10, 'F2')
  drawText('Thank you for your business!', pageWidth / 2, 35, 14, 'F3', dark, 'center')

  drawRect(32, 24, 548, 744, 0.5)
  const streamContent = content.join('\n')
  const logoContent = atob(INVOICE_LOGO_JPEG_BASE64)

  const catalog = addObject('<< /Type /Catalog /Pages 2 0 R >>')
  addObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  addObject('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>')
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>')
  addObject(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoContent.length} >>\nstream\n${logoContent}\nendstream`)
  addObject(`<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`)

  const parts = ['%PDF-1.4\n']
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(parts.join('').length)
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
  })
  const xrefOffset = parts.join('').length
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (let index = 1; index < offsets.length; index += 1) {
    parts.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`)
  }
  parts.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`)
  return btoa(parts.join(''))
}

function wrapPdfText(value: string, maxChars: number) {
  const words = String(value || '').split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  words.forEach((word) => {
    if (!current) {
      current = word
      return
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  })
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function invoiceTotal(job: JobPayload) {
  const total = normalizeFinanceItems(job.finance_items).reduce((sum, item) => sum + normalizeInvoiceValue(item.amount), 0)
  return total > 0 ? total : normalizeInvoiceValue(job.invoice)
}

function paymentsTotal(payments?: PaymentPayload[]) {
  return normalizePayments(payments).reduce((sum, payment) => sum + normalizeInvoiceValue(payment.amount), 0)
}

function formatMoney(value: number) {
  return `$${normalizeInvoiceValue(value).toFixed(2)}`
}

function formatInvoiceDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatInvoiceDateOnly(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatInvoicePaymentDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatOrderIndex(value: number) {
  return value.toString().padStart(2, '0')
}

function fallbackInvoiceNumber(id: string) {
  const match = String(id || '').match(/(\d+)$/)
  return match ? match[1].padStart(2, '0') : String(id || '01')
}

function escapePdfText(value: string) {
  return String(value || '').replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '')
}

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeFileName(value: string) {
  const cleaned = String(value || 'model-sticker.jpg')
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
  return cleaned || 'model-sticker.jpg'
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return btoa(binary)
}

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return phone
  return `***-***-${digits.slice(-4)}`
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes.buffer)
}

async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
    },
    key,
    256,
  )

  return bytesToHex(new Uint8Array(bits))
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(hash))
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function insertJob(sql: ReturnType<typeof neon>, job: JobPayload, userId: string | null) {
  const firstAttempt = await insertJobWithId(sql, job, userId)
  if (firstAttempt) return firstAttempt

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const retryJob = { ...job, id: createJobId() }
    const inserted = await insertJobWithId(sql, retryJob, userId)
    if (inserted) return inserted
  }

  throw new Error('Unable to create unique job id')
}

async function insertJobWithId(sql: ReturnType<typeof neon>, job: JobPayload, userId: string | null) {
  const rows = await sql.query(
          `insert into jobs (
            id, customer, phone, email, address, appliance, issue, service_date, service_window,
            status, invoice, paid, finance_items, payments, model_photo_attachments, lat, lng, created_by_user_id
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18
          )
          on conflict (id) do nothing
          returning *`,
    [
      job.id,
      job.customer,
      job.phone,
      job.email || null,
      job.address,
      job.appliance,
      job.issue,
      job.service_date,
      job.service_window,
      job.status,
      job.invoice,
      job.paid,
      JSON.stringify(normalizeFinanceItems(job.finance_items)),
      JSON.stringify(normalizePayments(job.payments)),
      JSON.stringify(normalizeStoredModelPhotoAttachments(job.model_photo_attachments)),
      job.lat,
      job.lng,
      userId,
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
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

async function ensurePushTokensTable(sql: ReturnType<typeof neon>) {
  await sql.query(`
    create table if not exists push_tokens (
      token text primary key,
      platform text not null default 'android',
      user_id text references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)

  await sql.query(`alter table push_tokens add column if not exists user_id text references users(id) on delete cascade`)
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
    event: 'created' | 'updated' | 'deleted'
  },
) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return

  const sql = getSql(env)
  await ensureAuthTables(sql, env)
  await ensurePushTokensTable(sql)
  const tokens = (await sql.query(
    `select distinct push_tokens.token
     from push_tokens
     join users on users.id = push_tokens.user_id
     where users.role = 'owner' or push_tokens.user_id = $1`,
    [job.created_by_user_id || ''],
  )) as Array<{ token: string }>
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
    event: 'created' | 'updated' | 'deleted'
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
          notification: {
            title,
            body,
          },
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
            collapse_key: `job-${event}-${job.id}`,
            notification: {
              channel_id: 'alex-new-orders-v5',
              icon: 'ic_stat_alex_notification',
              color: '#3ACF7D',
              sound: 'nice_melodic_sound',
              tag: `job-${event}-${job.id}`,
              visibility: 'PUBLIC',
              default_vibrate_timings: true,
            },
          },
        },
      }),
    },
  )
}

function normalizeOrderNumber(value: string | null) {
  if (!value) return ''

  const digits = value.replace(/\D/g, '')
  if (!digits) return ''

  return digits.padStart(2, '0').slice(-3)
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
