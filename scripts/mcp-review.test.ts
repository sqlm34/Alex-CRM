import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewDatabase } from '../worker/mcp/review'
import { readFileSync } from 'node:fs'
import { mcpRoute } from '../worker/mcp/server'

const env = { DATABASE_URL: 'postgresql://user:password@live.example.test/crm',
  MCP_REVIEW_DATABASE_URL: 'postgresql://user:password@review.example.test/review' }
const reviewer = { id: 'reviewer', phone: '+13175550142', scopes: ['booking:create'], review: true as const }
test('directory proof is public exact text, host-pinned and never initializes a database', async () => {
  const config = { MCP_ENABLED: 'true', MCP_RESOURCE_URL: 'https://example.test/mcp', MCP_DIRECTORY_CHALLENGE: 'test-proof-12345678901234567890' }
  const backend = () => { throw Error('Must not touch storage') }
  const url = 'https://example.test/.well-known/openai-apps-challenge'
  const result = await mcpRoute(new Request(url), config, backend)
  assert.equal(result.status, 200)
  assert.equal(await result.text(), config.MCP_DIRECTORY_CHALLENGE)
  assert.equal((await mcpRoute(new Request(url), { ...config, MCP_DIRECTORY_CHALLENGE: '' }, backend)).status, 404)
  assert.equal((await mcpRoute(new Request(url, { method: 'POST' }), config, backend)).status, 404)
  assert.equal((await mcpRoute(new Request(url.replace('example.test', 'other.test')), config, backend)).status, 403)
})
test('ordinary clients and anonymous requests retain the exact live environment', () => {
  assert.equal(reviewDatabase(env, null), env)
  assert.equal(reviewDatabase(env, { ...reviewer, review: undefined }), env)
})
test('review account selects a different host without modifying the shared environment', () => {
  const selected = reviewDatabase(env, reviewer)
  assert.equal(selected.DATABASE_URL, env.MCP_REVIEW_DATABASE_URL)
  assert.notEqual(selected, env)
  assert.equal(new URL(env.DATABASE_URL).hostname, 'live.example.test')
})
test('review database missing, malformed or sharing live host fails closed', () => {
  for (const url of ['', 'invalid', 'https://review.example.test/db', env.DATABASE_URL,
    'postgresql://different:password@live.example.test/other']) {
    assert.throws(() => reviewDatabase({ ...env, MCP_REVIEW_DATABASE_URL: url }, reviewer), /review_environment_unavailable/)
  }
})
test('review notifications are disabled and both query paths use the isolated database', () => {
  const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('return mcpRoute('), source.indexOf("if (request.method === 'OPTIONS')"))
  assert.match(block, /getSql\(isolatedEnv\)/)
  assert.match(block, /connectionString: isolatedEnv\.DATABASE_URL/)
  assert.match(block, /notificationEnv: principal\?\.review \? \{\} : env/)
  assert.match(block, /notify: \(value, event\) => \{\s*if \(principal\?\.review\) return/)
})

test('pooler aliases cannot bypass review database separation', () => {
  for (const host of ['ep-live.example.test', 'ep-live-pooler.example.test', 'ep-live.example.test.']) {
    assert.throws(() => reviewDatabase({ DATABASE_URL: 'postgresql://u:p@ep-live-pooler.example.test/crm',
      MCP_REVIEW_DATABASE_URL: `postgresql://u:p@${host}/review` }, reviewer), /review_environment_unavailable/)
  }
})
