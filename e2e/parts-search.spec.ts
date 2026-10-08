import { test, expect } from '@playwright/test'

for (const width of [390,1280]) test(`AI parts label, confirmation, supplier failure and selection at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844})
  await page.clock.setFixedTime(new Date('2026-10-07T15:00:00Z'))
  const owner={id:'owner',email:'owner@example.com',name:'Owner',role:'owner'}
  const job={id:'parts-job',customer:'Parts Test',phone:'3175550123',address:'Test address',appliance:'Washer',issue:'Test',service_date:'2026-10-07',service_window:'1:00 PM - 3:00 PM',status:'scheduled',invoice:450,paid:false,created_at:'2026-10-07T12:00:00Z',created_by_user_id:'owner',finance_items:[],model_photo_attachments:[],payments:[]}
  const identity={brand:'Whirlpool',model:'WTW5057LWO',serial:'TEST',applianceType:'washer',confidence:.6,alternatives:['WTW5057LW0']}
  const result={id:'reliable:TEST-PUMP',supplier:'reliable',brand:'Whirlpool',model:'WTW5057LW0',partNumber:'TEST-PUMP',description:'Synthetic drain pump',unitCostCents:10031,currency:'USD',availability:'in_stock',quantity:5,warehouse:'Test warehouse',productUrl:'https://reliableparts.net/us/',evidenceUrl:'https://reliableparts.net/us/',compatibility:'confirmed',replacedPartNumber:'TEST-OLD',retrievedAt:'2026-10-07T15:00:00Z'}
  let configured=true, catalogOnly=false, scanned=false, searches=0, additions=0, review=false
  const selected:unknown[]=[]
  const errors:string[]=[]
  const attachmentWrites:string[]=[]
  let labelReads=0
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(user=>localStorage.setItem('alex-crm-auth',JSON.stringify({token:'test-only',user})),owner)
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.port==='5186')return route.continue()
    if(route.request().method()!=='GET' && /\/(uploads|complete|upload|attachments)(\/|$)/.test(url.pathname)) attachmentWrites.push(url.pathname)
    let body:unknown=[]
    if(url.pathname==='/api/auth/me')body=owner
    else if(url.pathname==='/api/jobs')body=[job]
    else if(url.pathname==='/api/jobs/parts-job')body=job
    else if(url.pathname.endsWith('/attachments'))body={attachments:[],archivedAttachments:[]}
    else if(url.pathname.endsWith('/parts')&&route.request().method()==='GET')body={scan:scanned?{identity}:null,parts:selected,aiEnabled:true,suppliers:[{supplier:'reliable',status:catalogOnly?'CATALOG_ONLY':configured?'CONNECTED':'NOT_CONFIGURED',results:[]},{supplier:'marcone',status:'LOGIN_REQUIRED',results:[]}]}
    else if(url.pathname.endsWith('/parts/scan')){labelReads++;expect(route.request().headers()['content-type']).toBe('image/png');expect(route.request().postDataBuffer()?.subarray(0,4)).toEqual(Buffer.from([137,80,78,71]));scanned=true;body={identity}}
    else if(url.pathname.endsWith('/parts/models'))body={supplier:'reliable',truncated:false,models:[{brand:'Whirlpool',model:'WTW5057LW0',diagramUrl:'https://reliableparts.net/us/content/#/model/WTW5057LW0/Whirlpool'},{brand:'Whirlpool',model:'WTW5057LW1',diagramUrl:'https://reliableparts.net/us/content/#/model/WTW5057LW1/Whirlpool'}]}
    else if(url.pathname.endsWith('/parts/search')){searches++;expect(route.request().postDataJSON().identity.model).toBe('WTW5057LW0');expect(route.request().postDataJSON().confirmed).toBe(true);body={id:'search',identity,query:'сливная помпа',intent:{canonicalPartType:'drain_pump',searchTerms:['drain pump']},suppliers:[{supplier:'reliable',status:catalogOnly?'CATALOG_ONLY':'CONNECTED',results:[catalogOnly?{...result,unitCostCents:null,availability:'unknown',quantity:null,warehouse:''}:review?{...result,compatibility:'requires_review'}:result]},{supplier:'marcone',status:'LOGIN_REQUIRED',results:[]}]}}
    else if(url.pathname.endsWith('/parts')){additions++;const part={id:'selected',part_number:'TEST-PUMP',description:result.description,supplier:'reliable',quantity:2,total_cost_cents:20062};expect(route.request().postDataJSON().quantity).toBe(2);if(review)expect(route.request().postDataJSON().compatibilityReviewed).toBe(true);selected.push(part);body={part}}
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
  await expect(parts.getByRole('link',{name:'Search model diagrams on Sears PartsDirect'})).toHaveAttribute('href','https://www.searspartsdirect.com/search?q=WTW5057LWO&tab=model')
  await expect(parts.getByRole('radio')).toHaveCount(2)
  const galleryPromise=page.waitForEvent('filechooser')
  await parts.getByRole('button',{name:'Gallery',exact:true}).click()
  const gallery=await galleryPromise
  expect(await gallery.element().getAttribute('capture')).toBeNull()
  await gallery.setFiles({name:'another-label.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64')})
  await expect(parts.getByRole('button',{name:'Gallery',exact:true})).toBeEnabled()
  expect(labelReads).toBe(2)
  expect(attachmentWrites).toEqual([])
  await expect(parts.getByRole('radio').first()).not.toBeChecked()
  await parts.getByLabel('Part needed',{exact:true}).fill('W10861510')
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeEnabled()
  await parts.getByLabel('Part needed',{exact:true}).fill('fan motor')
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  await parts.getByLabel('Part needed',{exact:true}).fill('')
  await expect(parts.getByRole('checkbox',{name:'I checked the model number'})).toHaveCount(0)
  await parts.getByRole('radio',{name:'Whirlpool WTW5057LW0',exact:true}).check()
  await expect(parts.getByLabel('Model',{exact:true})).toHaveValue('WTW5057LW0')
  await expect(parts.getByRole('link',{name:'Search model diagrams on Sears PartsDirect'})).toHaveAttribute('href','https://www.searspartsdirect.com/search?q=WTW5057LW0&tab=model')
  await expect(parts.getByRole('link',{name:'View diagrams'})).toHaveAttribute('href','https://reliableparts.net/us/content/#/model/WTW5057LW0/Whirlpool')
  await expect(parts.getByLabel('Part needed',{exact:true})).toHaveValue('')
  await page.screenshot({path:`test-results/model-picker-${width}.png`,fullPage:true})
  await parts.getByLabel('Part needed',{exact:true}).fill('сливная помпа')
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeEnabled()
  await parts.getByRole('button',{name:'Search suppliers',exact:true}).click()
  await expect(parts.locator('.parts-result')).toContainText('$100.31')
  await parts.getByLabel('Quantity',{exact:true}).fill('2')
  await parts.getByRole('button',{name:'Add to job',exact:true}).click()
  await expect(parts.locator('.parts-selected')).toContainText('$200.62')
  await expect(parts.getByRole('button',{name:'Add to job',exact:true})).toBeDisabled()
  await page.screenshot({path:`test-results/parts-search-${width}.png`,fullPage:true})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(searches).toBe(1);expect(additions).toBe(1)
  await parts.getByRole('radio',{name:'Whirlpool WTW5057LW1',exact:true}).check()
  await expect(parts.getByLabel('Model',{exact:true})).toHaveValue('WTW5057LW1')
  await expect(parts.locator('.parts-result')).toHaveCount(0)
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeEnabled()
  await parts.getByLabel('Serial',{exact:true}).fill('CORRECTED')
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  await expect(parts.locator('.parts-result')).toHaveCount(0)
  configured=false
  await page.reload();await open()
  await expect(parts.locator('.parts-selected')).toContainText('TEST-PUMP')
  await expect(parts.getByText('Server connection not configured',{exact:true})).toBeVisible()
  await expect(parts.getByRole('button',{name:'Search suppliers',exact:true})).toBeDisabled()
  catalogOnly=true;selected.length=0
  await page.reload();await open()
  await expect(parts.getByText('Catalog available; account price and stock require sign-in')).toBeVisible()
  await parts.getByLabel('Model',{exact:true}).fill('WTW5057LW0')
  await parts.getByLabel('Part needed',{exact:true}).fill('drain pump')
  await parts.getByRole('button',{name:'Find model / diagrams',exact:true}).click()
  await parts.getByRole('radio',{name:'Whirlpool WTW5057LW0',exact:true}).check()
  await parts.getByRole('button',{name:'Search suppliers',exact:true}).click()
  await expect(parts.locator('.parts-result')).toContainText('Price unavailable')
  await expect(parts.getByRole('button',{name:'Add to job',exact:true})).toBeDisabled()
  await page.screenshot({path:`test-results/parts-catalog-${width}.png`,fullPage:true})
  configured=true;catalogOnly=false;review=true;selected.length=0
  await page.reload();await open()
  await parts.getByLabel('Model',{exact:true}).fill('WTW5057LW0')
  await parts.getByLabel('Part needed',{exact:true}).fill('drain pump')
  await parts.getByRole('button',{name:'Find model / diagrams',exact:true}).click()
  await parts.getByRole('radio',{name:'Whirlpool WTW5057LW0',exact:true}).check()
  await parts.getByRole('button',{name:'Search suppliers',exact:true}).click()
  await expect(parts.getByRole('button',{name:'Add to job',exact:true})).toBeDisabled()
  await parts.getByRole('checkbox',{name:'I verified this OEM part fits the model'}).check()
  await parts.getByLabel('Quantity',{exact:true}).fill('2')
  await parts.getByRole('button',{name:'Add to job',exact:true}).click()
  await expect(parts.locator('.parts-selected')).toContainText('$200.62')
  expect(errors).toEqual([])
})
