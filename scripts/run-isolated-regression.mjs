import {createRequire} from 'node:module'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'

// The local runtime is supplied explicitly; no production credentials are read.
if(!process.env.CRM_TEST_PG_RUNTIME)throw Error('Set CRM_TEST_PG_RUNTIME to the embedded-postgres package directory')
const require=createRequire(join(resolve(process.env.CRM_TEST_PG_RUNTIME),'package.json'))
const {default:EmbeddedPostgres}=await import(pathToFileURL(require.resolve('embedded-postgres')).href)
const databaseDir=await mkdtemp(join(tmpdir(),'alex-inventory-qa-'))
const server=new EmbeddedPostgres({databaseDir,user:'webhook_test',password:'local-test-only',port:55439,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}})
let exitCode=1
try{
  await server.initialise();await server.start();await server.createDatabase('webhook_test')
  console.log('Disposable PostgreSQL started on 127.0.0.1:55439')
  const files=process.argv.slice(2)
  const child=spawn(process.execPath,['--test',...files.length?files:['scripts/*.test.mjs','scripts/*.test.cjs']],{windowsHide:true,env:{...process.env,GOOGLE_ACTIONS_TEST_PORT:'55439',STRIPE_WEBHOOK_TEST_PORT:'55439'}})
  let output=''
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
  const code=await new Promise((yes,no)=>{child.once('exit',yes);child.once('error',no)})
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/isolated-regression.log',output)
  console.log(output.split('\n').filter(line=>/^[✔✖ℹ]/.test(line)).join('\n'))
  exitCode=code??1
}finally{await server.stop();console.log('Disposable PostgreSQL stopped')}
process.exitCode=exitCode
