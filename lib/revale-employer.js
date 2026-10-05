import { createHash, randomUUID } from 'node:crypto';
import { rosterSignature } from './revale-employer-governance.js';

async function serialQuery(sql, text, args) {
  const [rows] = await sql.transaction([sql.query(text, args)], { isolationLevel: 'Serializable' });
  return rows;
}

const TODAY = "(now() AT TIME ZONE 'America/Guayaquil')::date";
export function problem(status, message) { return Object.assign(new Error(message), { status }); }
export function moneyValue(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Math.round(amount * 100) !== Math.round(amount * 10000) / 100) {
    throw problem(400, 'Ingresa un monto positivo con máximo dos decimales.');
  }
  return Math.round(amount * 100) / 100;
}
export function period(query = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = String(query.from || today.slice(0, 7) + '-01');
  const end = String(query.to || today);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!valid(start) || !valid(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 366) throw problem(400, 'Elige un período válido de hasta un año.');
  return { from: start, to: end };
}
export const isEmployerDemo = p => p.employerId === 'employer_demo_revale' && p.email === 'beneficios@demo.revale.app';
export function merchantPresentation(principal, row) {
  if (!isEmployerDemo(principal) || (row.merchant_id || row.id) !== 'merchant_cebiches_ruminahui') return row;
  return { ...row, ...(row.merchant_name ? { merchant_name: 'BOGÖ', location_name: 'Tumbaco' } : { name: 'BOGÖ', slug: 'bogo' }) };
}
export function capabilities(principal) {
  return { manageBenefits: ['admin', 'hr'].includes(principal.role), manageEmployees: ['admin', 'hr'].includes(principal.role), requestFunding: ['admin', 'hr', 'finance'].includes(principal.role), manageTeam: principal.role==='admin', managePolicy: principal.role==='admin', approveFunding: ['admin','finance'].includes(principal.role) };
}

