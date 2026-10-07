import { test, expect } from '@playwright/test'

for (const width of [390,1280]) test(`AI parts label, confirmation, supplier failure and selection at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844})
  await page.clock.setFixedTime(new Date('2026-10-07T15:00:00Z'))
  const owner={id:'owner',email:'owner@example.com',name:'Owner',role:'owner'}
  const job={id:'parts-job',customer:'Parts Test',phone:'3175550123',address:'Test address',appliance:'Washer',issue:'Test',service_date:'2026-10-07',service_window:'1:00 PM - 3:00 PM',status:'scheduled',invoice:450,paid:false,created_at:'2026-10-07T12:00:00Z',created_by_user_id:'owner',finance_items:[],model_photo_attachments:[],payments:[]}
  const identity={brand:'Whirlpool',model:'WTW5057LWO',serial:'TEST',applianceType:'washer',confidence:.6,alternatives:['WTW5057LW0']}
  const result={id:'reliable:TEST-PUMP',supplier:'reliable',brand:'Whirlpool',model:'WTW5057LW0',partNumber:'TEST-PUMP',description:'Synthetic drain pump',unitCostCents:10031,currency:'USD',availability:'in_stock',quantity:5,warehouse:'Test warehouse',productUrl:'https://reliableparts.net/us/',evidenceUrl:'https://reliableparts.net/us/',compatibility:'confirmed',replacedPartNumber:'TEST-OLD',retrievedAt:'2026-10-07T15:00:00Z'}
  let configured=true, scanned=false, searches=0, additions=0
  const selected:unknown[]=[]
  const errors:string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(user=>localStorage.setItem('alex-crm-auth',JSON.stringify({token:'test-only',user})),owner)
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.port==='5186')return route.continue()
    let body:unknown=[]
    if(url.pathname==='/api/auth/me')body=owner
    else if(url.pathname==='/api/jobs')body=[job]
    else if(url.pathname==='/api/jobs/parts-job')body=job
    else if(url.pathname.endsWith('/attachments'))body={attachments:[],archivedAttachments:[]}
    else if(url.pathname.endsWith('/parts')&&route.request().method()==='GET')body={scan:scanned?{identity}:null,parts:selected,aiEnabled:true,suppliers:[{supplier:'reliable',status:configured?'CONNECTED':'NOT_CONFIGURED',results:[]},{supplier:'marcone',status:'LOGIN_REQUIRED',results:[]}]}
    else if(url.pathname.endsWith('/parts/scan')){scanned=true;body={identity}}
    else if(url.pathname.endsWith('/parts/search')){searches++;expect(route.request().postDataJSON().identity.model).toBe('WTW5057LW0');expect(route.request().postDataJSON().confirmed).toBe(true);body={id:'search',identity,query:'сливная помпа',intent:{canonicalPartType:'drain_pump',searchTerms:['drain pump']},suppliers:[{supplier:'reliable',status:'CONNECTED',results:[result]},{supplier:'marcone',status:'LOGIN_REQUIRED',results:[]}]}}
    else if(url.pathname.endsWith('/parts')){additions++;const part={id:'selected',part_number:'TEST-PUMP',description:result.description,supplier:'reliable',quantity:2,total_cost_cents:20062};expect(route.request().postDataJSON().quantity).toBe(2);selected.push(part);body={part}}
    else if(url.pathname.endsWith('/uploads'))body={attachment:{id:'label'},upload:{url:'https://synthetic.invalid/upload',headers:{'Content-Type':'image/png'}}}
    else if(url.pathname.endsWith('/complete'))body={attachment:{id:'label'}}
    else if(url.pathname==='/upload')return route.fulfill({status:200,body:''})
    return route.fulfill({json:body})
  })
  const open=async()=>{await page.getByRole('button',{name:/Parts Test/}).click();await page.getByRole('button',{name:'AI Parts Search',exact:true}).click()}
  await page.goto('/');await open()
  const parts=page.locator('.parts-workspace')
  await expect(parts.getByText('Supplier sign-in required',{exact:true})).toBeVisible()
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  const chooserPromise=page.waitForEvent('filechooser')
  await parts.getByRole('button',{name:'Scan label',exact:true}).click()
  const chooser=await chooserPromise
  expect(await chooser.element().getAttribute('capture')).toBe('environment')
  await chooser.setFiles({name:'label.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64')})
  await expect(parts.getByLabel('Model',{exact:true})).toHaveValue('WTW5057LWO')
  await parts.getByLabel('Model',{exact:true}).fill('WTW5057LW0')
  await parts.getByLabel('Part needed',{exact:true}).fill('сливная помпа')
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  await parts.getByRole('checkbox').check()
  await parts.getByRole('button',{name:'Search suppliers',exact:true}).click()
  await expect(parts.locator('.parts-result')).toContainText('$100.31')
  await parts.getByLabel('Quantity',{exact:true}).fill('2')
  await parts.getByRole('button',{name:'Add to job',exact:true}).click()
  await expect(parts.locator('.parts-selected')).toContainText('$200.62')
  await expect(parts.getByRole('button',{name:'Add to job',exact:true})).toBeDisabled()
  await page.screenshot({path:`test-results/parts-search-${width}.png`,fullPage:true})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(searches).toBe(1);expect(additions).toBe(1)
  await parts.getByLabel('Serial',{exact:true}).fill('CORRECTED')
  await expect(parts.getByRole('checkbox')).not.toBeChecked()
  await expect(parts.locator('.parts-result')).toHaveCount(0)
  configured=false
  await page.reload();await open()
  await expect(parts.locator('.parts-selected')).toContainText('TEST-PUMP')
  await expect(parts.getByText('Server connection not configured',{exact:true})).toBeVisible()
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  expect(errors).toEqual([])
})
