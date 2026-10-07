import { runtimeBootstrapAllowed } from './revale-security.js';
import {
  ensureSafeguardingSchema,
  safeguardingControl,
  getPrimaryTreasuryAccount
} from "./revale-safeguarding.js";
import { companyApprovalGuard, companyFundingApproved } from './revale-employer-governance.js';

function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}
function safeIdPart(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,120);
}

let fundingTreasurySchemaPromise=null;

async function bootstrapFundingTreasurySchema(sql){
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.employer_funding_receipts (
      id text PRIMARY KEY,
      funding_batch_id text NOT NULL REFERENCES revale.funding_batches(id),
      employer_id text NOT NULL REFERENCES revale.employers(id),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      bank_reference text NOT NULL,
      bank_posted_on date NOT NULL,
      status text NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed','voided')),
      confirmed_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS employer_funding_receipts_ref_unique
      ON revale.employer_funding_receipts(employer_id,bank_reference,bank_posted_on)
      WHERE status='confirmed'
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS employer_funding_receipts_batch_idx
      ON revale.employer_funding_receipts(funding_batch_id,status,created_at)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.employer_funding_refunds (
      id text PRIMARY KEY,
      funding_batch_id text NOT NULL REFERENCES revale.funding_batches(id),
      employer_id text NOT NULL REFERENCES revale.employers(id),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      bank_reference text NOT NULL,
      bank_posted_on date NOT NULL,
      reason text,
      status text NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed','voided')),
      confirmed_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS employer_funding_refunds_ref_unique
      ON revale.employer_funding_refunds(employer_id,bank_reference,bank_posted_on)
      WHERE status='confirmed'
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS employer_funding_refunds_batch_idx
      ON revale.employer_funding_refunds(funding_batch_id,status,created_at)
  `);

  try{
    await sql.query(`
      INSERT INTO revale.gl_accounts (
        id,internal_code,local_account_code,name,account_type,normal_balance,
        ifrs_category,ecuador_reporting_line,active
      ) VALUES (
        'gl_employer_prefund_liability','2.1.01.01','2.1.01.01',
        'Fondos empresariales pendientes de asignar','liability','credit',
        'current_liabilities','Fondos de terceros pendientes de asignación',true
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }catch(error){
    console.warn("ReVale employer prefund GL bootstrap skipped",String(error?.message||error));
  }
}

export async function ensureFundingTreasurySchema(sql){
  if (!runtimeBootstrapAllowed()) return;
  if(!fundingTreasurySchemaPromise)fundingTreasurySchemaPromise=bootstrapFundingTreasurySchema(sql);
  try{
    await fundingTreasurySchemaPromise;
  }catch(error){
    fundingTreasurySchemaPromise=null;
    throw error;
  }
}

export async function fundingBatchMoneySummary(sql,fundingBatchId){
  await ensureFundingTreasurySchema(sql);
  const [row]=await sql.query(
    `SELECT
       fb.id,fb.employer_id,fb.program_id,fb.amount::float8 AS requested_amount,
       fb.currency,fb.status,fb.received_at,
       COALESCE((
         SELECT SUM(r.amount)
         FROM revale.employer_funding_receipts r
         WHERE r.funding_batch_id=fb.id AND r.status='confirmed'
       ),0)::float8 AS received_amount,
       COALESCE((
         SELECT SUM(rf.amount)
         FROM revale.employer_funding_refunds rf
         WHERE rf.funding_batch_id=fb.id AND rf.status='confirmed'
       ),0)::float8 AS refunded_amount,
       COALESCE((
         SELECT SUM(i.amount)
         FROM revale.funding_batch_items i
         WHERE i.funding_batch_id=fb.id AND i.status IN ('pending','allocated')
       ),0)::float8 AS prepared_amount,
       COALESCE((
         SELECT SUM(i.amount)
         FROM revale.funding_batch_items i
         WHERE i.funding_batch_id=fb.id AND i.status='allocated'
       ),0)::float8 AS allocated_amount
     FROM revale.funding_batches fb
     WHERE fb.id=$1
     LIMIT 1`,
    [fundingBatchId]
  );
  if(!row)return null;
  const received=round2(row.received_amount);
  const refunded=round2(row.refunded_amount);
  const allocated=round2(row.allocated_amount);
  const prepared=round2(row.prepared_amount);
  const cashAvailable=round2(received-refunded-allocated);
  const pendingAllocation=round2(prepared-allocated);
  return {
    ...row,
    requested_amount:round2(row.requested_amount),
    received_amount:received,
    refunded_amount:refunded,
    prepared_amount:prepared,
    allocated_amount:allocated,
    cash_available:cashAvailable,
    pending_allocation:pendingAllocation,
    funding_gap:round2(Math.max(pendingAllocation-cashAvailable,0)),
    excess_after_allocation:round2(Math.max(cashAvailable-pendingAllocation,0))
  };
}

export async function registerFundingReceipt(sql,{
  fundingBatchId,amount,currency="USD",bankReference,bankPostedOn,treasuryAccountId=null,actorId=null
}){
  await ensureFundingTreasurySchema(sql);
  await ensureSafeguardingSchema(sql);
  const batch=await fundingBatchMoneySummary(sql,fundingBatchId);
  if(!batch)return {code:"not_found"};
  if(!["pending","received"].includes(batch.status))return {code:"invalid_status",status:batch.status};

  const value=round2(amount);
  const ref=String(bankReference||"").trim().slice(0,160);
  const date=String(bankPostedOn||"").trim();
  const curr=String(currency||batch.currency||"USD").trim().toUpperCase().slice(0,3);
  if(!(value>0))return {code:"invalid_amount"};
  if(!ref)return {code:"reference_required"};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return {code:"date_required"};
  if(curr!==String(batch.currency||"USD").trim().toUpperCase())return {code:"currency_mismatch"};

  let treasuryId=treasuryAccountId?String(treasuryAccountId):null;
  if(!treasuryId){
    const primary=await getPrimaryTreasuryAccount(sql,"client_funds",curr);
    treasuryId=primary?.id||null;
  }
  if(treasuryId){
    const [account]=await sql.query(
      `SELECT id,purpose,currency,active FROM revale.treasury_bank_accounts WHERE id=$1 LIMIT 1`,
      [treasuryId]
    );
    if(!account)return {code:"treasury_account_not_found"};
    if(!account.active||account.purpose!=="client_funds")return {code:"invalid_treasury_account"};
    if(String(account.currency||"").trim()!==curr)return {code:"currency_mismatch"};
  }else{
    return {code:"treasury_account_required"};
  }

  const [existing]=await sql.query(
    `SELECT id,funding_batch_id,employer_id,amount::float8 AS amount,currency,
            bank_reference,bank_posted_on,status,confirmed_by,treasury_account_id,created_at
     FROM revale.employer_funding_receipts
     WHERE employer_id=$1 AND bank_reference=$2 AND bank_posted_on=$3::date AND status='confirmed'
     LIMIT 1`,
    [batch.employer_id,ref,date]
  );
  if(existing){
    if(existing.funding_batch_id!==fundingBatchId || round2(existing.amount)!==value){
      return {code:"duplicate_reference"};
    }
    const summary=await fundingBatchMoneySummary(sql,fundingBatchId);
    const ready=Number(summary.cash_available)+0.00001>=Number(summary.pending_allocation) && Number(summary.pending_allocation)>0;
    if(ready && summary.status==="pending"){
      await sql.query(
        `UPDATE revale.funding_batches
         SET status='received',received_at=COALESCE(received_at,now()),updated_at=now()
         WHERE id=$1 AND status='pending'`,
        [fundingBatchId]
      );
      summary.status="received";
    }
    return {code:"ok",receipt:existing,summary,idempotent:true,ready};
  }

  const id="frc_"+safeIdPart(fundingBatchId)+"_"+Date.now().toString(36);
  const [receipt]=await sql.query(
    `INSERT INTO revale.employer_funding_receipts (
       id,funding_batch_id,employer_id,amount,currency,bank_reference,bank_posted_on,
       status,confirmed_by,treasury_account_id,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::date,'confirmed',$8,$9,
       jsonb_build_object('source','finance_backoffice')
     )
     RETURNING id,funding_batch_id,employer_id,amount::float8 AS amount,currency,
       bank_reference,bank_posted_on,status,confirmed_by,treasury_account_id,created_at`,
    [id,fundingBatchId,batch.employer_id,value,curr,ref,date,actorId,treasuryId]
  );

  const summary=await fundingBatchMoneySummary(sql,fundingBatchId);
  const ready=Number(summary.cash_available)+0.00001>=Number(summary.pending_allocation) && Number(summary.pending_allocation)>0;
  if(ready){
    await sql.query(
      `UPDATE revale.funding_batches
       SET status='received',received_at=COALESCE(received_at,now()),
           metadata=metadata||jsonb_build_object(
             'last_bank_reference',$2::text,
             'received_amount',$3::numeric
           ),
           updated_at=now()
       WHERE id=$1 AND status IN ('pending','received')`,
      [fundingBatchId,ref,summary.received_amount]
    );
  }
  return {code:"ok",receipt,summary:{...summary,status:ready?"received":summary.status},ready};
}

export async function confirmFundingBatchAtomic(sql, fundingBatchId) {
  await ensureFundingTreasurySchema(sql);
  const [batch] = await sql.query(
    `SELECT id,employer_id,program_id,amount::float8 AS amount,currency,status
     FROM revale.funding_batches
     WHERE id=$1
     LIMIT 1`,
    [fundingBatchId]
  );

  if (!batch) return { code:"not_found" };
  if (batch.status === "allocated") {
    return { code:"ok", idempotent:true, batch, summary:await fundingBatchMoneySummary(sql,fundingBatchId) };
  }
  if(!await companyFundingApproved(sql,fundingBatchId))return {code:'company_approval_required'};
  if (batch.status !== "received") return { code:"funds_not_received", status:batch.status };

  const [totals] = await sql.query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS total,COUNT(*)::int AS count
     FROM revale.funding_batch_items
     WHERE funding_batch_id=$1 AND status='pending'`,
    [fundingBatchId]
  );
  if (!totals?.count) return { code:"no_items" };

  const before=await fundingBatchMoneySummary(sql,fundingBatchId);
  if(Number(before.cash_available)+0.00001<Number(totals.total)){
    return {
      code:"insufficient_received_funds",
      required:round2(totals.total),
      available:round2(before.cash_available)
    };
  }

  const rows = await sql.query(
    `WITH batch_guard AS (
       SELECT id,program_id
       FROM revale.funding_batches fb
       WHERE id=$1 AND status='received' AND ${companyApprovalGuard('fb')}
       FOR UPDATE
     ),
     eligible AS (
       SELECT i.id AS item_id,i.enrollment_id,i.account_id,i.amount,b.program_id
       FROM revale.funding_batch_items i
       JOIN batch_guard b ON b.id=i.funding_batch_id
       WHERE i.funding_batch_id=$1 AND i.status='pending'
     ),
     credited AS (
       UPDATE revale.benefit_accounts a
       SET balance=a.balance+e.amount,updated_at=now()
       FROM eligible e
       WHERE a.id=e.account_id
       RETURNING a.id AS account_id,a.balance::float8 AS balance_after
     ),
     rows_to_post AS (
       SELECT e.item_id,e.enrollment_id,e.account_id,e.amount,e.program_id,c.balance_after
       FROM eligible e
       JOIN credited c ON c.account_id=e.account_id
     ),
     allocation_insert AS (
       INSERT INTO revale.benefit_allocations (
         program_id,enrollment_id,account_id,funding_batch_id,amount,effective_at,status,metadata
       )
       SELECT program_id,enrollment_id,account_id,$1,amount,now(),'active',
              jsonb_build_object('source','funding_batch','cash_verified',true)
       FROM rows_to_post
       RETURNING id
     ),
     ledger_insert AS (
       INSERT INTO revale.ledger_entries (
         account_id,transaction_id,entry_type,amount,balance_after,description
       )
       SELECT account_id,NULL,'allocation',amount,balance_after,'Asignación de beneficio fondeada'
       FROM rows_to_post
       RETURNING id
     ),
     items_done AS (
       UPDATE revale.funding_batch_items i
       SET status='allocated',allocated_at=now()
       FROM rows_to_post r
       WHERE i.id=r.item_id
       RETURNING i.id
     ),
     batch_done AS (
       UPDATE revale.funding_batches f
       SET status='allocated',updated_at=now(),
           metadata=metadata||jsonb_build_object('allocated_from_verified_cash',true)
       WHERE f.id=$1 AND EXISTS (SELECT 1 FROM items_done)
       RETURNING f.id,f.employer_id,f.program_id,f.status,f.amount::float8 AS amount,
                 f.currency,f.received_at
     ),
     allocation_total AS (
       SELECT COALESCE(SUM(amount),0)::float8 AS allocated_amount FROM rows_to_post
     )
     SELECT b.*,a.allocated_amount
     FROM batch_done b CROSS JOIN allocation_total a`,
    [fundingBatchId]
  );

  if (!rows.length) return { code:"invalid_status", status:batch.status };
  return {
    code:"ok",
    batch:rows[0],
    allocatedAmount:round2(rows[0].allocated_amount),
    summary:await fundingBatchMoneySummary(sql,fundingBatchId)
  };
}

export async function refundFundingExcess(sql,{
  fundingBatchId,amount,bankReference,bankPostedOn,reason=null,treasuryAccountId=null,actorId=null
}){
  await ensureFundingTreasurySchema(sql);
  await ensureSafeguardingSchema(sql);
  const safeguard=await safeguardingControl(sql);
  if(safeguard.settings.enforcementEnabled && safeguard.status!=="healthy"){
    return {code:"safeguarding_blocked",control:safeguard};
  }
  const summary=await fundingBatchMoneySummary(sql,fundingBatchId);
  if(!summary)return {code:"not_found"};
  if(!["pending","received","allocated"].includes(summary.status))return {code:"invalid_status",status:summary.status};

  const value=round2(amount);
  const ref=String(bankReference||"").trim().slice(0,160);
  const date=String(bankPostedOn||"").trim();
  if(!(value>0))return {code:"invalid_amount"};
  if(!ref)return {code:"reference_required"};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return {code:"date_required"};

  let treasuryId=treasuryAccountId?String(treasuryAccountId):null;
  if(!treasuryId){
    const primary=await getPrimaryTreasuryAccount(sql,"client_funds",summary.currency||"USD");
    treasuryId=primary?.id||null;
  }
  if(treasuryId){
    const [account]=await sql.query(
      `SELECT id,purpose,currency,active FROM revale.treasury_bank_accounts WHERE id=$1 LIMIT 1`,
      [treasuryId]
    );
    if(!account)return {code:"treasury_account_not_found"};
    if(!account.active||account.purpose!=="client_funds")return {code:"invalid_treasury_account"};
  }else{
    return {code:"treasury_account_required"};
  }

  const available=round2(summary.cash_available);
  if(value>available+0.00001)return {code:"refund_exceeds_available",available};

  const [existing]=await sql.query(
    `SELECT id,funding_batch_id,employer_id,amount::float8 AS amount,currency,
            bank_reference,bank_posted_on,status,confirmed_by,treasury_account_id,created_at
     FROM revale.employer_funding_refunds
     WHERE employer_id=$1 AND bank_reference=$2 AND bank_posted_on=$3::date AND status='confirmed'
     LIMIT 1`,
    [summary.employer_id,ref,date]
  );
  if(existing){
    if(existing.funding_batch_id!==fundingBatchId || round2(existing.amount)!==value){
      return {code:"duplicate_reference"};
    }
    const current=await fundingBatchMoneySummary(sql,fundingBatchId);
    if(current.status==="received" && Number(current.cash_available)+0.00001<Number(current.pending_allocation)){
      await sql.query(
        `UPDATE revale.funding_batches SET status='pending',updated_at=now()
         WHERE id=$1 AND status='received'`,
        [fundingBatchId]
      );
      current.status="pending";
    }
    return {code:"ok",refund:existing,summary:current,idempotent:true};
  }

  const id="frf_"+safeIdPart(fundingBatchId)+"_"+Date.now().toString(36);
  const [row]=await sql.query(
    `INSERT INTO revale.employer_funding_refunds (
       id,funding_batch_id,employer_id,amount,currency,bank_reference,bank_posted_on,
       reason,status,confirmed_by,treasury_account_id,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::date,$8,'confirmed',$9,$10,
       jsonb_build_object('source','finance_backoffice')
     )
     RETURNING id,funding_batch_id,employer_id,amount::float8 AS amount,currency,
       bank_reference,bank_posted_on,reason,status,confirmed_by,treasury_account_id,created_at`,
    [
      id,fundingBatchId,summary.employer_id,value,String(summary.currency||"USD").trim(),
      ref,date,String(reason||"").trim().slice(0,500)||null,actorId,treasuryId
    ]
  );

  const after=await fundingBatchMoneySummary(sql,fundingBatchId);
  if(summary.status==="received" && Number(after.cash_available)+0.00001<Number(after.pending_allocation)){
    await sql.query(
      `UPDATE revale.funding_batches
       SET status='pending',
           metadata=metadata||jsonb_build_object('funding_below_required_after_refund',true),
           updated_at=now()
       WHERE id=$1 AND status='received'`,
      [fundingBatchId]
    );
    after.status="pending";
  }
  return {code:"ok",refund:row,summary:after};
}

export async function treasuryControl(sql){
  await ensureFundingTreasurySchema(sql);
  const rows=await sql.query(
    `SELECT a.id,a.name,a.account_type,a.normal_balance,
            COALESCE(SUM(CASE WHEN j.status='posted' THEN l.debit ELSE 0 END),0)::float8 AS debit,
            COALESCE(SUM(CASE WHEN j.status='posted' THEN l.credit ELSE 0 END),0)::float8 AS credit
     FROM revale.gl_accounts a
     LEFT JOIN revale.gl_journal_lines l ON l.account_id=a.id
     LEFT JOIN revale.gl_journals j ON j.id=l.journal_id
     WHERE a.id IN (
       'gl_cash_client_funds',
       'gl_cash_operating',
       'gl_employer_prefund_liability',
       'gl_employee_benefit_liability',
       'gl_merchant_payable',
       'gl_fee_revenue',
       'gl_vat_payable',
       'gl_tax_withholding_receivable'
     )
     GROUP BY a.id,a.name,a.account_type,a.normal_balance`
  );
  const map={};
  for(const row of rows){
    map[row.id]=round2(row.normal_balance==="debit"
      ? Number(row.debit||0)-Number(row.credit||0)
      : Number(row.credit||0)-Number(row.debit||0));
  }
  const clientCash=round2(map.gl_cash_client_funds||0);
  const operatingCash=round2(map.gl_cash_operating||0);
  const taxReceivable=round2(map.gl_tax_withholding_receivable||0);
  const employerPrefund=round2(map.gl_employer_prefund_liability||0);
  const employeeLiability=round2(map.gl_employee_benefit_liability||0);
  const merchantPayable=round2(map.gl_merchant_payable||0);
  const feeRevenue=round2(map.gl_fee_revenue||0);
  const vatPayable=round2(map.gl_vat_payable||0);
  const thirdParty=round2(employerPrefund+employeeLiability+merchantPayable);
  const controlGap=round2(
    clientCash+operatingCash+taxReceivable-thirdParty-feeRevenue-vatPayable
  );

  const [funding]=await sql.query(
    `SELECT
       COALESCE(SUM(r.amount) FILTER (WHERE r.status='confirmed'),0)::float8 AS receipts,
       COALESCE((
         SELECT SUM(rf.amount)
         FROM revale.employer_funding_refunds rf
         WHERE rf.status='confirmed'
       ),0)::float8 AS refunds
     FROM revale.employer_funding_receipts r`
  );

  return {
    accounts:map,
    clientCash,
    operatingCash,
    taxReceivable,
    employerPrefund,
    employeeLiability,
    merchantPayable,
    thirdPartyObligations:thirdParty,
    feeRevenue,
    vatPayable,
    controlGap,
    isBalanced:Math.abs(controlGap)<=0.01,
    confirmedReceipts:round2(funding?.receipts||0),
    confirmedRefunds:round2(funding?.refunds||0)
  };
}
