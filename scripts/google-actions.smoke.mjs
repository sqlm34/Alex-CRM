import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const origin=process.env.SMOKE_URL || 'http://127.0.0.1:4196'
assert.equal(new URL(origin).hostname,'127.0.0.1')
const output=process.env.SMOKE_OUTPUT || 'C:/Users/sqlm1/AppData/Local/AlexCRM/GoogleActionsLab-20260909/screenshots'
mkdirSync(output,{recursive:true})
const browser=await chromium.launch({headless:true,channel:'chrome'})
try {
  for(const width of [360,393,1280]) {
    const context=await browser.newContext({viewport:{width,height:873},userAgent:'Mozilla/5.0 (compatible; Google-Appointments)'})
    const page=await context.newPage(),errors=[],writes=[]
    const user={id:'test-owner',name:'Test Owner',email:'owner@example.test',role:'owner',provider:'email'}
    let polls=0
    page.on('pageerror',e=>errors.push(e.message))
    await context.route('**/*',async route=>{
      const r=route.request(),u=new URL(r.url()),p=u.pathname
      const json=x=>route.fulfill({contentType:'application/json',body:JSON.stringify(x)})
      if(p.startsWith('/api/')){
        if(['/api/auth/heartbeat','/api/auth/offline'].includes(p))return json({ok:true})
        if(r.method()!=='GET')writes.push(p)
        if(p==='/api/public/booking/config')return json({turnstileSiteKey:'',smsRequired:false,googleActionsCenterEnabled:false})
        if(p==='/api/public/booking/availability')return json({bookedWindows:[]})
        if(p==='/api/auth/me')return json(user)
        const job={id:'J-GOOGLE-TEST',customer:'Synthetic Customer',phone:'',address:'Synthetic address',email:'',appliance:'Washer',issue:'Test only',service_date:new Date().toLocaleDateString('en-CA'),service_window:'9:00 AM - 11:00 AM',status:'scheduled',invoice:0,paid:false,booking_source:'google',booking_source_detail:'actions_center'}
        if(p==='/api/jobs'){polls++;return json([job])}
        if(p==='/api/jobs/J-GOOGLE-TEST')return json({...job,finance_items:[],payments:[],model_photo_attachments:[]})
        if(p.endsWith('/attachments'))return json({attachments:[]})
        return json([])
      }
      if(u.origin===origin)return route.continue()
      return route.abort()
    })
    const response=await page.goto(origin+'/booking?utm_source=google&rwg_token=synthetic%2B%3D&merchant_id=test-merchant&foo=bar')
    assert.equal(response.status(),200)
    await page.locator('.booking-shell').waitFor()
    assert.ok(!page.url().includes('rwg_token'))
    assert.ok(page.url().includes('foo=bar'))
    const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('alex-google-actions-attribution-v1')))
    assert.equal(before.rwg_token,'synthetic+=')
    await page.reload()
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('alex-google-actions-attribution-v1'))),before)
    assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
    await page.screenshot({path:`${output}/booking-${width}.png`})
    await page.evaluate(user=>localStorage.setItem('alex-crm-auth',JSON.stringify({token:'isolated-fixture',user})),user)
    await page.goto(origin)
    try { await page.getByText('Synthetic Customer',{exact:true}).first().click({timeout:10000}) }
    catch(error){await page.screenshot({path:`${output}/failure-${width}.png`});console.log(JSON.stringify({errors,writes,body:await page.locator('body').innerText()}));throw error}
    await page.locator('.booking-source-badge').getByText('Google · Book Online',{exact:true}).waitFor()
    if(width===360){const previous=polls;await page.waitForTimeout(41000);assert.ok(polls>previous)}
    await page.getByRole('button',{name:'Back to jobs',exact:true}).click()
    await page.getByText('Synthetic Customer',{exact:true}).first().click()
    assert.equal(await page.locator('.booking-source-badge').innerText(),'Google · Book Online')
    assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
    await page.screenshot({path:`${output}/source-${width}.png`})
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
    console.log(JSON.stringify({width,errors,writes,polls,directBooking:200,tokenCapture:'pass',queryCleanup:'pass',reopen:'pass'}))
    await context.close()
  }
} finally {await browser.close()}