export async function employees(sql, employerId, programId = null) {
  return sql.query(`SELECT p.id AS person_id,p.first_name,p.last_name,p.email,p.person_identification,
    ee.id::text AS enrollment_id,ee.program_id,ee.status,ee.starts_on::text,ee.ends_on::text,
    COALESCE(ee.metadata->>'department','') AS department,COALESCE(ee.metadata->>'cost_center','') AS cost_center,
    CASE WHEN (ee.metadata->>'allocation_amount')~'^[0-9]+([.][0-9]{1,2})?$' THEN (ee.metadata->>'allocation_amount')::float8 ELSE bp.allocation_amount::float8 END AS suggested_amount,
    CASE WHEN p.auth_user_id IS NOT NULL THEN 'activated' WHEN inv.person_id IS NULL THEN 'not_invited'
      WHEN inv.expires_at<=now() THEN 'expired' ELSE 'invited' END AS access_status,
    inv.expires_at AS invitation_expires_at,p.activated_at,
    bp.name AS program_name,bp.active AS program_active,
    CASE WHEN a.account_count=1 THEN a.account_id END AS account_id,
    CASE WHEN a.account_count=1 AND NOT EXISTS (
      SELECT 1 FROM revale.employee_enrollments other JOIN revale.benefit_programs ob ON ob.id=other.program_id
      WHERE other.person_id=p.id AND ob.employer_id<>$1
    ) THEN a.balance END AS balance,
    (a.account_count=1 AND NOT EXISTS (SELECT 1 FROM revale.employee_enrollments other JOIN revale.benefit_programs ob ON ob.id=other.program_id WHERE other.person_id=p.id AND ob.employer_id<>$1) AND p.active AND ee.status='active' AND bp.active
      AND ee.starts_on<=${TODAY} AND (ee.ends_on IS NULL OR ee.ends_on>=${TODAY})
      AND (bp.valid_from IS NULL OR bp.valid_from<=${TODAY}) AND (bp.valid_until IS NULL OR bp.valid_until>=${TODAY})) AS funding_ready
    FROM revale.employee_enrollments ee
    JOIN revale.benefit_programs bp ON bp.id=ee.program_id JOIN revale.persons p ON p.id=ee.person_id
    LEFT JOIN revale.employee_access_invites inv ON inv.person_id=p.id AND inv.employer_id=$1
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS account_count,MIN(ba.id) AS account_id,MAX(ba.balance)::float8 AS balance
      FROM revale.cards c JOIN revale.benefit_accounts ba ON ba.card_number=c.card_number WHERE c.person_id=p.id AND c.active=true
    ) a ON true
    WHERE bp.employer_id=$1 AND ($2::text IS NULL OR bp.id=$2)
    ORDER BY p.first_name,p.last_name,bp.name`, [employerId, programId]);
}
export async function programs(sql, employerId) {
  return sql.query(`SELECT bp.id,bp.name,bp.benefit_type,bp.currency,bp.allocation_amount::float8 AS allocation_amount,
    bp.allocation_frequency,bp.rollover_policy,bp.valid_from::text,bp.valid_until::text,bp.active,
    COUNT(ee.id) FILTER (WHERE ee.status='active' AND ee.starts_on<=${TODAY} AND (ee.ends_on IS NULL OR ee.ends_on>=${TODAY}))::int AS active_employees
    FROM revale.benefit_programs bp LEFT JOIN revale.employee_enrollments ee ON ee.program_id=bp.id
    WHERE bp.employer_id=$1 GROUP BY bp.id ORDER BY bp.created_at DESC`, [employerId]);
}
const FUNDING_SELECT = `SELECT fb.id,fb.program_id,bp.name AS program_name,fb.external_reference,fb.amount::float8 AS amount,
  fb.currency,fb.status,fb.received_at,fb.created_at,fb.updated_at,fb.metadata->>'source_batch_id' AS source_batch_id,
  ca.status AS company_approval_status,ca.required_approvals,ca.requester_name,
  (SELECT COUNT(*)::int FROM revale.employer_funding_decisions cd WHERE cd.funding_batch_id=fb.id AND cd.decision='approve') AS company_approved_count,
  COALESCE(i.employee_count,0)::int AS employee_count,COALESCE(i.item_total,0)::float8 AS item_total,
  COALESCE(i.allocated_amount,0)::float8 AS allocated_amount,
  COALESCE(r.received_amount,0)::float8 AS received_amount,COALESCE(rf.refunded_amount,0)::float8 AS refunded_amount
  FROM revale.funding_batches fb LEFT JOIN revale.benefit_programs bp ON bp.id=fb.program_id
  LEFT JOIN revale.employer_funding_approvals ca ON ca.funding_batch_id=fb.id AND ca.employer_id=fb.employer_id
  LEFT JOIN LATERAL (SELECT COUNT(*) AS employee_count,SUM(amount) AS item_total,SUM(amount) FILTER (WHERE status='allocated') AS allocated_amount
    FROM revale.funding_batch_items WHERE funding_batch_id=fb.id) i ON true
  LEFT JOIN LATERAL (SELECT SUM(amount) AS received_amount FROM revale.employer_funding_receipts WHERE funding_batch_id=fb.id AND status='confirmed') r ON true
  LEFT JOIN LATERAL (SELECT SUM(amount) AS refunded_amount FROM revale.employer_funding_refunds WHERE funding_batch_id=fb.id AND status='confirmed') rf ON true
  WHERE fb.employer_id=$1`;
