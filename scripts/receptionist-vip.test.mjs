import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cache = new Map()
function load(relative) {
  const path = resolve(root, relative)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }, require = createRequire(path)
  cache.set(path, module.exports)
  new Function('require', 'exports', 'module', ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(name => name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : require(name), module.exports, module)
  return module.exports
}
const vip = load('worker/receptionist/vip.ts'), retell = load('worker/receptionist/retell-config.ts')
const secret = Buffer.alloc(32, 7).toString('base64')
const env = { VIP_CRYPTO_KEY: secret, VIP_TRANSFER_ENABLED: 'true', RETELL_TEST_PHONE: '+13175550140', RETELL_API_KEY: 'synthetic-only' }
const input = { enabled: true, revision: 0, destination: '+13175550141', trustedCallers: ['+13175550142'], passphrases: ['Краснодар', 'Krasnodar'], response: 'Одну секунду, соединяю' }
const publicPhone = '+13175550143'
const config = await vip.prepareVipConfig(input, undefined, secret, publicPhone, env)
const configuredEnv = { ...env, VIP_APPROVED_DESTINATION_SHA256: await vip.destinationFingerprint(config.destination) }

for (const [utterance, expected] of [['Краснодар', true], ['Привет, это Краснодар!', true], ['КРАСНОДАР.', true], ['Please connect me, Krasnodar.', true], ['Краснодарский', false], ['wrong phrase', false], ['Кроснадар', false]]) {
  test(`VIP deterministic transcript matching: ${utterance}`, async () => assert.equal(await vip.phraseMatches(utterance, config, secret), expected))
}
test('VIP secret never stored in clear text or encrypted settings response', async () => {
  const sealed = await vip.sealVip(config, secret)
  assert.ok(!JSON.stringify(config).includes(input.passphrases[0]))
  assert.ok(!sealed.includes(config.destination))
  assert.ok(!sealed.includes(config.trusted[0]))
  assert.notEqual(sealed, await vip.sealVip(config, secret))
})
test('VIP rejects public, AI and known forwarded destinations', () => {
  for (const number of [publicPhone, env.RETELL_TEST_PHONE, '+13175550144']) assert.throws(() => vip.safeVipDestination(number, publicPhone, { ...env, VIP_AI_ROUTED_NUMBERS: '+13175550144' }))
})
test('VIP response cannot echo secret or phone; trust list and phrase required', async () => {
  await assert.rejects(vip.prepareVipConfig({ ...input, response: 'Ваш пароль Краснодар' }, undefined, secret, publicPhone, env))
  await assert.rejects(vip.prepareVipConfig({ ...input, trustedCallers: [] }, undefined, secret, publicPhone, env))
  await assert.rejects(vip.prepareVipConfig({ ...input, passphrases: [] }, undefined, secret, publicPhone, env))
})
test('VIP provider tools use a predefined server-only destination and no secret', () => {
  const tools = retell.retellVipTools('https://alex-crm-api.alexeasyrepair.workers.dev')
  assert.equal(tools[1].transfer_destination.type, 'predefined')
  assert.equal(tools[1].transfer_destination.number, '{{vip_transfer_destination}}')
  assert.ok(!JSON.stringify(tools).includes(config.destination))
  assert.ok(!JSON.stringify(tools).includes(input.passphrases[0]))
  assert.ok(retell.retellVipAgentOverrides.language.includes('ru-RU'))
  assert.throws(() => retell.retellVipTools('https://example.com'))
})
test('VIP PostgreSQL: trust, phrase, rate limits, concurrent attempts and provider failure', async () => {
  const schema = `vip_test_${Date.now()}`
  const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 5432), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', options: `-c search_path=${schema}` })
  const sql = { query: async (text, values) => (await pool.query(text, values)).rows }
  try {
    await pool.query(`create schema ${schema}`)
    await pool.query('create table receptionist_calls(id text primary key, ended_at timestamptz); create table receptionist_audit(action text,actor_id text)')
    await pool.query(readFileSync(resolve(root, 'migrations/2026-10-16_receptionist_vip.sql'), 'utf8'))
    await vip.vipSettings(sql, configuredEnv, input, publicPhone, 'owner')
    const visible = await vip.vipSettings(sql, configuredEnv)
    assert.equal(visible.enabled, true)
    assert.equal(visible.trustedCount, 1)
    assert.ok(!JSON.stringify(visible).includes(config.destination))
    assert.ok(!JSON.stringify(visible).includes(input.passphrases[0]))
    assert.equal(await vip.vipTextSafe(sql, configuredEnv, ['Washer not draining']), true)
    assert.equal(await vip.vipTextSafe(sql, configuredEnv, ['The caller said Краснодар']), false)
    assert.equal(await vip.vipTextSafe(sql, configuredEnv, ['ordinary text '.repeat(35) + 'Krasnodar']), false)
    assert.equal(await vip.vipTextSafe(sql, { ...configuredEnv, VIP_CRYPTO_KEY: '' }, ['Any text']), false)
    const unreadable = await vip.vipSettings(sql, { ...configuredEnv, VIP_CRYPTO_KEY: '' })
    assert.equal(unreadable.configurationUnavailable, true)
    assert.equal(unreadable.enabled, true)
    assert.equal(unreadable.revision, visible.revision)
    await assert.rejects(vip.vipSettings(sql, configuredEnv, input, publicPhone, 'owner'))
    let sends = 0
    const send = async (url, options) => {
      sends++
      assert.match(url, /^https:\/\/api.retellai.com\/v2\/update-live-call\/call_/)
      const body = JSON.parse(options.body)
      assert.equal(body.fields_to_override.override_dynamic_variables.vip_transfer_destination, config.destination)
      assert.ok(!options.body.includes(input.passphrases[0]))
      return Response.json({ success: true })
    }
    const call = async (caller = '+13175550142') => {
      const id = `call_${crypto.randomUUID()}`
      await sql.query('insert into receptionist_calls(id) values($1)', [`retell:${id}`])
      return { id, caller, destination: env.RETELL_TEST_PHONE, provider: 'retell', ended: false }
    }
    const unknown = await call('+13175550149')
    assert.equal((await vip.authorizeVip(sql, configuredEnv, unknown, 'Краснодар', publicPhone, send)).nextAction, 'continueReceptionist')
    assert.equal(sends, 0)
    const trusted = await call()
    assert.equal((await vip.authorizeVip(sql, configuredEnv, trusted, 'wrong phrase', publicPhone, send)).nextAction, 'continueReceptionist')
    const outcomes = await Promise.all([1, 2].map(() => vip.authorizeVip(sql, configuredEnv, trusted, 'Привет, Краснодар', publicPhone, send)))
    assert.equal(outcomes.filter(x => x.nextAction === 'vipTransfer').length, 1)
    assert.equal(sends, 1)
    assert.ok(!JSON.stringify(outcomes).includes(config.destination))
    await vip.authorizeVip(sql, configuredEnv, trusted, 'Краснодар', publicPhone, send)
    assert.equal(sends, 1)
    await sql.query('delete from receptionist_vip_limits')
    const failed = await call()
    await vip.authorizeVip(sql, configuredEnv, failed, 'Краснодар', publicPhone, async () => { throw Error('Synthetic timeout') })
    assert.equal((await sql.query('select status from receptionist_vip_attempts where call_id=$1', [`retell:${failed.id}`]))[0].status, 'unknown')
    await vip.authorizeVip(sql, configuredEnv, failed, 'Краснодар', publicPhone, send)
    assert.equal(sends, 1)
    await sql.query('delete from receptionist_vip_limits')
    const blocked = await call()
    for (let i = 0; i < 3; i++) await vip.authorizeVip(sql, configuredEnv, blocked, 'wrong', publicPhone, send)
    await vip.authorizeVip(sql, configuredEnv, blocked, 'Краснодар', publicPhone, send)
    assert.equal(sends, 1)
    await vip.authorizeVip(sql, configuredEnv, await call(), 'wrong', publicPhone, send)
    await vip.authorizeVip(sql, configuredEnv, await call(), 'Краснодар', publicPhone, send)
    assert.equal(sends, 1)
    await sql.query('delete from receptionist_vip_limits')
    await vip.authorizeVip(sql, { ...configuredEnv, VIP_TRANSFER_ENABLED: 'false' }, await call(), 'Краснодар', publicPhone, send)
    await vip.authorizeVip(sql, { ...configuredEnv, VIP_APPROVED_DESTINATION_SHA256: 'wrong' }, await call(), 'Краснодар', publicPhone, send)
    assert.equal(sends, 1)
    const events = JSON.stringify(await sql.query('select * from receptionist_vip_attempts'))
    assert.ok(!events.includes('Краснодар')); assert.ok(!events.includes(config.destination))
  } finally { await pool.query(`drop schema if exists ${schema} cascade`); await pool.end() }
})
