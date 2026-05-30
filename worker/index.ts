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
}

type JobPayload = {
  id: string
  created_by_user_id?: string | null
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
                      users.name,
                      users.phone,
                      approved_users.phone,
                      approved_users.invited_by_user_id,
                      approved_users.created_at
           ),
           pending_list as (
             select users.email,
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
             group by users.email, users.name, users.phone, users.created_at
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

      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
        const rows =
          user.role === 'owner'
            ? await sql.query('select * from jobs order by created_at desc')
            : await sql.query('select * from jobs where created_by_user_id = $1 order by created_at desc', [user.id])
        return json(rows, request, env)
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
        return json(savedJob, request, env, 201)
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
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)
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

      if (jobMatch && request.method === 'DELETE') {
        const sql = getSql(env)
        await ensureAuthTables(sql, env)
        const user = await requireAuth(request, sql)

        const rows =
          user.role === 'owner'
            ? await sql.query('delete from jobs where id = $1 returning id', [decodeURIComponent(jobMatch[1])])
            : await sql.query('delete from jobs where id = $1 and created_by_user_id = $2 returning id', [
                decodeURIComponent(jobMatch[1]),
                user.id,
              ])
        if (!rows.length) {
          return json({ error: 'Job not found' }, request, env, 404)
        }

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
  }

  if (env) await seedApprovedOwners(sql, env)
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

async function sendSmsCode(env: Env, phone: string, code: string) {
  if (!isSmsConfigured(env)) {
    throw new ApiHttpError('SMS verification is not configured yet', 503)
  }

  const accountSid = env.TWILIO_ACCOUNT_SID as string
  const body = new URLSearchParams({
    To: phone,
    From: env.TWILIO_FROM_PHONE as string,
    Body: `Your Alex CRM code is ${code}. It expires in 10 minutes.`,
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

async function insertJob(sql: ReturnType<typeof neon>, job: JobPayload, userId: string) {
  const firstAttempt = await insertJobWithId(sql, job, userId)
  if (firstAttempt) return firstAttempt

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const retryJob = { ...job, id: createJobId() }
    const inserted = await insertJobWithId(sql, retryJob, userId)
    if (inserted) return inserted
  }

  throw new Error('Unable to create unique job id')
}

async function insertJobWithId(sql: ReturnType<typeof neon>, job: JobPayload, userId: string) {
  const rows = await sql.query(
          `insert into jobs (
            id, customer, phone, address, appliance, issue, service_date, service_window,
            status, invoice, paid, lat, lng, created_by_user_id
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
    event: 'created' | 'updated'
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
