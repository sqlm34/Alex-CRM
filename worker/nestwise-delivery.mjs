// Transport only: callers supply a durable leased outbox item and persist the result.
// Never log configuration, request headers, bodies or receiver error text.
const runtimeFetch = (input, init) => globalThis.fetch(input, init);
export async function deliverNestwise(item, config, fetcher = runtimeFetch) {
  if (config.enabled !== true) return { outcome: 'disabled' };
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/v1/crm/events'
      || !/^[a-z0-9-]{1,64}$/.test(config.connection ?? '')
      || !/^[a-z0-9-]{1,64}$/.test(config.keyId ?? '')
      || !/^(?:[a-f0-9]{2}){32,64}$/.test(config.secret ?? '')) throw new Error('invalid_delivery_configuration');
  if (typeof item.body !== 'string' || new TextEncoder().encode(item.body).length > 16384
      || JSON.parse(item.body).source_event_id !== item.id) throw new Error('invalid_outbox_identity');
  const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.body)));
  if (hash !== item.body_hash) throw new Error('invalid_outbox_hash');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const material = Uint8Array.from(config.secret.match(/../g), h => parseInt(h, 16));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const canonical = ['v1','POST',url.pathname,config.connection,config.keyId,timestamp,nonce,hash].join('\n');
  const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  let response;
  try {
    response = await fetcher(url.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json', 'x-nw-connection': config.connection,
        'x-nw-key-id': config.keyId, 'x-nw-timestamp': timestamp, 'x-nw-nonce': nonce, 'x-nw-signature': signature },
      body: item.body });
  } catch(error) {
    const reason=['AbortError','TimeoutError','TypeError'].includes(error?.name)?error.name:'transport_error';
    console.error('Nestwise transport deferred:',reason);
    return { outcome: 'retry', httpStatus: null, receiverStatus: null };
  }
  if (response.status !== 202) {
    await response.body?.cancel();
    return { outcome: [400,409,413,415].includes(response.status) ? 'rejected' : 'retry',
      httpStatus: response.status, receiverStatus: null };
  }
  // A success status alone is not a durable acknowledgement of this event.
  let ack;
  try {
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > 4096) { await reader.cancel(); throw new Error('oversized_ack'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    ack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch { return { outcome: 'retry', httpStatus: 202, receiverStatus: null }; }
  if (ack?.accepted !== true || ack.event_id !== item.id || typeof ack.duplicate !== 'boolean'
      || !['waiting','posted','asserted','needs_review'].includes(ack.status))
    return { outcome: 'retry', httpStatus: 202, receiverStatus: null };
  return { outcome: 'acked', httpStatus: 202, receiverStatus: ack.status };
}

// Staging activation is a bounded acceptance window, never an unattended feed.
export function dispatchWindowOpen(env, now = Date.now()) {
  const start = Date.parse(env.NESTWISE_DISPATCH_NOT_BEFORE ?? '');
  const end = Date.parse(env.NESTWISE_DISPATCH_EXPIRES_AT ?? '');
  return Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end)
    && end > start && end - start <= 3600000 && now >= start && now < end;
}

export async function dispatchNestwise(sql, env, fetcher = runtimeFetch) {
  if (env.NESTWISE_DISPATCH_ENABLED !== 'true' || env.NESTWISE_ENVIRONMENT !== 'staging') return;
  if (!dispatchWindowOpen(env)) return;
  const config = { enabled: true, endpoint: env.NESTWISE_ENDPOINT, connection: env.NESTWISE_CONNECTION,
    keyId: env.NESTWISE_KEY_ID, secret: env.NESTWISE_SIGNING_SECRET };
  if (!config.endpoint || !config.connection || !config.keyId || !config.secret) return;
  const transport=env.NESTWISE_RECEIVER ? (input,init)=>env.NESTWISE_RECEIVER.fetch(input,init) : fetcher;
  await sql.query('select nestwise_integration.process_changes($1)', [20]);
  // A small parallel batch finishes within the two-minute database lease.
  const items = await sql.query('select * from nestwise_integration.claim_delivery($1)', [3]);
  await Promise.all(items.map(async item => {
    // If the database call crossed the deadline, leave the lease to expire.
    // Do not create a network request or record a false delivery failure.
    if (!dispatchWindowOpen(env)) return;
    let result;
    try { result = await deliverNestwise(item, config, transport); }
    catch(error) {
      const reason=['invalid_delivery_configuration','invalid_outbox_identity','invalid_outbox_hash'].includes(error?.message)?error.message:'delivery_preparation_error';
      console.error('Nestwise delivery deferred:',reason);
      result = { outcome:'retry', httpStatus:null, receiverStatus:null };
    }
    await sql.query('select nestwise_integration.finish_delivery($1,$2,$3,$4,$5)',
      [item.id,item.lease_id,result.httpStatus,result.outcome,result.receiverStatus]);
  }));
}

export async function safelyDispatchNestwise(sql, env) {
  try { await dispatchNestwise(sql, env); }
  catch { console.error('Nestwise delivery batch deferred; durable leases will expire.'); }
}
