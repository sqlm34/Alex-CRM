import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const rollback=process.argv.includes('--rollback');
const source=rollback?execFileSync('git',['show','9b17d8f:worker/statisticsStorage.ts'],{encoding:'utf8'}):readFileSync('worker/statisticsStorage.ts','utf8');
const exports={};new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);
writeFileSync(`migrations/2026-11-05_statistics_received${rollback?'.rollback':''}.sql`,['begin',...exports.statisticsSchemaStatements,...(rollback?['delete from crm_statistics_schema where version=6']:[]),'commit'].join(';\n')+';\n');
