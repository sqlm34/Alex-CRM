const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../integrations/auth0/mcp-phone-provider.cjs'), 'utf8');
const base = () => ({
  client: { client_id: 'test-client' },
  notification: { recipient: '+13175550142', delivery_method: 'text', message_type: 'otp_verify', code: '012345' },
  secrets: { MCP_AUTH0_CLIENT_ID: 'test-client', MCP_SMS_TEST_NUMBERS: '+13175550142',
    TWILIO_VERIFY_SID: `VA${'a'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'test-only-secret' },
});
async function execute(event, outcome) {
  const calls = [], dropped = [];
  const context = { exports: {}, Buffer, URLSearchParams, AbortSignal,
    fetch: async (...args) => { calls.push(args); if (outcome instanceof Error) throw outcome;
      return outcome || { ok: true, json: async () => ({ status: 'pending', service_sid: event.secrets.TWILIO_VERIFY_SID, to: event.notification.recipient }) }; },
  };
  runInNewContext(source, context);
  await context.exports.onExecuteCustomPhoneProvider(event, { notification: { drop: value => dropped.push(value) } });
  return { calls, dropped };
}
test('sends the exact Auth0 code through Verify, preserving leading zero', async () => {
  const { calls, dropped } = await execute(base());
  assert.equal(calls.length, 1); assert.equal(dropped.length, 0);
  assert.equal(calls[0][1].body.get('CustomCode'), '012345');
  assert.equal(calls[0][1].redirect, 'error');
});

test('additional test client must be explicitly allowed and keeps phone allowlist', async () => {
  const e = base(); e.client.client_id = 'integration'; e.secrets.MCP_AUTH0_TEST_CLIENT_ID = 'integration';
  assert.equal((await execute(e)).calls.length, 1);
  e.notification.recipient = '+13175550143';
  assert.equal((await execute(e)).calls.length, 0);
  delete e.client;
  assert.equal((await execute(e)).calls.length, 0);
});
test('rejects other clients, channels, codes, recipients and missing configuration', async () => {
  const edits = [e => delete e.client, e => e.client.client_id = 'other',
    e => e.notification.delivery_method = 'voice', e => e.notification.message_type = 'blocked_account',
    e => e.notification.code = '123', e => e.notification.recipient = '+13175550143',
    e => delete e.secrets.MCP_SMS_TEST_NUMBERS, e => delete e.secrets.TWILIO_API_KEY_SECRET,
    e => e.secrets.TWILIO_VERIFY_SID = '../other', e => e.notification.code = 123456];
  for (const edit of edits) { const event = base(); edit(event); const result = await execute(event);
    assert.equal(result.calls.length, 0); assert.equal(result.dropped.length, 1); }
});
test('provider errors and uncertain responses fail without retry or sensitive error output', async () => {
  for (const outcome of [{ ok: false }, new Error('test-only-secret 012345'),
    { ok: true, json: async () => ({ status: 'approved' }) }]) {
    const result = await execute(base(), outcome);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.dropped, ['MCP SMS delivery unavailable']);
  }
});
