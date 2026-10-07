import { test, expect } from '@playwright/test'

for (const width of [390, 1280]) test(`parts receipts review, decimal editing, save, reload and void at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await page.clock.setFixedTime(new Date('2026-10-07T15:00:00Z'))
  const owner = { id:'owner',email:'owner@example.com',name:'Owner',role:'owner' }
  const job = { id:'receipt-job',customer:'Receipt Test',phone:'3175550123',address:'Test address',appliance:'Dryer',issue:'Test',service_date:'2026-10-07',service_window:'1:00 PM - 3:00 PM',status:'scheduled',invoice:450,paid:true,created_at:'2026-10-07T12:00:00Z',created_by_user_id:'owner',finance_items:[],model_photo_attachments:[],payments:[{id:'payment',amount:450,status:'succeeded',method:'Cash',source:'offline',createdAt:'2026-10-07T12:00:00Z'}] }
  const data = {supplier:'Synthetic Parts',date:'2026-10-07',currency:'USD',items:[{description:'Pump',partNumber:'TEST123',amountCents:1234}],subtotalCents:1234,taxCents:86,shippingCents:0,totalCents:1320}
  let record: null | {id:string;attachment_id:string;status:string;data:typeof data;created_at:string;confirmed_at:string|null} = null
  let confirms = 0
  let deletedPhotos = 0
  let hiddenPhoto = false
  const photoMetadata = {id:'photo',job_id:job.id,source:'r2',kind:'image',upload_status:'ready',mime_type:'image/png',display_name:'Test receipt.png',hidden_at:'2026-10-07T15:00:00Z'}
  const errors:string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(user=>localStorage.setItem('alex-crm-auth',JSON.stringify({token:'test-only',user})),owner)
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.port==='5186')return route.continue()
    let body:unknown=[]
    if(url.pathname==='/api/auth/me')body=owner
    else if(url.pathname==='/api/jobs')body=[job]
    else if(url.pathname==='/api/jobs/receipt-job')body=job
    else if(url.pathname.endsWith('/attachments'))body={attachments:hiddenPhoto?[]:[photoMetadata],archivedAttachments:hiddenPhoto?[photoMetadata]:[]}
    else if(url.pathname.endsWith('/receipts')&&route.request().method()==='GET')body={receipts:record?[record]:[],aiEnabled:true}
    else if(url.pathname.endsWith('/receipts')){record={id:'receipt',attachment_id:'photo',status:'draft',data:structuredClone(data),created_at:'2026-10-07T15:00:00Z',confirmed_at:null};body={receipt:record}}
    else if(url.pathname.endsWith('/confirm')){confirms++;record!.status='confirmed';record!.data=route.request().postDataJSON().data;body={receipt:record}}
    else if(url.pathname.endsWith('/void')){record!.status='voided';body={receipt:record}}
    else if(url.pathname.endsWith('/discard')){expect(record?.status).not.toBe('confirmed');record=null;body={ok:true}}
    else if(url.pathname.endsWith('/attachments/photo')&&route.request().method()==='DELETE'){deletedPhotos++;hiddenPhoto=true;body={ok:true}}
    else if(url.pathname.endsWith('/uploads'))body={attachment:{id:'photo'},upload:{url:'https://synthetic.invalid/upload',headers:{'Content-Type':'image/png'}}}
    else if(url.pathname.endsWith('/complete')){hiddenPhoto=false;body={attachment:{id:'photo'}}}
    else if(url.pathname==='/upload')return route.fulfill({status:200,body:''})
    else if(url.pathname.endsWith('/url'))body={url:'https://synthetic.invalid/receipt.png'}
    else if(url.hostname==='synthetic.invalid')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64')})
    return route.fulfill({json:body})
  })
  const open = async()=>{
    await page.getByRole('button',{name:/Receipt Test/}).click()
    await page.getByRole('button',{name:'Finance',exact:true}).click()
    await page.getByRole('button',{name:'Costs',exact:true}).click()
  }
  await page.goto('/');await open()
  await expect(page.getByRole('button',{name:'Back',exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Back to jobs',exact:true})).toHaveCount(0)
  await expect(page.getByRole('link',{name:'Navigate',exact:true})).toHaveCount(0)
  await expect(page.locator('.workiz-job-header')).toHaveCSS('background-color','rgb(255, 255, 255)')
  const costs=page.locator('.receipt-costs')
  await expect(costs.locator('input[capture="environment"]')).toHaveAttribute('accept','image/*')
  const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64')
  const chooserEvent=page.waitForEvent('filechooser')
  await costs.getByRole('button',{name:'Add receipt',exact:true}).click()
  await costs.getByRole('button',{name:'Take photo',exact:true}).click()
  const chooser=await chooserEvent
  expect(await chooser.element().getAttribute('capture')).toBe('environment')
  await chooser.setFiles({name:'camera.png',mimeType:'image/png',buffer:photo})
  await expect(costs.getByRole('heading',{name:'Review receipt'})).toBeVisible()
  await costs.getByRole('button',{name:'Delete receipt',exact:true}).click()
  await costs.getByRole('button',{name:'Keep receipt',exact:true}).click()
  await expect(costs.locator('.receipt-entry')).toHaveCount(1)
  await costs.getByRole('button',{name:'Delete receipt',exact:true}).click()
  await costs.getByRole('button',{name:'Confirm delete',exact:true}).click()
  await expect(costs.locator('.receipt-entry')).toHaveCount(0)
  await expect(costs.getByRole('heading',{name:'Review receipt'})).toHaveCount(0)
  expect(deletedPhotos).toBe(1)
  await expect(costs.getByLabel('Existing receipt photo')).toHaveCount(0)
  await costs.getByRole('button',{name:'Add receipt',exact:true}).click()
  const fileEvent=page.waitForEvent('filechooser')
  await costs.getByRole('button',{name:'Choose file',exact:true}).click()
  await (await fileEvent).setFiles({name:'receipt.png',mimeType:'image/png',buffer:photo})
  await expect(costs.getByRole('heading',{name:'Review receipt'})).toBeVisible()
  await expect(costs.getByRole('button',{name:'Confirm expense',exact:true})).toBeEnabled()
  await costs.getByRole('button',{name:'Confirm expense',exact:true}).click()
  await expect(costs.getByRole('alert')).toContainText('I checked the receipt')
  expect(confirms).toBe(0)
  await costs.getByLabel('Supplier',{exact:true}).fill('')
  await costs.getByLabel('Receipt date',{exact:true}).fill('')
  await costs.getByRole('button',{name:'Confirm expense',exact:true}).click()
  await expect(costs.getByRole('alert')).toContainText('supplier, receipt date')
  expect(confirms).toBe(0)
  await costs.getByLabel('Supplier',{exact:true}).fill('Synthetic Parts')
  await costs.getByLabel('Receipt date',{exact:true}).fill('2026-10-07')
  await costs.getByLabel('Total paid',{exact:true}).fill('')
  await costs.getByLabel('Total paid',{exact:true}).pressSequentially('14.37')
  await expect(costs.getByLabel('Total paid',{exact:true})).toHaveValue('14.37')
  await expect(costs.getByRole('alert')).toContainText('do not match')
  await costs.getByRole('checkbox').check()
  await page.screenshot({path:`test-results/receipt-review-${width}.png`,fullPage:true})
  await costs.getByRole('button',{name:'Confirm expense',exact:true}).click()
  await expect(costs.locator('.receipt-summary')).toContainText('$14.37')
  await expect(costs.locator('.receipt-summary > div')).toHaveCount(4)
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$435.63')
  await expect(costs.locator('.receipt-net-income dd')).toHaveCSS('font-weight','800')
  await expect(costs.getByRole('button',{name:'Delete receipt',exact:true})).toBeVisible()
  expect(confirms).toBe(1);expect(record!.data.totalCents).toBe(1437)
  await page.reload();await open()
  await expect(costs.locator('.receipt-summary')).toContainText('$14.37')
  await page.getByRole('button',{name:'Details',exact:true}).click()
  await page.getByRole('button',{name:/1 attachment/}).click()
  await page.getByRole('button',{name:'Attachment actions',exact:true}).click()
  await page.getByRole('button',{name:'Delete',exact:true}).click()
  await page.locator('.attachment-dialog').getByRole('button',{name:'Delete',exact:true}).click()
  await expect(page.locator('.attachment-gallery-row')).toHaveCount(0)
  await page.getByRole('button',{name:'Back to job',exact:true}).click()
  await page.getByRole('button',{name:'Timeline',exact:true}).click()
  const history=page.getByRole('region',{name:'Attachment history'})
  await expect(history).toContainText('Test receipt.png')
  await expect(history).toContainText('Hidden from Attachments')
  await history.getByRole('button',{name:'View file'}).click()
  await expect(page.locator('.attachment-photo-preview img')).toBeVisible()
  await page.getByRole('button',{name:'Close attachment',exact:true}).click()
  await page.getByRole('button',{name:'Finance',exact:true}).click()
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$435.63')
  await costs.getByRole('button',{name:'View receipt',exact:true}).click()
  const viewer=page.locator('.attachment-photo-preview')
  await expect(viewer.locator('img')).toBeVisible()
  await expect(viewer.getByRole('button',{name:'Download photo',exact:true})).toBeVisible()
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('alexNativeBackSwipe')))
  await expect(viewer).toBeVisible()
  await viewer.locator('.attachment-stage').evaluate(element=>{
    element.setPointerCapture=()=>{}
    for(const [type,id,x,y] of [['pointerdown',1,100,200],['pointerdown',2,200,200],['pointermove',2,200,300]] as const)
      element.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:id,pointerType:'touch',clientX:x,clientY:y}))
  })
  await expect(viewer.locator('img')).toHaveAttribute('style',/rotate\(45deg\) scale\(1\.414/)
  await page.screenshot({path:`test-results/receipt-gestures-${width}.png`})
  await viewer.getByRole('button',{name:'Close attachment',exact:true}).click()
  await expect(viewer).toHaveCount(0)
  await costs.getByRole('button',{name:'Void expense',exact:true}).click()
  await costs.getByRole('button',{name:'Confirm void',exact:true}).click()
  await expect(costs.locator('.receipt-summary dd').first()).toHaveText('$0.00')
  await expect(costs.locator('.receipt-entry')).toContainText('voided')
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$450.00')
  job.invoice=325
  job.payments=[]
  record!.status='confirmed'
  record!.confirmed_at='2026-10-07T15:00:00Z'
  record!.data.totalCents=1548
  await page.reload();await open()
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$309.52')
  await costs.getByRole('button',{name:'Delete receipt',exact:true}).click()
  await expect(costs.locator('.receipt-delete-confirmation')).toContainText('cancel its parts expense')
  await costs.getByRole('button',{name:'Keep receipt',exact:true}).click()
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$309.52')
  await costs.getByRole('button',{name:'Delete receipt',exact:true}).click()
  await costs.getByRole('button',{name:'Confirm delete',exact:true}).click()
  await expect(costs.locator('.receipt-entry')).toHaveCount(0)
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$325.00')
  expect(deletedPhotos).toBe(2)
  await page.reload();await open()
  await expect(costs.locator('.receipt-net-income dd')).toHaveText('$325.00')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
