import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

process.env.VITE_API_URL='http://127.0.0.1:5198'
const server=await createServer({optimizeDeps:{entries:['index.html'],include:['react','react-dom/client']},server:{host:'127.0.0.1',port:5198,strictPort:true,hmr:false}})
await server.listen()
const browser=await chromium.launch({headless:true,channel:'chrome'})
const part={id:'11111111-1111-4111-8111-111111111111',name:'Dryer roller',part_number:'DC-123',brand:'Samsung',quantity:4,value_cents:4060,suppliers:'Amazon',low_stock:1,location:'Van A',models:'',notes:''}
const now=new Date()
const calls=Array.from({length:40},(_,i)=>({id:`call${i}`,customer:i?'John Smith':'Jane Test',caller_phone:'+13175550142',channel:'phone',started_at:new Date(now.getTime()-i*3600000).toISOString(),outcome:'booked',summary:'Washer not draining',job_id:'job1',cost_cents:12,latency_ms:200,callback_status:'pending',duration_ms:87000}))
const fixture=component=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}#root{min-height:100vh}</style></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const rm=await import('/node_modules/.vite/deps/react.js');const React=rm.default||rm;const dm=await import('/node_modules/.vite/deps/react-dom_client.js');const createRoot=dm.createRoot||dm.default.createRoot;await import('/src/index.css');await import('/src/App.css');
const {${component}}=await import('/src/${component}.tsx');createRoot(document.getElementById('root')).render(React.createElement('main',{className:'app-shell'},React.createElement('section',{className:'workspace ${component==='ReceptionistPage'?'receptionist-workspace':''}'},React.createElement(${component},{token:'test',jobId:'job1',onChange:async()=>{}}))));</script></body></html>`
await mkdir('artifacts/inventory-qa',{recursive:true})
try{
  for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:844}})
    const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)})
    let blockedRows=[], blockWrites=0
    page.on('console',message=>{if(message.type()==='error')console.error(message.text())})
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url())
      if(u.hostname!=='127.0.0.1')return route.abort()
      if(u.pathname==='/__qa')return route.fulfill({contentType:'text/html',body:fixture(u.searchParams.get('component')||'InventoryPage')})
      if(u.pathname.startsWith('/api/')){
        let data={}
        if(u.pathname==='/api/inventory/parts')data={parts:[part]}
        else if(u.pathname==='/api/inventory/scan')data={id:'scan-test',status:'review',data:{currency:'USD',supplier:'Amazon',date:'2026-10-21',invoiceNumber:'TEST-21',totalCents:2138,items:[{description:'Samsung belt',partNumber:'6602-001655',brand:'Samsung',quantity:2,amountCents:2138}]}}
        else if(u.pathname.startsWith('/api/inventory/parts/'))data={batches:[{id:'b1',supplier:'Amazon',purchase_date:'2026-10-01',quantity:4,remaining:4,total_cents:'4060',remaining_cents:'4060'}],movements:[]}
        else if(u.pathname.endsWith('/usage'))data={usage:[]}
        else if(u.pathname.endsWith('/diagnostics'))data={schemaReady:true}
        else if(u.pathname.endsWith('/settings'))data={serviceZips:[],appliances:[]}
        else if(u.pathname.endsWith('/calls')||u.pathname.endsWith('/abandoned'))data=calls
        else if(u.pathname.endsWith('/recording'))data={available:false,reason:'No recording in test'}
        else if(u.pathname.endsWith('/blocked-numbers')){
          if(route.request().method()==='POST'){
            const payload=route.request().postDataJSON();blockWrites++
            blockedRows=[{phone:payload.phone,blocked:payload.blocked,reason:payload.reason,updated_at:now.toISOString()}]
          }
          data={rows:blockedRows,history:[]}
        }
        return route.fulfill({json:data})
      }
      return route.continue()
    })
    await page.goto('http://127.0.0.1:5198/__qa?component=InventoryPage')
    await page.getByRole('heading',{name:'Parts Inventory'}).waitFor({timeout:60000})
    await page.getByRole('button',{name:/Dryer roller/}).waitFor()
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:`artifacts/inventory-qa/inventory-${width}.png`,fullPage:true})
    await page.getByRole('button',{name:/Dryer roller/}).click()
    await page.getByRole('heading',{name:'Stock movement'}).waitFor()
    assert.ok(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth))
    await page.screenshot({path:`artifacts/inventory-qa/part-${width}.png`})
    await page.getByRole('button',{name:'Close',exact:true}).click()
    await page.getByRole('button',{name:'Add Part',exact:true}).click()
    await page.getByLabel('Part name',{exact:true}).fill('Drain pump')
    await page.getByLabel('Part number',{exact:true}).fill('WP123')
    await page.getByLabel('Add initial purchase').uncheck()
    await page.getByRole('button',{name:'Save Part',exact:true}).click()
    await page.locator('dialog').waitFor({state:'detached'})
    await page.getByRole('button',{name:'Add Part',exact:true}).click()
    await page.locator('dialog > input[type=file]').first().setInputFiles(`artifacts/inventory-qa/inventory-${width}.png`)
    await page.getByRole('heading',{name:'Review Scanned Invoice'}).waitFor()
    assert.equal(await page.getByLabel('Supplier',{exact:true}).inputValue(),'Amazon')
    assert.equal(await page.getByLabel('Part number',{exact:true}).inputValue(),'6602-001655')
    assert.equal(await page.getByLabel('Physical units (check pack size)',{exact:true}).inputValue(),'2')
    assert.equal(await page.getByLabel('Allocated total incl. tax / shipping ($)',{exact:true}).inputValue(),'21.38')
    assert.equal(await page.getByRole('button',{name:'Confirm Import'}).isDisabled(),true)
    await page.screenshot({path:`artifacts/inventory-qa/scan-${width}.png`,fullPage:true})
    await page.getByRole('button',{name:'Close Review',exact:true}).click()
    await page.getByRole('button',{name:'Save Part',exact:true}).waitFor()
    await page.getByRole('button',{name:'Close',exact:true}).click()
    await page.goto('http://127.0.0.1:5198/__qa?component=ReceptionistPage')
    await page.getByRole('heading',{name:'AI Receptionist',exact:true}).waitFor()
    await page.getByRole('button',{name:/Jane Test/}).waitFor()
    const controls=await page.locator('.receptionist-controls').boundingBox()
    await page.locator('.receptionist-scroll').evaluate(e=>e.scrollTop=600)
    assert.deepEqual(await page.locator('.receptionist-controls').boundingBox(),controls)
    assert.ok(await page.locator('.receptionist-scroll').evaluate(e=>e.scrollTop>0))
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.getByRole('button',{name:'Today',exact:true}).click()
    await page.screenshot({path:`artifacts/inventory-qa/calls-${width}.png`})
    await page.getByRole('button',{name:/Jane Test/}).click()
    await page.getByRole('button',{name:'Block Number',exact:true}).click()
    await page.getByLabel('Reason (optional)').fill('Test only')
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await page.getByRole('button',{name:'Unblock Number',exact:true}).waitFor()
    await page.locator('[data-receptionist-detail-back]').click()
    await page.getByRole('button',{name:'Blocked Numbers',exact:true}).click()
    await page.getByRole('button',{name:'Unblock Number',exact:true}).click()
    const beforeCancel=blockWrites
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    assert.equal(blockWrites,beforeCancel)
    await page.getByRole('button',{name:'Unblock Number',exact:true}).click()
    await page.getByRole('button',{name:'Confirm',exact:true}).click()
    await page.getByText(/Allowed/).waitFor()
    assert.equal(blockWrites,beforeCancel+1)
    assert.deepEqual(errors,[])
    await page.close()
  }
  console.log('Mobile and desktop UI: layout, independent call scroll, part form and block toggle passed (mock API).')
}finally{await browser.close();await server.close()}