export function fundingMoney(row) {
  const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const net = round(Number(row.received_amount) - Number(row.refunded_amount));
  const available = round(Math.max(net - Number(row.allocated_amount), 0));
  const pending = round(Math.max(Number(row.item_total) - Number(row.allocated_amount), 0));
  const gap=round(Math.max(pending-available,0));
  const progress=row.status==='cancelled'?'cancelled':row.company_approval_status==='rejected'?'company_rejected':row.company_approval_status==='cancelled'?'company_cancelled':row.company_approval_status==='pending'?'company_pending':Number(row.item_total)===0&&Number(row.amount)>0?'awaiting_preparation':row.status==='allocated'&&pending===0?'credited':gap>0?(net>0?'partial_funding':'awaiting_transfer'):pending>0?(Number(row.allocated_amount)>0?'partial_credit':'awaiting_credit'):'credited';
  return { ...row, cash_net: net, unallocated_cash: available, pending_allocation: pending, funding_gap: gap, progress };
}
export async function funding(sql, employerId, offset = 0) {
  const rows = await sql.query(FUNDING_SELECT + ' ORDER BY fb.created_at DESC,fb.id DESC LIMIT 51 OFFSET $2', [employerId, offset]);
  return { funding: rows.slice(0,50).map(fundingMoney), hasMore: rows.length > 50, nextOffset: offset + Math.min(rows.length, 50) };
}
export async function fundingDetail(sql, employerId, id) {
  const [row] = await sql.query(FUNDING_SELECT + ' AND fb.id=$2', [employerId, id]);
  if (!row) throw problem(404, 'Recarga no encontrada.');
  const [items, receipts, refunds] = await Promise.all([
    sql.query(`SELECT i.id::text,i.enrollment_id::text,i.account_id,i.amount::float8 AS amount,i.status,i.allocated_at,p.first_name,p.last_name
      FROM revale.funding_batch_items i JOIN revale.employee_enrollments ee ON ee.id=i.enrollment_id
      JOIN revale.persons p ON p.id=ee.person_id WHERE i.funding_batch_id=$1 ORDER BY p.first_name,p.last_name`, [id]),
    sql.query(`SELECT id,amount::float8 AS amount,bank_reference,bank_posted_on::text,created_at FROM revale.employer_funding_receipts
      WHERE funding_batch_id=$1 AND employer_id=$2 AND status='confirmed' ORDER BY bank_posted_on`, [id, employerId]),
    sql.query(`SELECT id,amount::float8 AS amount,bank_reference,bank_posted_on::text,reason FROM revale.employer_funding_refunds
      WHERE funding_batch_id=$1 AND employer_id=$2 AND status='confirmed' ORDER BY bank_posted_on`, [id, employerId])
  ]);
  return { batch: fundingMoney(row), items, receipts, refunds };
}
export async function overview(sql, principal) {
  const [companies, people, benefits, cash, activity] = await Promise.all([
    sql.query('SELECT id,name,tax_id,slug,active FROM revale.employers WHERE id=$1', [principal.employerId]),
    employees(sql, principal.employerId), programs(sql, principal.employerId),
    sql.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='pending' AND COALESCE(company_approval_status,'approved') NOT IN('rejected','cancelled')),0)::float8 AS pending_funding,
      COALESCE(SUM(received_amount),0)::float8 AS cash_received,COALESCE(SUM(refunded_amount),0)::float8 AS cash_refunded,
      COALESCE(SUM(allocated_amount),0)::float8 AS allocated_funding,
      COALESCE(SUM(GREATEST(received_amount-refunded_amount-allocated_amount,0)),0)::float8 AS unallocated_cash,
      COUNT(*) FILTER (WHERE status IN ('pending','received') AND COALESCE(company_approval_status,'approved') NOT IN('rejected','cancelled'))::int AS pending_requests
      FROM (${FUNDING_SELECT}) totals`, [principal.employerId]),
    report(sql, principal, {})
  ]);
  const accounts = new Map(people.filter(p=>p.account_id && p.balance!==null).map(p=>[p.account_id, Number(p.balance)]));
  return { employer: companies[0], stats: { active_programs: benefits.filter(p=>p.active).length,
    active_employees: new Set(people.filter(p=>p.funding_ready).map(p=>p.person_id)).size,
    visible_balance: Math.round([...accounts.values()].reduce((a,b)=>a+b,0)*100)/100,
    shared_balances: people.filter(p=>p.balance===null).length,
    pending_activation: new Set(people.filter(p=>p.status==='active'&&p.access_status!=='activated').map(p=>p.person_id)).size,
    activated_employees: new Set(people.filter(p=>p.access_status==='activated').map(p=>p.person_id)).size }, funding: cash[0], summary: activity.summary,
    employees: people, programs: benefits, recent: activity.items.slice(0,5), period: activity.period, principal, capabilities: capabilities(principal), demo: isEmployerDemo(principal), updatedAt: new Date().toISOString() };
}

export async function report(sql, principal, query) {
  const dates = period(query); const offset = Math.min(100000, Math.max(0, Math.floor(Number(query.offset)||0)));
  const args = [principal.employerId, dates.from, dates.to, query.program_id ? String(query.program_id) : null];
  const where = `bp.employer_id=$1 AND t.status IN ('approved','reversed')
    AND t.approved_at>=($2::date::timestamp AT TIME ZONE 'America/Guayaquil')
    AND t.approved_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Guayaquil')
    AND ($4::text IS NULL OR t.program_id=$4)`;
  const [rows, sums] = await Promise.all([
    sql.query(`SELECT t.id,t.amount::float8 AS amount,t.status,t.approved_at,t.reversed_at,t.person_id,t.program_id,
      bp.name AS program_name,p.first_name,p.last_name,m.id AS merchant_id,m.name AS merchant_name,ml.name AS location_name,
      inv.status AS invoice_status,inv.matched_at AS invoice_matched_at
      FROM revale.transactions t JOIN revale.benefit_programs bp ON bp.id=t.program_id
      JOIN revale.persons p ON p.id=t.person_id JOIN revale.merchants m ON m.id=t.merchant_id
      LEFT JOIN revale.merchant_locations ml ON ml.id=t.location_id
      LEFT JOIN LATERAL (SELECT status,matched_at FROM revale.invoices WHERE transaction_id=t.id LIMIT 1) inv ON true
      WHERE ${where} ORDER BY t.approved_at DESC,t.id DESC LIMIT 51 OFFSET $5`, [...args, offset]),
    sql.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE t.status='approved')::int AS purchases,
      COALESCE(SUM(t.amount) FILTER (WHERE t.status='approved'),0)::float8 AS spent,
      COALESCE(SUM(t.amount) FILTER (WHERE t.status='reversed'),0)::float8 AS reversed,
      COUNT(DISTINCT t.person_id) FILTER (WHERE t.status='approved')::int AS participating_employees,
      COUNT(*) FILTER (WHERE t.status='approved' AND NOT EXISTS (SELECT 1 FROM revale.invoices i WHERE i.transaction_id=t.id AND i.status='matched'))::int AS invoices_pending
      FROM revale.transactions t JOIN revale.benefit_programs bp ON bp.id=t.program_id WHERE ${where}`, args)
  ]);
  return { items: rows.slice(0,50).map(r=>merchantPresentation(principal,r)), hasMore: rows.length>50, nextOffset: offset+Math.min(rows.length,50), summary: sums[0], period: dates };
}

