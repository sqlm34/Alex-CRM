import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const distDir = path.resolve('dist')
const indexPath = path.join(distDir, 'index.html')
const requiredSnippets = [
  'https://alex-crm-api.alexeasyrepair.workers.dev',
  '/api/jobs',
  '/api/auth/login',
]

function fail(message) {
  console.error(`Production bundle verification failed: ${message}`)
  process.exit(1)
}

if (!existsSync(indexPath)) {
  fail('dist/index.html does not exist. Run npm run build first.')
}

const indexHtml = await readFile(indexPath, 'utf8')
const scriptTags = [...indexHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0])
const entryScripts = scriptTags
  .filter((tag) => /\btype=["']module["']/i.test(tag))
  .map((tag) => tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || '')
  .filter((src) => src.includes('/assets/index-') && src.endsWith('.js'))

if (entryScripts.length === 0) {
  fail('no dist/assets/index-*.js module script was found in dist/index.html.')
}

const bundleText = (
  await Promise.all(
    entryScripts.map(async (src) => {
      const filePath = path.join(distDir, src.replace(/^\//, ''))
      if (!existsSync(filePath)) fail(`referenced bundle does not exist: ${src}`)
      return readFile(filePath, 'utf8')
    }),
  )
).join('\n')

const missingSnippets = requiredSnippets.filter((snippet) => !bundleText.includes(snippet))

if (missingSnippets.length) {
  fail(`missing required production API references: ${missingSnippets.join(', ')}`)
}

console.log('Production bundle verification passed.')
