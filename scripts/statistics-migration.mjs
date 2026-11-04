import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

// Export the same transaction used by the Worker for explicit, versioned release.
const rollback=process.argv.includes('--rollback');
const source=rollback?execFileSync('git',['show','15e124b:worker/statisticsStorage.ts'],{encoding:'utf8'}):readFileSync('worker/statisticsStorage.ts','utf8');
const exports={};
new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);
const sql=['begin',...exports.statisticsSchemaStatements,...(rollback?['delete from crm_statistics_schema where version=5']:[]),'commit'].join(';\n')+';\n';
writeFileSync(rollback?'migrations/2026-11-04_statistics_cash.rollback.sql':'migrations/2026-11-04_statistics_cash.sql',sql);