// A single SQL statement creates the request, roster, and audit record. It never moves money.
// Deterministic IDs make retries safe; mismatched payloads cannot reuse a request key.
export async function requestFunding(sql, principal, body) {
  const programId=String(body.program_id||''),custom=Array.isArray(body.items);
  const amount=custom?null:moneyValue(body.amount_per_employee),key=String(body.request_id||randomUUID());
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw problem(400,'Referencia de solicitud inválida.');
  const reference=String(body.external_reference||'').trim().slice(0,120);
  const expected=body.expected_employee_count==null?null:Number(body.expected_employee_count);
  if(expected!==null&&(!Number.isInteger(expected)||expected<1))throw problem(400,'Revisa los colaboradores de la recarga.');
  const sourceId=String(body.source_batch_id||'');
  let items=[];
  if(custom){
    if(!body.items.length||body.items.length>500)throw problem(400,'Selecciona entre 1 y 500 colaboradores por recarga.');
    items=body.items.map(item=>({enrollment_id:String(item.enrollment_id||''),account_id:String(item.account_id||''),amount:moneyValue(item.amount)})).sort((a,b)=>a.enrollment_id.localeCompare(b.enrollment_id));
    if(items.some(i=>!/^\d+$/.test(i.enrollment_id)||!i.account_id)||new Set(items.map(i=>i.enrollment_id)).size!==items.length)throw problem(400,'Revisa las cuentas y elimina colaboradores repetidos.');
  }
  const hash=createHash('sha256').update(JSON.stringify(custom?['v2',programId,items,reference,sourceId]:[programId,amount,reference,expected])).digest('hex');
  const id='fund_'+createHash('sha256').update(principal.employerId+':'+key).digest('hex').slice(0,32);
  const existing=await sql.query('SELECT id,amount::float8 AS total,status,metadata FROM revale.funding_batches WHERE id=$1 AND employer_id=$2',[id,principal.employerId]);
  if(existing[0]){if(existing[0].metadata?.request_hash!==hash)throw problem(409,'Esta solicitud ya se usó con otros datos. Prepara una nueva.');return {batch:existing[0],idempotent:true};}
  if(sourceId){const [source]=await sql.query('SELECT id FROM revale.funding_batches WHERE id=$1 AND employer_id=$2 AND program_id=$3',[sourceId,principal.employerId,programId]);if(!source)throw problem(404,'No encontramos esa recarga en este beneficio.');}
  const query=`WITH authority AS (
    SELECT u.id,u.auth_user_id,u.display_name,cp.threshold,cp.version FROM revale.employer_users u
    JOIN revale.employers e ON e.id=u.employer_id JOIN revale.employer_approval_policies cp ON cp.employer_id=e.id
    WHERE u.id=$6 AND u.employer_id=$3 AND u.active AND u.role IN('admin','hr','finance') AND u.auth_user_id IS NOT NULL AND e.active FOR UPDATE OF e
  ), program AS (
    SELECT id,employer_id,currency FROM revale.benefit_programs WHERE id=$2 AND employer_id=$3 AND active=true
      AND EXISTS(SELECT 1 FROM authority)
      AND (valid_from IS NULL OR valid_from<=${TODAY}) AND (valid_until IS NULL OR valid_until>=${TODAY}) FOR SHARE
  ), eligible AS (
    SELECT ee.id AS enrollment_id,a.account_id FROM revale.employee_enrollments ee
    JOIN program bp ON bp.id=ee.program_id JOIN revale.persons p ON p.id=ee.person_id AND p.active=true
    JOIN LATERAL (SELECT MIN(ba.id) AS account_id,COUNT(*) AS n FROM revale.cards c
      JOIN revale.benefit_accounts ba ON ba.card_number=c.card_number WHERE c.person_id=p.id AND c.active=true) a ON a.n=1
    WHERE ee.status='active' AND NOT EXISTS(SELECT 1 FROM revale.employee_enrollments other JOIN revale.benefit_programs ob ON ob.id=other.program_id WHERE other.person_id=p.id AND ob.employer_id<>$3)
      AND ee.starts_on<=${TODAY} AND (ee.ends_on IS NULL OR ee.ends_on>=${TODAY}) FOR SHARE OF ee,p
  ), requested AS (
    SELECT enrollment_id::bigint,account_id,amount FROM jsonb_to_recordset($9::jsonb) AS r(enrollment_id text,account_id text,amount numeric)
  ), selected AS (
    SELECT e.enrollment_id,e.account_id,CASE WHEN $10::boolean THEN r.amount ELSE $5::numeric END AS amount
    FROM eligible e LEFT JOIN requested r ON r.enrollment_id=e.enrollment_id AND r.account_id=e.account_id
    WHERE NOT $10::boolean OR r.enrollment_id IS NOT NULL
  ), roster AS (SELECT COUNT(*)::int AS n,SUM(amount) AS total FROM selected), inserted AS (
    INSERT INTO revale.funding_batches(id,employer_id,program_id,external_reference,amount,currency,status,metadata)
    SELECT $1,bp.employer_id,bp.id,NULLIF($4,''),r.total,bp.currency,'pending',
      jsonb_build_object('amount_per_employee',$5::numeric,'requested_by',$6::text,'request_hash',$7::text,'employee_count',r.n,'source_batch_id',NULLIF($11::text,''),'personalized',$10::boolean,'company_approval_required',true)
    FROM program bp CROSS JOIN roster r WHERE r.n>0 AND ($8::int IS NULL OR r.n=$8)
      AND (NOT $10::boolean OR r.n=(SELECT COUNT(*) FROM requested))
    ON CONFLICT(id) DO NOTHING RETURNING id,amount::float8 AS total,status,metadata
  ), items AS (
    INSERT INTO revale.funding_batch_items(funding_batch_id,enrollment_id,account_id,amount)
    SELECT b.id,e.enrollment_id,e.account_id,e.amount FROM inserted b CROSS JOIN selected e RETURNING id
  ), approval AS (
    INSERT INTO revale.employer_funding_approvals(funding_batch_id,employer_id,program_id,requested_by,requester_auth_id,requester_name,amount,roster_hash,required_approvals,policy_version,threshold)
    SELECT b.id,$3,$2,a.id,a.auth_user_id,a.display_name,b.total,(SELECT ${rosterSignature('s')} FROM selected s),CASE WHEN b.total>a.threshold THEN 2 ELSE 1 END,a.version,a.threshold
    FROM inserted b CROSS JOIN authority a RETURNING funding_batch_id,required_approvals
  ), audited AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    SELECT $3,'employer_user',$6,'funding.requested','funding_batch',b.id,jsonb_build_object('programId',$2::text,'employeeCount',(SELECT COUNT(*) FROM items),'total',b.total,'sourceBatchId',NULLIF($11::text,''))
    FROM inserted b JOIN approval ap ON ap.funding_batch_id=b.id RETURNING id
  ) SELECT b.*,r.n AS employee_count,ap.required_approvals FROM inserted b CROSS JOIN roster r JOIN approval ap ON ap.funding_batch_id=b.id`;
  const [rows]=await sql.transaction([sql.query(query,[id,programId,principal.employerId,reference,amount,principal.employerUserId,hash,expected,JSON.stringify(items),custom,sourceId])],{isolationLevel:'Serializable'});
  if(rows[0])return {batch:rows[0],idempotent:false};
  const [concurrent]=await sql.query('SELECT id,amount::float8 AS total,status,metadata FROM revale.funding_batches WHERE id=$1 AND employer_id=$2',[id,principal.employerId]);
  if(concurrent?.metadata?.request_hash===hash)return {batch:concurrent,idempotent:true};
  throw problem(409,'El programa, las cuentas o los colaboradores cambiaron. Actualiza y vuelve a preparar la recarga.');
}

