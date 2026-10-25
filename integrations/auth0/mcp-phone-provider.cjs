// Deploy only in the isolated Auth0 development tenant, using Action Secrets.
exports.onExecuteCustomPhoneProvider = async (event, api) => {
  const secrets = event.secrets || {};
  const notification = event.notification || {};
  const drop = () => api.notification.drop('MCP SMS delivery unavailable');
  const recipient = typeof notification.recipient === 'string'
    ? notification.recipient.replace(/\s/g, '') : '';
  const allowed = (secrets.MCP_SMS_TEST_NUMBERS || '').split(',').map(v => v.trim());
  if (!secrets.MCP_AUTH0_CLIENT_ID || event.client?.client_id !== secrets.MCP_AUTH0_CLIENT_ID
    || notification.delivery_method !== 'text'
    || !['otp_verify', 'otp_enroll'].includes(notification.message_type)
    || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(recipient)
    || !allowed.includes(recipient)
    || typeof notification.code !== 'string' || !/^\d{6}$/.test(notification.code)
    || !/^VA[0-9a-f]{32}$/i.test(secrets.TWILIO_VERIFY_SID || '')
    || !/^SK[0-9a-f]{32}$/i.test(secrets.TWILIO_API_KEY_SID || '')
    || !secrets.TWILIO_API_KEY_SECRET) return drop();

  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${secrets.TWILIO_VERIFY_SID}/Verifications`,
      {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${secrets.TWILIO_API_KEY_SID}:${secrets.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: recipient, Channel: 'sms', CustomCode: notification.code }),
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
