// Explicit client/resource pairs keep staging and production identities isolated.
exports.onExecutePostLogin = async (event, api) => {
  const s = event.secrets || {};
  const clients = [s.MCP_AUTH0_CLIENT_ID, s.MCP_AUTH0_TEST_CLIENT_ID, s.MCP_AUTH0_CHATGPT_CLIENT_ID].filter(Boolean);
  const productionClients = [s.MCP_PRODUCTION_CONFIRM_CLIENT_ID, s.MCP_PRODUCTION_CHATGPT_CLIENT_ID].filter(Boolean);
  const production = productionClients.includes(event.client?.client_id);
  const publicAccess = production && s.MCP_PUBLIC_ACCESS_ENABLED === 'true';
  const resource = production ? s.MCP_PRODUCTION_RESOURCE_URL : s.MCP_RESOURCE_URL;
  const claimNamespace = production ? s.MCP_PRODUCTION_PHONE_NAMESPACE : s.MCP_PHONE_NAMESPACE;
  if ((!production && (!s.MCP_AUTH0_CLIENT_ID || !clients.includes(event.client?.client_id)))
    || !resource || event.resource_server?.identifier !== resource) return;
  if (production && s.MCP_REVIEW_SUBJECT && event.user?.user_id === s.MCP_REVIEW_SUBJECT) {
    if (event.connection?.strategy !== 'auth0' || !s.MCP_REVIEW_CONNECTION_ID
      || event.connection?.id !== s.MCP_REVIEW_CONNECTION_ID || !claimNamespace?.startsWith('https://')) {
      api.access.deny('Review account configuration is unavailable.'); return;
    }
    api.accessToken.setCustomClaim(`${claimNamespace.replace(/\/$/, '')}/review_account`, true);
    return;
  }
  const phone = event.user?.phone_number;
  if (event.connection?.strategy !== 'sms' || event.user?.phone_verified !== true
    || typeof phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)
    || (!publicAccess && !(s.MCP_SMS_TEST_NUMBERS || '').split(',').map(v => v.trim()).includes(phone))
    || !claimNamespace?.startsWith('https://')) {
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
  const namespace = claimNamespace.replace(/\/$/, '');
  api.accessToken.setCustomClaim(`${namespace}/phone_number`, phone);
  api.accessToken.setCustomClaim(`${namespace}/phone_number_verified`, true);
};
