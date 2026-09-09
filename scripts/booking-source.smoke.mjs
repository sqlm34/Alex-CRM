import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const origin=process.env.SMOKE_URL || 'http://127.0.0.1:4194'
assert.equal(new URL(origin).hostname,'127.0.0.1')
const output=process.env.SMOKE_OUTPUT || 'C:/Users/sqlm1/AppData/Local/AlexCRM/BookingSourceSmoke'
mkdirSync(output,{recursive:true})
const browser=await chromium.launch({headless:true,channel:'chrome'})
try {
  for(const width of [360,393,1280]) {
    const page=await browser.newPage({viewport:{width,height:873}})
    const user={id:'test-owner',name:'Test Owner',email:'owner@example.test',role:'owner',provider:'email'}
    let bookingSource='google_maps', polls=0
    const errors=[],writes=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.addInitScript(user=>{if(window.top===window && location.hostname==='127.0.0.1') localStorage.setItem('alex-crm-auth',JSON.stringify({token:'isolated-fixture-token',user}))},user)
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname
      const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)})
      const job={id:'J-SOURCE-TEST',customer:'Test Customer',phone:'',address:'Test address',email:'',appliance:'Washer',issue:'Test only',service_date:new Date().toLocaleDateString('en-CA'),service_window:'9:00 AM - 11:00 AM',status:'scheduled',invoice:0,paid:false,created_at:new Date().toISOString(),booking_source:bookingSource}
      if(path.startsWith('/api/')) {
        if(path==='/api/auth/me')return json(user)
        if(['/api/auth/heartbeat','/api/auth/offline'].includes(path))return json({ok:true})
        if(request.method()!=='GET')writes.push(path)
        if(path==='/api/jobs'){polls++;return json([job])}
        if(path==='/api/jobs/J-SOURCE-TEST')return json({...job,finance_items:[],payments:[],model_photo_attachments:[]})
        if(path.endsWith('/attachments'))return json({attachments:[]})
        return json([])
      }
      if(url.origin===origin)return route.continue()
      return route.abort()
    })
    for(const [source,label] of [['google_maps','Google Maps'],['google','Google'],['website','Website'],[null,null]]) {
      bookingSource=source
      await page.goto(origin)
      await page.getByText('Test Customer',{exact:true}).first().click()
      if(label){await page.locator('.booking-source-badge').getByText(label,{exact:true}).waitFor()}
      else assert.equal(await page.locator('.booking-source-badge').count(),0)
      if(width===360 && source==='google_maps') {
        const before=polls
        await page.waitForTimeout(41000)
        assert.ok(polls>before)
        assert.equal(await page.locator('.booking-source-badge').innerText(),label)
      }
      assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
      await page.screenshot({path:`${output}/${source||'manual'}-${width}.png`})
      await page.getByRole('button',{name:'Back to jobs',exact:true}).click()
      await page.getByText('Test Customer',{exact:true}).first().click()
      assert.equal(await page.locator('.booking-source-badge').count(),label?1:0)
    }
    assert.deepEqual(writes,[]); assert.deepEqual(errors,[])
    console.log(JSON.stringify({width,polls,errors,writes,badges:'all three; manual absent; reopen passed'}))
    await page.close()
  }
} finally {await browser.close()}
