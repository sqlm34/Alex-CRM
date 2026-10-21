import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')

// Reuse static DDL from the CRM. Never execute application code, seed users,
// or connect to a database from this generator.
export function buildReceptionistTestSchema() {
  const schema = ts.createSourceFile('schema.ts', read('backend/src/schema.ts'), ts.ScriptTarget.Latest, true)
  let jobs
  function findJobs(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(schema) === 'createJobsTableSql'
      && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) jobs = node.initializer.text
    ts.forEachChild(node, findJobs)
  }
  findJobs(schema)
  if (!jobs) throw Error('Canonical jobs schema missing')
  const source = ts.createSourceFile('index.ts', read('worker/index.ts'), ts.ScriptTarget.Latest, true)
  const statements = []
  for (const name of ['ensureAuthTables', 'ensureBookingTables', 'ensureAvailabilityBlocksTable']) {
    const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!fn) throw Error(`Missing schema function: ${name}`)
    let count = 0
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'sql.query') {
        const literal = node.arguments[0]
        if (!literal || !(ts.isNoSubstitutionTemplateLiteral(literal) || ts.isStringLiteral(literal))) throw Error('Dynamic schema statement requires review')
        if (/^\s*(create table|alter table)/i.test(literal.text)) {
          statements.push(`${literal.text.trim().replace(/;$/, '')};`)
          count++
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(fn)
    if (!count) throw Error(`No static DDL in ${name}`)
  }
  const migrations = [
    '2026-09-04_add_independent_job_text_fields.sql',
    '2026-09-09_add_booking_source.sql',
    '2026-09-09_add_booking_requests.sql',
    '2026-10-16_ai_receptionist.sql',
  ].map(name => read(`migrations/${name}`).replace(/^(?:begin|commit);\s*$/gmi, ''))
  return `-- ONLY for the new isolated alex-crm-receptionist-test database.
-- Fails before making changes if any jobs table already exists.
begin;
do $$ begin
  if to_regclass('public.jobs') is not null then
    raise exception 'Refusing to initialize an existing CRM database';
  end if;
end $$;
${jobs}
${statements.join('\n')}
${migrations.join('\n')}
commit;
select (select count(*) from jobs) as test_jobs,
  (select count(*) from receptionist_calls) as test_calls,
  (select settings->>'enabled' from receptionist_settings where singleton) as receptionist_enabled;
`
}