export async function updateEnrollment(sql, principal, body) {
  const id = String(body.enrollment_id||''), status = String(body.status||''), reason = String(body.reason||'').trim().slice(0,400);
  if (!/^\d+$/.test(id) || !['active','suspended'].includes(status) || reason.length<5) throw problem(400,'Elige un estado e indica el motivo del cambio.');
  const [row] = await sql.query(`WITH target AS (
    SELECT ee.id,ee.status FROM revale.employee_enrollments ee JOIN revale.benefit_programs bp ON bp.id=ee.program_id
    WHERE ee.id=$1::bigint AND bp.employer_id=$2 AND ee.status<>'ended' FOR UPDATE OF ee
    ), updated AS (
      UPDATE revale.employee_enrollments ee SET status=$3,updated_at=now() FROM target t
      WHERE ee.id=t.id AND t.status<>$3 RETURNING ee.id,ee.status,t.status AS previous_status
    ), audited AS (
      INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      SELECT $2,'employer_user',$4,'enrollment.status_changed','employee_enrollment',u.id::text,
        jsonb_build_object('previous_status',u.previous_status,'status',u.status,'reason',$5::text) FROM updated u RETURNING id
    ) SELECT id::text,status FROM updated UNION ALL SELECT id::text,status FROM target WHERE status=$3`, [id,principal.employerId,status,principal.employerUserId,reason]);
  if (!row) throw problem(404,'Colaborador no encontrado o vinculación finalizada.');
  return row;
}

