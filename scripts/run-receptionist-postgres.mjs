import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// Dedicated local cluster: no production credentials, SMS or external calls.
const directory = await mkdtemp(join(tmpdir(), 'alex-receptionist-pg-'))
const port = 55439
const database = new EmbeddedPostgres({ databaseDir: directory, port, user: 'webhook_test',
  password: 'local-test-only', persistent: true, initdbFlags: ['--locale=C', '--encoding=UTF8'],
  onLog: () => {}, onError: () => {} })
try {
  await database.initialise()
  await database.start()
  await database.createDatabase('webhook_test')
  const child = spawn(process.execPath, ['--test', 'scripts/receptionist.test.mjs'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, GOOGLE_ACTIONS_TEST_PORT: String(port) },
  })
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
} finally { await database.stop() }
