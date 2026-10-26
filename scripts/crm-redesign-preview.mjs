import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

// Isolated UI preview: never forwards requests to the working CRM.
const port = 5199
process.env.VITE_API_URL = `http://127.0.0.1:${port}`
process.env.VITE_GOOGLE_MAPS_API_KEY = ''
const user = { id: 'preview-owner', name: 'Preview Technician', email: 'preview@example.com', role: 'owner' }
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indiana/Indianapolis' }).format(new Date())
const jobs = [{ id: 'preview-job', customer: 'TEST Customer', phone: '3175550142', address: '1 Civic Square, Carmel, IN 46032', appliance: 'Whirlpool washer', issue: 'Test booking: washer is not draining.', service_date: date, service_window: '9:00 AM - 11:00 AM', status: 'scheduled', invoice: 89, paid: false, created_at: `${date}T12:00:00Z`, finance_items: [], payments: [], model_photo_attachments: [] }]
const settings = JSON.parse(readFileSync(new URL('../worker/receptionist/approved-test-settings.json', import.meta.url), 'utf8'))
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{
  name: 'isolated-crm-redesign-preview',
  transformIndexHtml(html) {
    return html.replace('<head>', `<head><script>localStorage.setItem('alex-crm-auth',${JSON.stringify(JSON.stringify({ token: 'preview-only', user }))});</script>`)
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      if (!url.pathname.startsWith('/api/')) return next()
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      if (req.method !== 'GET') { res.statusCode = 403; res.end(JSON.stringify({ error: 'Read-only local preview. No changes were saved.' })); return }
      const data = {
        '/api/auth/me': user, '/api/jobs': jobs, '/api/jobs/preview-job': jobs[0],
        '/api/jobs/preview-job/attachments': { attachments: [] }, '/api/inventory/parts': { parts: [] },
        '/api/receptionist/settings': settings, '/api/receptionist/calls': [], '/api/receptionist/abandoned': [],
        '/api/receptionist/diagnostics': { schemaReady: true, environmentEnabled: false },
        '/api/receptionist/stats': { total_calls: 0, booked_calls: 0, pending_callbacks: 0, priced_calls: 0, recorded_cost_cents: 0 },
      }
      res.end(JSON.stringify(data[url.pathname] ?? []))
    })
  },
}] })
await server.listen()
console.log(`Read-only synthetic CRM preview: http://127.0.0.1:${port}`)