export async function updateProgram(sql, principal, body) {
  const id = String(body.program_id||''), amount = moneyValue(body.allocation_amount);
  const frequency = String(body.allocation_frequency||''), rollover = String(body.rollover_policy||'');
  if (!['monthly','biweekly','weekly','one_time','custom'].includes(frequency) || !['no_rollover','full_rollover','capped_rollover'].includes(rollover)) throw problem(400,'Configuración de beneficio inválida.');
  const [row] = await sql.query(`WITH updated AS (
    UPDATE revale.benefit_programs SET allocation_amount=$1,allocation_frequency=$2,rollover_policy=$3,updated_at=now()
    WHERE id=$4 AND employer_id=$5 RETURNING id,name,allocation_amount::float8 AS allocation_amount,allocation_frequency,rollover_policy
    ), audited AS (
      INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      SELECT $5,'employer_user',$6,'program.updated','benefit_program',id,to_jsonb(updated) FROM updated RETURNING id
    ) SELECT * FROM updated`, [amount,frequency,rollover,id,principal.employerId,principal.employerUserId]);
  if (!row) throw problem(404,'Programa no encontrado.');
  return row;
}

export async function saveRules(sql, principal, body) {
  const id=String(body.program_id||'');
  const max=body.max_transaction_amount==null||body.max_transaction_amount===''?null:moneyValue(body.max_transaction_amount);
  const daily=body.daily_limit==null||body.daily_limit===''?null:moneyValue(body.daily_limit);
  const merchantIds=body.merchant_ids;
  if (!Array.isArray(merchantIds)||merchantIds.length>500||merchantIds.some(x=>typeof x!=='string'||x.length>150)) throw problem(400,'Selección de restaurantes inválida.');
  const ids=[...new Set(merchantIds)].sort();
  const known=await sql.query('SELECT id FROM revale.merchants WHERE active=true AND id=ANY($1::text[])',[ids]);
  if(known.length!==ids.length)throw problem(400,'Uno de los restaurantes ya no está disponible.');
  const rules=[{type:'merchant_allowlist',value:{merchant_ids:ids}},...(max===null?[]:[{type:'max_transaction_amount',value:{amount:max}}]),...(daily===null?[]:[{type:'daily_limit',value:{amount:daily}}])];
  // Lock the program and replace only rules owned by this form. Preserve blocklists and branch rules.
  const [result]=await serialQuery(sql, `WITH program AS (
    SELECT id FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2 FOR UPDATE
    ), deactivated AS (
      UPDATE revale.benefit_rules SET active=false,updated_at=now()
      WHERE program_id IN (SELECT id FROM program) AND active=true
        AND rule_type IN ('max_transaction_amount','daily_limit','merchant_allowlist') RETURNING id
    ), inserted AS (
      INSERT INTO revale.benefit_rules (program_id,rule_type,rule_value,priority,active)
      SELECT p.id,r.type,r.value,100,true FROM program p CROSS JOIN jsonb_to_recordset($3::jsonb) AS r(type text,value jsonb)
      WHERE (SELECT COUNT(*) FROM deactivated)>=0 RETURNING id
    ), audited AS (
      INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      SELECT $2,'employer_user',$4,'benefit_rules.updated','benefit_program',id,$3::jsonb FROM program RETURNING id
    ) SELECT id FROM program`,[id,principal.employerId,JSON.stringify(rules),principal.employerUserId]);
  if(!result)throw problem(404,'Programa no encontrado.');
  return result;
}

