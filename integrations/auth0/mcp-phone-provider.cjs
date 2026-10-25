// Public production access requires configured provider-side SMS rate limits.
exports.onExecuteCustomPhoneProvider = async (event, api) => {
  const secrets = event.secrets || {};
  const notification = event.notification || {};
  const drop = () => api.notification.drop('MCP SMS delivery unavailable');
  const recipient = typeof notification.recipient === 'string'
    ? notification.recipient.replace(/\s/g, '') : '';
  const allowed = (secrets.MCP_SMS_TEST_NUMBERS || '').split(',').map(v => v.trim());
  const production = [secrets.MCP_PRODUCTION_CONFIRM_CLIENT_ID, secrets.MCP_PRODUCTION_CHATGPT_CLIENT_ID]
    .filter(Boolean).includes(event.client?.client_id);
  const publicAccess = production && secrets.MCP_PUBLIC_ACCESS_ENABLED === 'true';
  const rateKeys = [secrets.MCP_SMS_RECIPIENT_RATE_KEY, secrets.MCP_SMS_GLOBAL_RATE_KEY];
  if (publicAccess && (rateKeys.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key))
    || rateKeys[0] === rateKeys[1])) return drop();
  const clients = [secrets.MCP_AUTH0_CLIENT_ID, secrets.MCP_AUTH0_TEST_CLIENT_ID, secrets.MCP_AUTH0_CHATGPT_CLIENT_ID,
    secrets.MCP_PRODUCTION_CONFIRM_CLIENT_ID, secrets.MCP_PRODUCTION_CHATGPT_CLIENT_ID].filter(Boolean);
  if (!secrets.MCP_AUTH0_CLIENT_ID || !clients.includes(event.client?.client_id)
    || notification.delivery_method !== 'text'
    || !['otp_verify', 'otp_enroll'].includes(notification.message_type)
    || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(recipient)
    || (!publicAccess && !allowed.includes(recipient))
    || typeof notification.code !== 'string' || !/^\d{6}$/.test(notification.code)
    || !/^VA[0-9a-f]{32}$/i.test(secrets.TWILIO_VERIFY_SID || '')
    || !/^SK[0-9a-f]{32}$/i.test(secrets.TWILIO_API_KEY_SID || '')
    || !secrets.TWILIO_API_KEY_SECRET) return drop();

  try {
    const body = new URLSearchParams({ To: recipient, Channel: 'sms', CustomCode: notification.code });
    if (publicAccess) {
      body.set('RateLimits', JSON.stringify({ [rateKeys[0]]: recipient, [rateKeys[1]]: 'mcp-production' }));
      body.set('RiskCheck', 'enable');
    }
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${secrets.TWILIO_VERIFY_SID}/Verifications`,
      {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${secrets.TWILIO_API_KEY_SID}:${secrets.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!response.ok) return drop();
    const result = await response.json();
    if (result.status !== 'pending' || result.service_sid !== secrets.TWILIO_VERIFY_SID
      || result.to !== recipient) return drop();
  } catch {
    // Delivery may have succeeded before a timeout; do not automatically send twice.
    return drop();
  }
};
