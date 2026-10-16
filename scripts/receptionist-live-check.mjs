import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const base = 'https://alex-crm-receptionist-test.alexeasyrepair.workers.dev'
const token = randomBytes(32).toString('hex')
const hash = createHash('sha256').update(token).digest('hex')
async function wrangler(args) {
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Deployment output may contain environment values. Never echo it.
  child.stdout.resume(); child.stderr.resume()
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  if (code !== 0) throw Error(`Wrangler exited ${code}`)
}
const common = ['--config', 'wrangler.receptionist-test.json', '--var', 'AI_RECEPTIONIST_ENABLED:true']
let attempted = false
try {
  attempted = true
  await wrangler(['deploy', 'worker/receptionist/live-probe.ts', ...common,
    '--var', `RECEPTIONIST_PROBE_HASH:${hash}`, '--var', `RECEPTIONIST_PROBE_EXPIRES:${Date.now() + 600_000}`])
  console.log('TEMPORARY_TEST_PROBE_DEPLOYED')
  const response = await fetch(`${base}/_receptionist-live-probe`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90_000),
  })
  const result = await response.json()
  console.log(JSON.stringify({ status: response.status, result }))
  if (!response.ok || result.rollbackVerified !== true) process.exitCode = 1
} finally {
  if (attempted) {
    await wrangler(['deploy', ...common])
    console.log('NORMAL_TEST_ENTRY_RESTORED')
    const response = await fetch(`${base}/_receptionist-live-probe`, { method: 'POST' })
    console.log(JSON.stringify({ probeRemoved: response.status === 404 }))
    if (response.status !== 404) process.exitCode = 1
  }
}
