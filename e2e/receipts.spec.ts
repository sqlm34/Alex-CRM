import { test, expect } from '@playwright/test'

for (const width of [390, 1280]) test(`parts receipts review, decimal editing, save, reload and void at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await page.clock.setFixedTime(new Date('2026-10-07T15:00:00Z'))
  const owner = { id:'owner',email:'owner@example.com',name:'Owner',role:'owner' }
  const job = { id:'receipt-job',customer:'Receipt Test',phone:'3175550123',address:'Test address',appliance:'Dryer',issue:'Test',service_date:'2026-10-07',service_window:'1:00 PM - 3:00 PM',status:'scheduled',invoice:450,paid:true,created_at:'2026-10-07T12:00:00Z',created_by_user_id:'owner',finance_items:[],model_photo_attachments:[],payments:[{id:'payment',amount:450,status:'succeeded',method:'Cash',source:'offline',createdAt:'2026-10-07T12:00:00Z'}] }
  const data = {supplier:'Synthetic Parts',date:'2026-10-07',currency:'USD',items:[{description:'Pump',partNumber:'TEST123',amountCents:1234}],subtotalCents:1234,taxCents:86,shippingCents:0,totalCents:1320}
  let record: null | {id:string;attachment_id:string;status:string;data:typeof data;created_at:string;confirmed_at:string|null} = null
  let confirms = 0
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
    else if(url.pathname.endsWith('/attachments'))body={attachments:[{id:'photo',job_id:job.id,source:'r2',upload_status:'ready',mime_type:'image/png',display_name:'Test receipt.png'}]}
    else if(url.pathname.endsWith('/receipts')&&route.request().method()==='GET')body={receipts:record?[record]:[],aiEnabled:true}
    else if(url.pathname.endsWith('/receipts')){record={id:'receipt',attachment_id:'photo',status:'draft',data:structuredClone(data),created_at:'2026-10-07T15:00:00Z',confirmed_at:null};body={receipt:record}}
    else if(url.pathname.endsWith('/confirm')){confirms++;record!.status='confirmed';record!.data=route.request().postDataJSON().data;body={receipt:record}}
    else if(url.pathname.endsWith('/void')){record!.status='voided';body={receipt:record}}
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
  const costs=page.locator('.receipt-costs')
  await costs.getByLabel('Existing receipt photo').selectOption('photo')
  await expect(costs.getByRole('heading',{name:'Review receipt'})).toBeVisible()
  await expect(costs.getByRole('button',{name:'Confirm expense',exact:true})).toBeDisabled()
  await costs.getByLabel('Total paid',{exact:true}).fill('')
  await costs.getByLabel('Total paid',{exact:true}).pressSequentially('14.37')
  await expect(costs.getByLabel('Total paid',{exact:true})).toHaveValue('14.37')
  await expect(costs.getByRole('alert')).toContainText('do not match')
  await costs.getByRole('checkbox').check()
  await page.screenshot({path:`test-results/receipt-review-${width}.png`,fullPage:true})
  await costs.getByRole('button',{name:'Confirm expense',exact:true}).click()
  await expect(costs.locator('.receipt-summary')).toContainText('$14.37')
  expect(confirms).toBe(1);expect(record!.data.totalCents).toBe(1437)
  await page.reload();await open()
  await expect(costs.locator('.receipt-summary')).toContainText('$14.37')
  await costs.getByRole('button',{name:'View receipt',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Receipt photo'})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog',{name:'Receipt photo'})).toHaveCount(0)
  await costs.getByRole('button',{name:'Void expense',exact:true}).click()
  await costs.getByRole('button',{name:'Confirm void',exact:true}).click()
  await expect(costs.locator('.receipt-summary dd').first()).toHaveText('$0.00')
  await expect(costs.locator('.receipt-entry')).toContainText('voided')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
