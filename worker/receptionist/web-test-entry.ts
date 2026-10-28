import app from './test-entry'
import { neon } from '@neondatabase/serverless'
import { createAuthorizedWebCall } from './web'
import { retellTestTools } from './retell-config'
import { retellWebPrompt } from './web-prompt'
import { approvedServiceZips } from '../../shared/receptionist-area'
import { ReceptionistError } from '../../shared/receptionist'

const agentId = 'agent_7356ae73a3014eb5a26c79db9c'
const origin = 'https://alex-crm-receptionist-test.alexeasyrepair.workers.dev'
type Env = Parameters<typeof app.fetch>[1] & { WEB_TEST_TOKEN?: string; WEB_TEST_UNTIL?: string }
async function retell(env: Env, path: string, method = 'GET', body?: unknown) {
  const result = await fetch(`https://api.retellai.com${path}`, { method,
    headers: { Authorization: `Bearer ${env.RETELL_WEBHOOK_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'manual' })
  if (!result.ok) throw new ReceptionistError(`Test provider request failed (${result.status})`, 503)
  const text = await result.text()
  return (text ? JSON.parse(text) : {}) as Record<string, any>
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname
    if (!path.startsWith('/__web-test/')) return app.fetch(request, env, ctx)
    const browserOrigin = request.headers.get('origin') || ''
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': browserOrigin === 'http://127.0.0.1:5198' ? browserOrigin : 'null',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'POST,OPTIONS', Vary: 'Origin' }
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (env.AI_RECEPTIONIST_DEPLOYMENT !== 'preview' || !env.RECEPTIONIST_TEST_DATABASE_URL
      || !env.WEB_TEST_TOKEN || env.WEB_TEST_TOKEN.length < 40 || Number(env.WEB_TEST_UNTIL) <= Date.now()
      || !Number.isFinite(Number(env.WEB_TEST_UNTIL)) || Number(env.WEB_TEST_UNTIL) > Date.now() + 3600000
      || request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${env.WEB_TEST_TOKEN}`) return reply({ error: 'Not found' }, 404)
    try {
      const sql = neon(env.RECEPTIONIST_TEST_DATABASE_URL)
      if (path === '/__web-test/start') {
        if (browserOrigin !== 'http://127.0.0.1:5198') return reply({ error: 'Origin not allowed' }, 403)
        return reply(await createAuthorizedWebCall({ ...env, RETELL_API_KEY: env.RETELL_WEBHOOK_API_KEY }, sql, request.headers.get('cf-connecting-ip') || 'owner-test'))
      }
      if (path === '/__web-test/prepare') {
        await sql.transaction([
          'create table if not exists receptionist_web_sessions(id text primary key,provider_call_id text unique,agent_id text not null,created_at timestamptz not null default now(),expires_at timestamptz not null,ended_at timestamptz)',
          'create table if not exists receptionist_web_limits(bucket text primary key,used integer not null default 0,expires_at timestamptz not null)',
          'create table if not exists receptionist_web_capacity(singleton boolean primary key default true check(singleton),session_id text,lease_until timestamptz not null default now())',
          'insert into receptionist_web_capacity(singleton) values(true) on conflict do nothing',
          'alter table receptionist_web_sessions enable row level security',
          'alter table receptionist_web_limits enable row level security',
          'alter table receptionist_web_capacity enable row level security',
          'alter table jobs add column if not exists booking_source_detail text',
          'alter table jobs drop constraint if exists jobs_booking_source_detail_check',
          "alter table jobs add constraint jobs_booking_source_detail_check check(booking_source_detail is null or booking_source_detail in ('actions_center','voice_assistant'))",
          'alter table receptionist_calls add column if not exists location_city text',
          'alter table receptionist_calls add column if not exists location_zip text',
          'alter table receptionist_calls add column if not exists disconnect_reason text',
          'alter table receptionist_calls add column if not exists duration_ms bigint',
          "alter table receptionist_callbacks add column if not exists kind text not null default 'requested' check(kind in ('requested','abandoned'))",
          'alter table jobs alter column lat drop not null',
          'alter table jobs alter column lng drop not null',
        ].map(statement => sql.query(statement)))
        await sql.query(`update receptionist_settings set settings=settings || $1::jsonb,revision=revision+1 where singleton=true`,
          [JSON.stringify({ enabled: true, testMode: true, serviceZips: approvedServiceZips, zipOnlyZips: approvedServiceZips })])
        return reply({ prepared: true, isolatedDatabase: true })
      }
      if (path === '/__web-test/provider') {
        const agent = await retell(env, `/get-agent/${agentId}`)
        const capacity = await retell(env, '/get-concurrency')
        return reply({ agentId: agent.agent_id, version: agent.version, storage: agent.data_storage_setting,
          responseEngine: agent.response_engine, capacity })
      }
      if (path === '/__web-test/configure-agent') {
        const agent = await retell(env, `/get-agent/${agentId}`)
        if (agent.agent_id !== agentId || agent.data_storage_setting !== 'basic_attributes_only'
          || agent.response_engine?.type !== 'retell-llm') throw new ReceptionistError('Unexpected test agent configuration', 409)
        const llmId = agent.response_engine.llm_id
        if (!/^llm_[a-zA-Z0-9]+$/.test(llmId) || llmId === 'llm_a721dcbd9986ca175cf6ab136b3e') throw new ReceptionistError('Unexpected response engine', 409)
        await retell(env, `/update-retell-llm/${llmId}`, 'PATCH', {
          general_prompt: retellWebPrompt + '\nThis is a closed TEST. Explain this before intake. Use only synthetic TEST customer details; no technician will be dispatched.',
          general_tools: retellTestTools(origin),
        })
        await retell(env, `/update-agent/${agentId}`, 'PATCH', { webhook_url: `${origin}/api/receptionist/providers/retell/webhook`, max_call_duration_ms: 600000 })
        return reply({ configured: true, agentId, published: false })
      }
      if (path === '/__web-test/publish-agent') {
        await retell(env, `/publish-agent/${agentId}`, 'POST', {})
        return reply({ published: true, agentId })
      }
      if (path === '/__web-test/results') {
        const rows = await sql.query(`select c.provider_call_id,c.outcome,c.job_id,c.duration_ms,c.cost_cents,
          j.customer,j.service_date,j.service_window,j.booking_source_detail
          from receptionist_calls c join receptionist_web_sessions w on w.provider_call_id=c.provider_call_id
          left join jobs j on j.id=c.job_id order by c.started_at desc limit 5`)
        return reply({ calls: rows })
      }
      return reply({ error: 'Not found' }, 404)
    } catch (error) { return reply({ error: error instanceof ReceptionistError ? error.message : 'Test operation failed',
      category: error instanceof TypeError ? 'type' : error instanceof SyntaxError ? 'json' : 'operation',
      diagnostic: error instanceof Error ? ['AbortSignal', 'redirect', 'header', 'undefined', 'json', 'fetch'].filter(term => error.message.includes(term)) : [] }, error instanceof ReceptionistError ? error.status : 503) }
  },
}
