import { identityFrom, shortText, type PartSearch } from '../../shared/parts'
import { ReliablePartsConnector, ReliablePublicConnector, MarconeConnector, searchSuppliers, connectionStatuses, type PartsService } from './connectors'
import { recognizeLabel, normalizeIntent } from './recognition'
import { consumePartsQuota, ensurePartsTables, type PartsSql } from './storage'
import { ReliableAccountConnector, MarconeAccountConnector } from './accountConnector'
import { authConfigured, type SupplierSecrets } from './supplierAuth'
import { ReliableCatalog } from './reliableCatalog'

type Context = { sql: PartsSql; userId: string; jobId: string; key?: string; publicCatalog?: boolean; supplierSecrets?: SupplierSecrets; service?: PartsService; loadImage: (id: string) => Promise<{ bytes: ArrayBuffer; mime: string }> }
export async function partsRoute(request: Request, suffix: string, ctx: Context) {
  const { sql, jobId, userId } = ctx
  const respond = (value: unknown, status = 200) => ({ value, status })
  await ensurePartsTables(sql)
  const reliable = ctx.supplierSecrets && authConfigured(ctx.supplierSecrets, 'reliable') ? new ReliableAccountConnector(sql, ctx.supplierSecrets) : new ReliablePublicConnector()
  const marcone = !ctx.service && ctx.supplierSecrets && authConfigured(ctx.supplierSecrets, 'marcone') ? new MarconeAccountConnector(sql, ctx.supplierSecrets) : new MarconeConnector(ctx.service)
  const connectors = [!ctx.service && ctx.publicCatalog ? reliable : new ReliablePartsConnector(ctx.service), marcone]
  if (request.method === 'GET' && suffix === '') {
    const scans = await sql.query("select id,attachment_id,identity from appliance_scans where job_id=$1 and status='complete' order by created_at desc limit 1", [jobId])
    const parts = await sql.query('select * from job_parts where job_id=$1 order by created_at desc', [jobId])
    return respond({ scan: scans[0] || null, parts, aiEnabled: Boolean(ctx.key), suppliers: await connectionStatuses(connectors) })
  }
  if (request.method === 'GET' && suffix.startsWith('/search/')) {
    const rows = await sql.query('select status,data from part_searches where id=$1 and job_id=$2', [suffix.slice(8),jobId])
    return rows.length ? respond(rows[0]) : respond({ error: 'Search not found' },404)
  }
  if (request.method !== 'POST' || !['','/scan','/search','/models'].includes(suffix)) return respond({ error:'Not found' },404)
  const raw = await request.text()
  if (raw.length > 12000) return respond({ error:'Request too large' },413)
  let input: Record<string, unknown>
  try { input = JSON.parse(raw); if (!input || Array.isArray(input) || typeof input !== 'object') throw Error() } catch { return respond({error:'Invalid request'},400) }
  try {
    if (suffix === '/models') {
      if (!ctx.publicCatalog) return respond({ error: 'Catalog unavailable' },503)
      const model = shortText(input.model)
      const brand = shortText(input.brand)
      if (model.length < 4 || !brand) return respond({ error: 'Enter a brand and at least four model characters' },400)
      return respond(await new ReliableCatalog().findModels(model, brand, AbortSignal.timeout(20000)))
    }
    if (suffix === '/scan') {
      if (!ctx.key) return respond({error:'AI_NOT_CONFIGURED'},503)
      const attachmentId = shortText(input.attachmentId)
      const image = await ctx.loadImage(attachmentId)
      const cached = await sql.query("select id,identity,attachment_id from appliance_scans where job_id=$1 and attachment_id=$2 and status='complete'",[jobId,attachmentId])
      if (cached.length) return respond(cached[0])
      const claim = await sql.query(`insert into appliance_scans(id,job_id,attachment_id,created_by) values($1,$2,$3,$4)
        on conflict(job_id,attachment_id) do update set status='processing',updated_at=now()
        where appliance_scans.status='failed' or (appliance_scans.status='processing' and appliance_scans.updated_at<now()-interval '2 minutes') returning id`,[crypto.randomUUID(),jobId,attachmentId,userId])
      if (!claim.length) return respond({error:'This label is already being scanned. Retry shortly.'},409)
      try {
        await consumePartsQuota(sql,userId)
        const identity = await recognizeLabel(ctx.key,image.bytes,image.mime)
        const rows = await sql.query("update appliance_scans set identity=$2::jsonb,status='complete',updated_at=now() where id=$1 returning id,identity,attachment_id",[claim[0].id,JSON.stringify(identity)])
        return respond(rows[0])
      } catch (error) {
        await sql.query("update appliance_scans set status='failed',updated_at=now() where id=$1",[claim[0].id])
        throw error
      }
    }
    if (suffix === '/search') {
      const identity = identityFrom(input.identity)
      const query = shortText(input.query,200)
      const requestKey = shortText(input.requestKey)
      if (!identity.model || !query || input.confirmed !== true || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestKey)) return respond({error:'Confirm the model and enter the required part'},400)
      if (!ctx.key) return respond({error:'AI_NOT_CONFIGURED'},503)
      if (!ctx.service && !ctx.publicCatalog) return respond({error:'Supplier search is not connected to the server yet.'},503)
      const requestHash = JSON.stringify({identity,query})
      const id = crypto.randomUUID()
      const claimed = await sql.query('insert into part_searches(id,job_id,request_key,request_hash,created_by) values($1,$2,$3,$4,$5) on conflict(job_id,request_key) do nothing returning id',[id,jobId,requestKey,requestHash,userId])
      if (!claimed.length) {
        const rows = await sql.query('select data,status,request_hash from part_searches where job_id=$1 and request_key=$2',[jobId,requestKey])
        return rows[0]?.request_hash === requestHash && rows[0]?.status === 'complete' ? respond(rows[0].data) : respond({error:'Search is processing or request has changed. Retry with a new search.'},409)
      }
      try {
        await consumePartsQuota(sql,userId)
        const intent = await normalizeIntent(ctx.key,query)
        if (!intent.searchTerms.length) throw new Error('INVALID_PART_QUERY')
        const started = Date.now()
        const results = await searchSuppliers({identity,intent},connectors)
        const data: PartSearch = {id,identity,query,intent,suppliers:results}
        await sql.query("update part_searches set status='complete',data=$2::jsonb where id=$1",[id,JSON.stringify(data)])
        console.log(JSON.stringify({event:'parts_search',searchId:id,jobId,durationMs:Date.now()-started,suppliers:results.map(r=>({supplier:r.supplier,status:r.status}))}))
        return respond(data)
      } catch (error) { await sql.query("update part_searches set status='failed' where id=$1",[id]); throw error }
    }
    const searchId = shortText(input.searchId)
    const resultId = shortText(input.resultId,200)
    const quantity = input.quantity
    if (!Number.isSafeInteger(quantity) || Number(quantity)<1 || Number(quantity)>100) return respond({error:'Quantity must be 1 to 100'},400)
    const searches = await sql.query("select data from part_searches where id=$1 and job_id=$2 and status='complete'",[searchId,jobId])
    const search = searches[0]?.data as PartSearch | undefined
    const part = search?.suppliers.flatMap(s=>s.results).find(r=>r.id===resultId)
    const age = part ? Date.now()-Date.parse(part.retrievedAt) : NaN
    if (!part || !['confirmed','requires_review'].includes(part.compatibility) || part.unitCostCents === null || !Number.isFinite(age) || age < -60000 || age>15*60*1000) return respond({error:'Search again for a verified, current supplier price'},409)
    if (part.compatibility === 'requires_review' && input.compatibilityReviewed !== true) return respond({error:'Confirm the OEM and model compatibility before adding this part'},409)
    const snapshot = {...part, selectedQuantity:quantity, compatibilityReview:part.compatibility === 'requires_review' ? {by:userId,at:new Date().toISOString()} : null}
    const rows = await sql.query(`insert into job_parts(id,job_id,search_id,result_id,supplier,part_number,description,quantity,unit_cost_cents,total_cost_cents,product_url,created_by,snapshot)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) on conflict(job_id,search_id,result_id) do nothing returning *`,
    [crypto.randomUUID(),jobId,searchId,resultId,part.supplier,part.partNumber,part.description,quantity,part.unitCostCents,part.unitCostCents*Number(quantity),part.productUrl,userId,JSON.stringify(snapshot)])
    const existing = rows[0] || (await sql.query('select * from job_parts where job_id=$1 and search_id=$2 and result_id=$3',[jobId,searchId,resultId]))[0]
    return Number(existing.quantity) === quantity ? respond({part:existing}) : respond({error:'This part was already added with a different quantity'},409)
  } catch (error) {
    const known = ['PHOTO_NOT_READABLE','AI_UNAVAILABLE','INVALID_PART_QUERY','DAILY_LIMIT_REACHED']
    const message = error instanceof Error ? error.message : ''
    return respond({error:known.includes(message)?message:'Unable to process parts request. Check the input and retry.'},message==='DAILY_LIMIT_REACHED'?429:400)
  }
}
