const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../integrations/auth0/mcp-verified-phone.cjs'), 'utf8');
test('reviewer requires exact server-side subject and database connection, never asserts verified phone', async () => {
  const e = base();
  Object.assign(e.secrets, { MCP_PRODUCTION_CHATGPT_CLIENT_ID: 'review-client',
    MCP_PRODUCTION_RESOURCE_URL: 'https://production.invalid/mcp',
    MCP_PRODUCTION_PHONE_NAMESPACE: 'https://production.invalid/identity',
    MCP_REVIEW_SUBJECT: 'auth0|reviewer', MCP_REVIEW_CONNECTION_ID: 'review-connection' });
  e.client.client_id = 'review-client'; e.resource_server.identifier = e.secrets.MCP_PRODUCTION_RESOURCE_URL;
  e.connection = { strategy: 'auth0', id: 'review-connection' };
  e.user = { user_id: 'auth0|reviewer' };
  const result = await execute(e);
  assert.deepEqual(result.claims, [['https://production.invalid/identity/review_account', true]]);
  assert.equal(result.calls.length + result.denied.length, 0);
  e.connection.id = 'other';
  assert.equal((await execute(e)).denied.length, 1);
  e.connection.id = 'review-connection'; e.user.user_id = 'auth0|other';
  assert.equal((await execute(e)).denied.length, 1);
});
const base = () => ({ client: { client_id: 'staging' }, resource_server: { identifier: 'https://test.invalid/mcp' },
  connection: { strategy: 'sms' }, user: { phone_number: '+13175550142', phone_verified: true },
  authentication: { methods: [{ name: 'sms', timestamp: new Date().toISOString() }] },
  secrets: { MCP_AUTH0_CLIENT_ID: 'staging', MCP_RESOURCE_URL: 'https://test.invalid/mcp',
    MCP_PHONE_NAMESPACE: 'https://test.invalid/identity', MCP_SMS_TEST_NUMBERS: '+13175550142',
    TWILIO_VERIFY_SID: `VA${'a'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'fake-secret' } });
async function execute(event, ok = true) {
  const calls = [], claims = [], denied = [];
  const context = { exports: {}, Buffer, URLSearchParams, AbortSignal,
    fetch: async (...args) => { calls.push(args); return { ok }; } };
  runInNewContext(source, context);
  await context.exports.onExecutePostLogin(event, { access: { deny: r => denied.push(r) },
    accessToken: { setCustomClaim: (k, v) => claims.push([k, v]) } });
  return { calls, claims, denied };
}
test('fresh verified SMS reports feedback and produces namespaced claims', async () => {
  const r = await execute(base()); assert.equal(r.calls.length, 1); assert.equal(r.denied.length, 0);
  assert.deepEqual(r.claims, [['https://test.invalid/identity/phone_number', '+13175550142'],
    ['https://test.invalid/identity/phone_number_verified', true]]);
});
test('unrelated apps and audiences are untouched', async () => {
  for (const edit of [e => e.client.client_id = 'other', e => e.resource_server.identifier = 'other']) {
    const e = base(); edit(e); const r = await execute(e);
    assert.equal(r.calls.length + r.claims.length + r.denied.length, 0);
  }
});

test('explicit test client receives claims only for the configured resource', async () => {
  const e = base(); e.client.client_id = 'integration'; e.secrets.MCP_AUTH0_TEST_CLIENT_ID = 'integration';
  assert.equal((await execute(e)).claims.length, 2);
  e.resource_server.identifier = 'other';
  assert.equal((await execute(e)).claims.length, 0);
  delete e.client;
  assert.equal((await execute(e)).claims.length, 0);
});
test('editable metadata, nonboolean verification and other connections cannot authorize', async () => {
  for (const edit of [e => e.user.phone_verified = 'true', e => delete e.user.phone_verified,
    e => e.connection.strategy = 'google-oauth2', e => e.user.phone_number = '+13175550143']) {
    const e = base(); edit(e); e.user.user_metadata = { phone_verified: true };
    const r = await execute(e); assert.equal(r.denied.length, 1); assert.equal(r.claims.length + r.calls.length, 0);
  }
});

test('ChatGPT claims require explicit client, resource and verified SMS identity', async () => {
  const e = base(); e.client.client_id = 'chatgpt';
  assert.equal((await execute(e)).claims.length, 0);
  e.secrets.MCP_AUTH0_CHATGPT_CLIENT_ID = 'chatgpt';
  assert.equal((await execute(e)).claims.length, 2);
  e.user.phone_verified = false;
  assert.equal((await execute(e)).claims.length, 0);
});
test('feedback failure does not issue claims; old sessions do not approve another pending code', async () => {
  const failed = await execute(base(), false); assert.equal(failed.denied.length, 1); assert.equal(failed.claims.length, 0);
  const e = base(); e.authentication.methods[0].timestamp = '2020-01-01T00:00:00Z';
  const reused = await execute(e); assert.equal(reused.calls.length, 0); assert.equal(reused.claims.length, 2);
});

test('production clients cannot cross audience boundaries or bypass phone verification', async () => {
  const e = base();
  Object.assign(e.secrets, { MCP_PRODUCTION_CONFIRM_CLIENT_ID: 'prod-confirm',
    MCP_PRODUCTION_CHATGPT_CLIENT_ID: 'prod-chatgpt', MCP_PRODUCTION_RESOURCE_URL: 'https://prod.invalid/mcp',
    MCP_PRODUCTION_PHONE_NAMESPACE: 'https://prod.invalid/identity' });
  for (const client of ['prod-confirm', 'prod-chatgpt']) {
    e.client.client_id = client;
    e.resource_server.identifier = 'https://test.invalid/mcp';
    assert.equal((await execute(e)).claims.length, 0);
    e.resource_server.identifier = 'https://prod.invalid/mcp';
    assert.deepEqual((await execute(e)).claims, [['https://prod.invalid/identity/phone_number', '+13175550142'],
      ['https://prod.invalid/identity/phone_number_verified', true]]);
  }
  e.client.client_id = 'staging';
  assert.equal((await execute(e)).claims.length, 0);
  e.client.client_id = 'prod-chatgpt'; e.user.phone_number = '+13175550143';
  assert.equal((await execute(e)).denied.length, 1);
});

test('public mode permits verified production customers but not staging or unverified users', async () => {
  const e = base();
  Object.assign(e.secrets, { MCP_PUBLIC_ACCESS_ENABLED: 'true', MCP_PRODUCTION_CHATGPT_CLIENT_ID: 'prod',
    MCP_PRODUCTION_RESOURCE_URL: 'https://prod.invalid/mcp', MCP_PRODUCTION_PHONE_NAMESPACE: 'https://prod.invalid/identity' });
  e.client.client_id = 'prod'; e.resource_server.identifier = 'https://prod.invalid/mcp';
  e.user.phone_number = '+13175550143';
  assert.equal((await execute(e)).claims.length, 2);
  e.user.phone_verified = false; assert.equal((await execute(e)).claims.length, 0);
  e.user.phone_verified = true; e.client.client_id = 'staging'; e.resource_server.identifier = 'https://test.invalid/mcp';
  assert.equal((await execute(e)).denied.length, 1);
});