// Compatibility for existing callers of the original employer API.
export async function upsertRule(sql, principal, body) {
  const id=String(body.program_id||''),type=String(body.rule_type||'');let value;
  if(['max_transaction_amount','daily_limit'].includes(type))value={amount:moneyValue(body.rule_value?.amount)};
  else if(['merchant_allowlist','merchant_blocklist','location_allowlist'].includes(type)){
    const key=type==='location_allowlist'?'location_ids':'merchant_ids';const ids=body.rule_value?.[key];
    if(!Array.isArray(ids)||ids.length>500||ids.some(x=>typeof x!=='string'||x.length>150))throw problem(400,'Regla inválida.');
    const table=key==='location_ids'?'merchant_locations':'merchants';
    const unique=[...new Set(ids)];const known=await sql.query(`SELECT id FROM revale.${table} WHERE active=true AND id=ANY($1::text[])`,[unique]);
    if(known.length!==unique.length)throw problem(400,'La regla contiene comercios o sucursales no disponibles.');
    value={[key]:unique};
  }else throw problem(400,'Tipo de regla inválido.');
  const [row]=await serialQuery(sql,`WITH program AS (
    SELECT id FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2 FOR UPDATE
    ), deactivated AS (
      UPDATE revale.benefit_rules SET active=false,updated_at=now()
      WHERE program_id IN (SELECT id FROM program) AND rule_type=$3 AND active=true RETURNING id
    ), inserted AS (
      INSERT INTO revale.benefit_rules (program_id,rule_type,rule_value,priority,active)
      SELECT id,$3,$4::jsonb,100,true FROM program WHERE (SELECT COUNT(*) FROM deactivated)>=0
      RETURNING id,program_id,rule_type,rule_value,priority,active
    ), audited AS (
      INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      SELECT $2,'employer_user',$5,'benefit_rule.updated','benefit_rule',id::text,to_jsonb(inserted) FROM inserted RETURNING id
    ) SELECT * FROM inserted`,[id,principal.employerId,type,JSON.stringify(value),principal.employerUserId]);
  if(!row)throw problem(404,'Programa no encontrado.');return row;
}
