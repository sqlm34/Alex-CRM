begin;
create table if not exists inventory_parts (
  id uuid primary key,
  name text not null check(length(name) between 1 and 200),
  part_number text not null check(length(part_number) between 1 and 100),
  brand text not null default '' check(length(brand)<=100),
  number_key text generated always as (regexp_replace(upper(part_number),'[^A-Z0-9]','','g')) stored,
  brand_key text generated always as (upper(trim(brand))) stored,
  location text not null default '', notes text not null default '', models text not null default '',
  low_stock integer not null default 1 check(low_stock>=0),
  photo_key text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(number_key,brand_key), check(number_key<>'')
);
create table if not exists inventory_batches (
  id uuid primary key, part_id uuid not null references inventory_parts(id),
  supplier text not null, invoice_number text not null default '', purchase_date date not null,
  quantity integer not null check(quantity>0), remaining integer not null check(remaining>=0 and remaining<=quantity),
  total_cents bigint not null check(total_cents>=0), remaining_cents bigint not null check(remaining_cents>=0 and remaining_cents<=total_cents),
  cost_breakdown jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists inventory_batches_fifo on inventory_batches(part_id,purchase_date,created_at,id);
create table if not exists inventory_operations (
  id uuid primary key, payload jsonb not null, actor text not null,
  result jsonb not null default '{}', created_at timestamptz not null default now()
);
create table if not exists inventory_job_usage (
  id uuid primary key references inventory_operations(id),
  job_id text references jobs(id) on delete set null, original_job_id text not null,
  part_id uuid not null references inventory_parts(id), quantity integer not null check(quantity>0),
  purchase_cents bigint not null check(purchase_cents>=0), expense_cents bigint not null check(expense_cents>=0),
  returned_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists inventory_job_usage_job on inventory_job_usage(job_id);
alter table parts_receipts add column if not exists inventory_usage_id uuid references inventory_job_usage(id);
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='parts_receipts'::regclass and conname='parts_receipts_inventory_usage_id_fkey') then
    alter table parts_receipts add constraint parts_receipts_inventory_usage_id_fkey foreign key (inventory_usage_id) references inventory_job_usage(id);
  end if;
end $$;
create unique index if not exists parts_receipts_inventory_usage on parts_receipts(inventory_usage_id) where inventory_usage_id is not null;
create table if not exists inventory_movements (
  id bigint generated always as identity primary key,
  operation_id uuid not null references inventory_operations(id),
  part_id uuid not null references inventory_parts(id), batch_id uuid not null references inventory_batches(id),
  kind text not null check(kind in ('stock_in','stock_out','return','adjustment','damaged')),
  quantity integer not null check(quantity<>0), cost_cents bigint not null,
  reason text not null, job_id text references jobs(id) on delete set null,
  created_at timestamptz not null default now(), unique(operation_id,batch_id)
);
create index if not exists inventory_movements_part on inventory_movements(part_id,created_at desc);
create table if not exists inventory_invoice_imports (
  id uuid primary key, content_hash text not null unique, object_key text not null,
  data jsonb, status text not null check(status in ('processing','review','imported','failed')),
  duplicate_key text,
  actor text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table inventory_parts enable row level security;
alter table inventory_batches enable row level security;
alter table inventory_operations enable row level security;
alter table inventory_job_usage enable row level security;
alter table inventory_movements enable row level security;
alter table inventory_invoice_imports enable row level security;

-- One database transaction owns each mutation. Lock the part before its FIFO lots.
-- Integer remainder allocation conserves every cent, including after returns.
create or replace function inventory_move(p jsonb, who text) returns jsonb language plpgsql as $$
declare op uuid := (p->>'requestId')::uuid; part uuid := (p->>'partId')::uuid;
  action text := p->>'action'; qty integer := (p->>'quantity')::integer;
  prior inventory_operations%rowtype; lot inventory_batches%rowtype;
  used inventory_job_usage%rowtype; movement record; left_qty integer; taken integer;
  cents bigint; total bigint := 0; batch uuid; answer jsonb;
begin
  if coalesce(who,'')='' then raise exception 'Owner required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op::text,0));
  select * into prior from inventory_operations where id=op;
  if found then
    if prior.payload<>p or prior.actor<>who then raise exception 'Request ID already used'; end if;
    return prior.result;
  end if;
  perform 1 from inventory_parts where id=part for update;
  if not found then raise exception 'Part not found'; end if;
  if action not in ('stock_in','stock_out','return','adjustment','damaged') then raise exception 'Invalid movement'; end if;
  if qty is null or qty<1 or qty>100000 then raise exception 'Invalid quantity'; end if;
  if length(coalesce(p->>'reason',''))>500 then raise exception 'Reason too long'; end if;
  insert into inventory_operations(id,payload,actor) values(op,p,who);
  if action='stock_in' then
    total := (p->>'totalCents')::bigint;
    if total is null or total<0 or total>100000000 then raise exception 'Invalid purchase total'; end if;
    batch := op;
    insert into inventory_batches(id,part_id,supplier,invoice_number,purchase_date,quantity,remaining,total_cents,remaining_cents,cost_breakdown)
      values(batch,part,coalesce(p->>'supplier',''),coalesce(p->>'invoiceNumber',''),(p->>'date')::date,qty,qty,total,total,coalesce(p->'costBreakdown','{}'::jsonb));
    insert into inventory_movements(operation_id,part_id,batch_id,kind,quantity,cost_cents,reason)
      values(op,part,batch,action,qty,total,coalesce(p->>'reason',''));
  elsif action='return' then
    select * into used from inventory_job_usage where id=(p->>'usageId')::uuid and part_id=part for update;
    if not found or used.returned_at is not null then raise exception 'Usage already returned or not found'; end if;
    if qty<>used.quantity then raise exception 'Return the complete usage; confirm remaining installed quantity separately'; end if;
    for movement in select * from inventory_movements where operation_id=used.id and kind='stock_out' loop
      update inventory_batches set remaining=remaining-movement.quantity, remaining_cents=remaining_cents-movement.cost_cents where id=movement.batch_id;
      insert into inventory_movements(operation_id,part_id,batch_id,kind,quantity,cost_cents,reason,job_id)
        values(op,part,movement.batch_id,'return',-movement.quantity,-movement.cost_cents,coalesce(p->>'reason',''),used.job_id);
    end loop;
    update inventory_job_usage set returned_at=now() where id=used.id;
    update parts_receipts set status='voided',voided_by=who,updated_at=now() where inventory_usage_id=used.id;
    total:=used.purchase_cents;
  else
    if action='stock_out' then
      perform 1 from jobs where id=p->>'jobId' and status<>'canceled' for update;
      if not found then raise exception 'Active job required'; end if;
    elsif coalesce(trim(p->>'reason'),'')='' then raise exception 'Reason required'; end if;
    left_qty:=qty;
    for lot in select * from inventory_batches where part_id=part and remaining>0 order by purchase_date,created_at,id for update loop
      taken:=least(left_qty,lot.remaining);
      cents:=floor(lot.remaining_cents::numeric*taken/lot.remaining)::bigint;
      update inventory_batches set remaining=remaining-taken,remaining_cents=remaining_cents-cents where id=lot.id;
      insert into inventory_movements(operation_id,part_id,batch_id,kind,quantity,cost_cents,reason,job_id)
        values(op,part,lot.id,action,-taken,-cents,coalesce(p->>'reason',''),case when action='stock_out' then p->>'jobId' else null end);
      total:=total+cents; left_qty:=left_qty-taken;
      exit when left_qty=0;
    end loop;
    if left_qty>0 then raise exception 'Not enough stock'; end if;
    if action='stock_out' then
      insert into inventory_job_usage(id,job_id,original_job_id,part_id,quantity,purchase_cents,expense_cents)
        values(op,p->>'jobId',p->>'jobId',part,qty,total,total);
      insert into parts_receipts(id,job_id,attachment_id,content_hash,status,data,created_by,confirmed_by,confirmed_at,inventory_usage_id)
        select op::text,p->>'jobId','','inventory:'||op::text,'confirmed',jsonb_build_object(
          'supplier','Parts Inventory','date',to_char(now() at time zone 'America/Indiana/Indianapolis','YYYY-MM-DD'),'currency','USD',
          'items',jsonb_build_array(jsonb_build_object('description',name,'partNumber',part_number,'quantity',qty,'amountCents',total)),
          'subtotalCents',total,'taxCents',0,'shippingCents',0,'totalCents',total,'expenseCents',total),who,who,now(),op
        from inventory_parts where id=part;
    end if;
  end if;
  answer:=jsonb_build_object('id',op,'costCents',total,'quantity',qty);
  update inventory_operations set result=answer where id=op;
  return answer;
end $$;
revoke all on function inventory_move(jsonb,text) from public;
create or replace function inventory_create_part(p jsonb, who text) returns jsonb language plpgsql as $$
begin
  insert into inventory_parts(id,name,part_number,brand,location,notes,models,low_stock)
    values((p->>'id')::uuid,p->>'name',p->>'part_number',p->>'brand',p->>'location',p->>'notes',p->>'models',(p->>'low_stock')::int)
    on conflict(id) do nothing;
  if p->'purchase' is not null and p->'purchase'<>'null'::jsonb then
    perform inventory_move((p->'purchase')||jsonb_build_object('requestId',p->>'requestId','partId',p->>'id','action','stock_in'),who);
  end if;
  return jsonb_build_object('id',p->>'id');
end $$;
revoke all on function inventory_create_part(jsonb,text) from public;
alter table inventory_invoice_imports add column if not exists duplicate_key text;
create index if not exists inventory_invoice_duplicate on inventory_invoice_imports(duplicate_key) where status='imported';
drop function if exists inventory_import_invoice(uuid,jsonb,text);
create or replace function inventory_import_invoice(import_id uuid, lines jsonb, who text, allow_duplicate boolean default false) returns jsonb language plpgsql as $$
declare invoice inventory_invoice_imports%rowtype; line jsonb; part uuid; operation uuid; fingerprint text; previous inventory_invoice_imports%rowtype;
begin
  select * into invoice from inventory_invoice_imports where id=import_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if invoice.status='imported' then return jsonb_build_object('imported',true,'replay',true); end if;
  if invoice.status<>'review' then raise exception 'Invoice is not ready'; end if;
  if jsonb_array_length(lines)<1 or jsonb_array_length(lines)>100 then raise exception 'Invalid invoice lines'; end if;
  select md5(jsonb_agg(identity order by identity::text)::text) into fingerprint from (
    select distinct jsonb_build_array(upper(trim(value->>'supplier')),value->>'date',upper(trim(coalesce(value->>'invoiceNumber',''))),
      case when coalesce(trim(value->>'invoiceNumber'),'')='' then jsonb_build_array(regexp_replace(upper(value->>'partNumber'),'[^A-Z0-9]','','g'),upper(trim(value->>'brand')),value->'quantity',value->'totalCents') else null end) as identity
    from jsonb_array_elements(lines)) identities;
  perform pg_advisory_xact_lock(hashtextextended(fingerprint,1));
  select * into previous from inventory_invoice_imports where duplicate_key=fingerprint and status='imported' and id<>import_id limit 1;
  if found and not allow_duplicate then
    return jsonb_build_object('duplicate',true,'existingImportId',previous.id,'reviewedLines',previous.data->'reviewedLines');
  end if;
  for line in select value from jsonb_array_elements(lines) order by regexp_replace(upper(value->>'partNumber'),'[^A-Z0-9]','','g'),upper(trim(value->>'brand')) loop
    part := (line->>'partId')::uuid; operation := (line->>'requestId')::uuid;
    insert into inventory_parts(id,name,part_number,brand)
      values(part,line->>'name',line->>'partNumber',coalesce(line->>'brand',''))
      on conflict(number_key,brand_key) do nothing;
    select id into part from inventory_parts where number_key=regexp_replace(upper(line->>'partNumber'),'[^A-Z0-9]','','g') and brand_key=upper(trim(coalesce(line->>'brand','')));
    perform inventory_move(jsonb_build_object('requestId',operation,'partId',part,'action','stock_in','quantity',(line->>'quantity')::int,
      'totalCents',(line->>'totalCents')::bigint,'supplier',line->>'supplier','invoiceNumber',line->>'invoiceNumber','date',line->>'date','reason','Invoice import '||import_id::text),who);
  end loop;
  update inventory_invoice_imports set status='imported',duplicate_key=fingerprint,data=jsonb_build_object('reviewedLines',lines,'recognition',data,'duplicateApproved',allow_duplicate),updated_at=now() where id=import_id;
  return jsonb_build_object('imported',true);
end $$;
revoke all on function inventory_import_invoice(uuid,jsonb,text,boolean) from public;
commit;
