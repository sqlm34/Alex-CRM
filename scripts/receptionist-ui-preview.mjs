import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

// Local-only synthetic preview; it never authenticates against a remote API.
process.env.VITE_API_URL = 'http://127.0.0.1:5193'
const settings = JSON.parse(readFileSync(new URL('../worker/receptionist/approved-test-settings.json', import.meta.url), 'utf8'))
const diagnostics = { schemaReady: true, environmentEnabled: true, retellConfigured: true, bookingEnabled: true,
  smsEnabled: false, recordingsEnabled: false, providerRecordingVerified: false,
  lastSignedCallAt: '2026-10-16T17:00:00Z', liveVerification: 'Signed call received; full booking test still required' }
const data = {
  '/api/receptionist/settings': { ...settings, enabled: true },
  '/api/receptionist/diagnostics': diagnostics,
  '/api/receptionist/stats': { total_calls: 12, booked_calls: 3, pending_callbacks: 2, priced_calls: 10,
    recorded_cost_cents: 155.5, mean_call_median_latency_ms: 801.8 },
  '/api/receptionist/calls': [{ id: 'synthetic', provider: 'retell', started_at: '2026-10-16T17:00:00Z',
    outcome: 'ended', summary: 'Synthetic preview only', phone_last_four: '0142', customer: null, reason: null,
    callback_status: null, cost_cents: 15.5, latency_ms: 800 }],
}
const server = await createServer({ server: { host: '127.0.0.1', port: 5193, strictPort: true }, plugins: [{
  name: 'receptionist-local-preview', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = Object.hasOwn(data, req.url) ? 200 : 404
        res.end(JSON.stringify(data[req.url] ?? { error: 'No synthetic fixture' })); return
      }
      if (req.url === '/receptionist-preview') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<html><body style="margin:0;display:flex;gap:20px;background:#ddd"><iframe title="Mobile 390px" src="/receptionist-component" style="width:390px;height:900px;border:0;flex-shrink:0"></iframe><iframe title="Desktop" src="/receptionist-component" style="width:1000px;height:900px;border:0;flex-shrink:0"></iframe></body></html>'); return
      }
      if (req.url === '/receptionist-component') {
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/receptionist-component', `<!doctype html><html><head><title>Receptionist Local Preview</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:white;font-family:Arial,sans-serif}</style></head><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {ReceptionistPage} from '/src/ReceptionistPage.tsx';createRoot(document.getElementById('root')).render(React.createElement(ReceptionistPage,{token:'synthetic-only'}));</script></body></html>`)); return
      }
      next()
    })
  },
}] })
await server.listen()
console.log('Synthetic preview: http://127.0.0.1:5193/receptionist-preview')
