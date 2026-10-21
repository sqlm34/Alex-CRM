import crm from '../index'

type TestEnv = Parameters<typeof crm.fetch>[1] & { RECEPTIONIST_TEST_DATABASE_URL?: string }

// A separate secret name prevents inheriting a production DATABASE_URL by mistake.
// No scheduled handler or public booking/payment/upload routes are exposed here.
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ service: 'ai-receptionist-test', mode: 'test-only',
        databaseConfigured: Boolean(env.RECEPTIONIST_TEST_DATABASE_URL),
        providerConfigured: Boolean(env.RETELL_API_KEY),
        enabled: env.AI_RECEPTIONIST_ENABLED === 'true' }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (!path.startsWith('/api/receptionist/')) return new Response('Not found', { status: 404 })
    if (env.AI_RECEPTIONIST_DEPLOYMENT !== 'preview' || !env.RECEPTIONIST_TEST_DATABASE_URL) {
      return Response.json({ error: 'Isolated test database not configured', confirmed: false }, { status: 503 })
    }
    return crm.fetch(request, { ...env, DATABASE_URL: env.RECEPTIONIST_TEST_DATABASE_URL,
      AI_RECEPTIONIST_PUSH_ENABLED: 'false', CUSTOMER_BOOKING_EMAIL_ENABLED: 'false' }, ctx)
  },
}
