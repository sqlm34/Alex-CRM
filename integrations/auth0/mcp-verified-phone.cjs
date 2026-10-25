// Bind only to the staging tenant's Post Login flow.
exports.onExecutePostLogin = async (event, api) => {
  const s = event.secrets || {};
  if (!s.MCP_AUTH0_CLIENT_ID || event.client?.client_id !== s.MCP_AUTH0_CLIENT_ID
    || !s.MCP_RESOURCE_URL || event.resource_server?.identifier !== s.MCP_RESOURCE_URL) return;
  const phone = event.user?.phone_number;
  if (event.connection?.strategy !== 'sms' || event.user?.phone_verified !== true
    || typeof phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)
    || !(s.MCP_SMS_TEST_NUMBERS || '').split(',').map(v => v.trim()).includes(phone)
    || !s.MCP_PHONE_NAMESPACE?.startsWith('https://')) {
    api.access.deny('Verified phone login is required.');
    return;
  }
  // Report only a fresh SMS authentication, never a reused SSO or refresh session.
  const now = Date.now();
  const freshSms = event.authentication?.methods?.some(m => m.name === 'sms'
    && now - Date.parse(m.timestamp) >= 0 && now - Date.parse(m.timestamp) < 60000);
  if (freshSms) {
    if (!/^VA[0-9a-f]{32}$/i.test(s.TWILIO_VERIFY_SID || '')
      || !/^SK[0-9a-f]{32}$/i.test(s.TWILIO_API_KEY_SID || '') || !s.TWILIO_API_KEY_SECRET) {
      api.access.deny('Phone verification service is unavailable.'); return;
    }
    try {
      const response = await fetch(`https://verify.twilio.com/v2/Services/${s.TWILIO_VERIFY_SID}/Verifications/${encodeURIComponent(phone)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Basic ${Buffer.from(`${s.TWILIO_API_KEY_SID}:${s.TWILIO_API_KEY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Status: 'approved' }),
      });
      if (!response.ok) throw new Error('feedback');
    } catch { api.access.deny('Phone verification service is unavailable.'); return; }
  }
  const namespace = s.MCP_PHONE_NAMESPACE.replace(/\/$/, '');
  api.accessToken.setCustomClaim(`${namespace}/phone_number`, phone);
  api.accessToken.setCustomClaim(`${namespace}/phone_number_verified`, true);
};
