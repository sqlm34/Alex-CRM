import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

// Intentionally fixed staging target; this check never creates or changes jobs.
const endpoint = new URL('https://alex-crm-mcp-staging.alexeasyrepair.workers.dev/mcp')
const client = new Client({ name: 'alex-mcp-staging-smoke', version: '1.0.0' })
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'getBusinessInfo', 'getServices', 'checkServiceArea', 'getBusinessPolicies',
    'getAvailableSlots', 'createBooking', 'getBookingStatus', 'cancelBooking',
  ].sort())
  for (const name of ['getBusinessInfo', 'getServices', 'getBusinessPolicies']) {
    const result = await client.callTool({ name, arguments: {} })
    assert.notEqual(result.isError, true, `${name} failed`)
    console.log(`${name}: PASS`)
  }
  for (const [zip, covered] of [['46032', true], ['90210', false]]) {
    const result = await client.callTool({ name: 'checkServiceArea', arguments: { zip, address: '' } })
    assert.notEqual(result.isError, true)
    assert.equal(result.structuredContent.covered, covered)
    console.log(`checkServiceArea ${zip}: PASS`)
  }
  const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint))
  assert.equal(metadata.status, 200)
  assert.equal((await metadata.json()).resource, endpoint.href)
  const page = await fetch(new URL('/mcp/confirm', endpoint))
  if (process.argv.includes('--writes-enabled')) {
    assert.equal(page.status, 200)
    assert.match(await page.text(), /"connection":"sms"/)
  } else {
    assert.equal(page.status, 503)
    assert.equal((await page.json()).error, 'booking_disabled')
  }
  console.log('OAuth discovery and confirmation page: PASS')
} finally { await client.close() }
