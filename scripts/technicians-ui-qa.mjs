import {createServer} from 'vite'
import {chromium} from '@playwright/test'
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
process.env.VITE_API_URL='http://127.0.0.1:5199'
const server=await createServer({plugins:[{name:'qa-export',enforce:'pre',transform(code,id){if(id.endsWith('/src/App.tsx'))return code+'\nexport {OwnerCabinet};'}}],server:{host:'127.0.0.1',port:5199,strictPort:true}})
await server.listen()
const browser=await chromium.launch({headless:true,channel:'chrome'})
await mkdir('artifacts/technicians-qa',{recursive:true})
try{for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:844}})
  page.on('pageerror',e=>console.error(e.message))
  page.on('console',m=>{if(m.type()==='error')console.error(m.text())})
  let rows=[{email:'owner@example.test',user_id:'owner',name:'Test Owner',role:'owner'},{email:'tech@example.test',user_id:'tech',name:'Test Technician',role:'technician'}],deletes=0
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url())
    if(u.hostname!=='127.0.0.1')return route.abort()
    if(u.pathname==='/__qa')return route.fulfill({contentType:'text/html',body:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      const rm=await import('/node_modules/.vite/deps/react.js');const React=rm.default||rm;const dm=await import('/node_modules/.vite/deps/react-dom_client.js');const createRoot=dm.createRoot||dm.default.createRoot;await import('/src/index.css');const {OwnerCabinet}=await import('/src/App.tsx');
      createRoot(document.getElementById('root')).render(React.createElement(OwnerCabinet,{auth:{token:'test',user:{id:'owner',name:'Test Owner',email:'owner@example.test',role:'owner'}},onToast:()=>{}}));</script></body></html>`})
    if(u.pathname==='/api/approved-users'){
      if(route.request().method()==='DELETE'){deletes++;const p=route.request().postDataJSON();assert.equal(p.confirmed,true);rows=rows.filter(r=>r.email!==p.email);return route.fulfill({json:{ok:true}})}
      if(route.request().method()==='POST'){const p=route.request().postDataJSON();rows.push({...p,role:'technician',user_id:'new'});return route.fulfill({json:rows.at(-1)})}
      return route.fulfill({json:rows})
    }
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{}})
    return route.continue()
  })
  await page.goto('http://127.0.0.1:5199/__qa')
  await page.getByText('Default technician',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Delete technician'}).count(),1)
  await page.getByRole('button',{name:'Delete technician'}).click()
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(deletes,0)
  await page.getByRole('button',{name:'Delete technician'}).click()
  await page.getByRole('button',{name:'Confirm removal'}).click()
  await page.getByText('Test Technician',{exact:true}).waitFor({state:'detached'});assert.equal(deletes,1)
  await page.getByLabel('Technician full name').fill('New Test Technician')
  await page.getByLabel('Mobile phone').fill('3175550142')
  await page.getByLabel('Technician email').fill('new@example.test')
  await page.getByRole('button',{name:'Add technician',exact:true}).click()
  await page.getByText('New Test Technician',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:`artifacts/technicians-qa/owner-${width}.png`,fullPage:true})
  await page.close()
}console.log('Technician add/remove/cancel/default owner UI passed at 390 and 1280px (mock API)')}
finally{await browser.close();await server.close()}
