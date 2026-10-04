function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}

function safeIdPart(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,120);
}

let taxSchemaReadyPromise=null;

async function bootstrapSettlementTaxSchema(sql){
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.merchant_fee_invoices (
      id text PRIMARY KEY,
      settlement_id text NOT NULL UNIQUE REFERENCES revale.settlements(id),
      merchant_id text NOT NULL REFERENCES revale.merchants(id),
      invoice_number text,
      access_key text,
      subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
      total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      status text NOT NULL DEFAULT 'pending_issue'
        CHECK (status IN ('pending_issue','issued','cancelled')),
      issued_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_invoices_access_key_unique
      ON revale.merchant_fee_invoices(access_key)
      WHERE access_key IS NOT NULL
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.merchant_withholdings (
      id text PRIMARY KEY,
      settlement_id text NOT NULL REFERENCES revale.settlements(id),
      fee_invoice_id text NOT NULL REFERENCES revale.merchant_fee_invoices(id),
      merchant_id text NOT NULL REFERENCES revale.merchants(id),
      document_number text NOT NULL,
      authorization_number text,
      issued_on date NOT NULL,
      income_tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (income_tax_amount >= 0),
      vat_withheld_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_withheld_amount >= 0),
      total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0),
      status text NOT NULL DEFAULT 'reported'
        CHECK (status IN ('reported','verified','rejected')),
      reported_by text,
      verified_by text,
      verified_at timestamptz,
      rejection_reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_document_unique
      ON revale.merchant_withholdings(merchant_id,document_number)
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_active_invoice_unique
      ON revale.merchant_withholdings(fee_invoice_id)
      WHERE status IN ('reported','verified')
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS merchant_withholdings_status_idx
      ON revale.merchant_withholdings(status,created_at)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.settlement_adjustments (
      id text PRIMARY KEY,
      settlement_id text NOT NULL REFERENCES revale.settlements(id),
      merchant_id text NOT NULL REFERENCES revale.merchants(id),
      adjustment_type text NOT NULL,
      source_type text NOT NULL,
      source_id text NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount <> 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS settlement_adjustments_source_unique
      ON revale.settlement_adjustments(settlement_id,source_type,source_id,adjustment_type)
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS settlement_adjustments_settlement_idx
      ON revale.settlement_adjustments(settlement_id,created_at)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.merchant_fee_credit_notes (
      id text PRIMARY KEY,
      fee_invoice_id text NOT NULL REFERENCES revale.merchant_fee_invoices(id),
      settlement_id text NOT NULL REFERENCES revale.settlements(id),
      merchant_id text NOT NULL REFERENCES revale.merchants(id),
      transaction_id text REFERENCES revale.transactions(id),
      credit_note_number text,
      access_key text,
      subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
      total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      reason text,
      status text NOT NULL DEFAULT 'pending_issue'
        CHECK (status IN ('pending_issue','issued','cancelled')),
      withholding_status text NOT NULL DEFAULT 'not_required'
        CHECK (withholding_status IN ('not_required','review_required','resolved')),
      withholding_adjustment_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (withholding_adjustment_amount >= 0),
      withholding_resolution_note text,
      resolved_by text,
      resolved_at timestamptz,
      issued_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_credit_notes_tx_unique
      ON revale.merchant_fee_credit_notes(fee_invoice_id,transaction_id)
      WHERE transaction_id IS NOT NULL
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_credit_notes_access_key_unique
      ON revale.merchant_fee_credit_notes(access_key)
      WHERE access_key IS NOT NULL
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS merchant_fee_credit_notes_status_idx
      ON revale.merchant_fee_credit_notes(merchant_id,status,withholding_status,created_at)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.settlement_reconciliations (
      id text PRIMARY KEY,
      settlement_id text NOT NULL REFERENCES revale.settlements(id),
      payout_id text NOT NULL,
      merchant_id text NOT NULL REFERENCES revale.merchants(id),
      expected_amount numeric(14,2) NOT NULL,
      bank_amount numeric(14,2) NOT NULL,
      difference_amount numeric(14,2) NOT NULL,
      currency char(3) NOT NULL DEFAULT 'USD',
      bank_reference text NOT NULL,
      bank_posted_on date NOT NULL,
      status text NOT NULL CHECK (status IN ('matched','mismatch')),
      reconciled_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(settlement_id,payout_id)
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS settlement_reconciliations_status_idx
      ON revale.settlement_reconciliations(status,created_at)
  `);

  await sql.query(`
    INSERT INTO revale.merchant_fee_invoices (
      id,settlement_id,merchant_id,subtotal,vat_amount,total_amount,currency,status,metadata
    )
    SELECT
      'feeinv_'||regexp_replace(s.id,'[^a-zA-Z0-9_]','','g'),
      s.id,s.merchant_id,s.fee_amount,s.tax_amount,(s.fee_amount+s.tax_amount),s.currency,'pending_issue',
      jsonb_build_object('source','settlement_backfill','period_start',s.period_start,'period_end',s.period_end)
    FROM revale.settlements s
    WHERE NOT EXISTS (
      SELECT 1 FROM revale.merchant_fee_invoices fi WHERE fi.settlement_id=s.id
    )
    ON CONFLICT (settlement_id) DO NOTHING
  `);

  try{
    await sql.query(`
      INSERT INTO revale.gl_accounts (
        id,internal_code,local_account_code,name,account_type,normal_balance,
        ifrs_category,ecuador_reporting_line,active
      ) VALUES (
        'gl_tax_withholding_receivable','1.1.03.01','1.1.03.01',
        'Retenciones tributarias por cobrar','asset','debit',
        'current_assets','Créditos tributarios por retenciones',true
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }catch(error){
    console.warn("ReVale GL tax receivable account bootstrap skipped",String(error?.message||error));
  }
}

export async function ensureSettlementTaxSchema(sql){
  if(!taxSchemaReadyPromise)taxSchemaReadyPromise=bootstrapSettlementTaxSchema(sql);
  try{
    await taxSchemaReadyPromise;
  }catch(error){
    taxSchemaReadyPromise=null;
    throw error;
  }
}

export async function ensureFeeInvoiceForSettlement(sql,settlementId){
  await ensureSettlementTaxSchema(sql);
  const [existing]=await sql.query(
    `SELECT id,settlement_id,merchant_id,invoice_number,access_key,
            subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
            currency,status,issued_at,metadata,created_at,updated_at
     FROM revale.merchant_fee_invoices
     WHERE settlement_id=$1
     LIMIT 1`,
    [settlementId]
  );
  if(existing)return existing;

  const [settlement]=await sql.query(
    `SELECT id,merchant_id,fee_amount::float8 AS fee_amount,tax_amount::float8 AS tax_amount,
            currency,status,period_start,period_end
     FROM revale.settlements
     WHERE id=$1
     LIMIT 1`,
    [settlementId]
  );
  if(!settlement)return null;

  const invoiceId="feeinv_"+safeIdPart(settlement.id);
  const [invoice]=await sql.query(
    `INSERT INTO revale.merchant_fee_invoices (
       id,settlement_id,merchant_id,subtotal,vat_amount,total_amount,currency,status,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'pending_issue',
       jsonb_build_object('source','settlement_close','period_start',$8::text,'period_end',$9::text)
     )
     ON CONFLICT (settlement_id) DO NOTHING
     RETURNING id,settlement_id,merchant_id,invoice_number,access_key,
       subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
       currency,status,issued_at,metadata,created_at,updated_at`,
    [
      invoiceId,settlement.id,settlement.merchant_id,
      round2(settlement.fee_amount),round2(settlement.tax_amount),
      round2(Number(settlement.fee_amount||0)+Number(settlement.tax_amount||0)),
      String(settlement.currency||"USD").trim(),settlement.period_start,settlement.period_end
    ]
  );
  if(invoice)return invoice;
  const [raceWinner]=await sql.query(
    `SELECT id,settlement_id,merchant_id,invoice_number,access_key,
            subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
            currency,status,issued_at,metadata,created_at,updated_at
     FROM revale.merchant_fee_invoices WHERE settlement_id=$1 LIMIT 1`,
    [settlementId]
  );
  return raceWinner||null;
}

export async function getSettlementTaxDocuments(sql,settlementId,merchantId=null){
  await ensureSettlementTaxSchema(sql);
  const params=[settlementId];
  let merchantClause="";
  if(merchantId){
    params.push(merchantId);
    merchantClause=" AND merchant_id=$2";
  }
  const [invoice]=await sql.query(
    `SELECT id,settlement_id,merchant_id,invoice_number,access_key,
            subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
            currency,status,issued_at,metadata,created_at,updated_at
     FROM revale.merchant_fee_invoices
     WHERE settlement_id=$1${merchantClause}
     LIMIT 1`,
    params
  );
  const withholdings=await sql.query(
    `SELECT id,settlement_id,fee_invoice_id,merchant_id,document_number,authorization_number,issued_on,
            income_tax_amount::float8 AS income_tax_amount,
            vat_withheld_amount::float8 AS vat_withheld_amount,
            total_amount::float8 AS total_amount,
            status,reported_by,verified_by,verified_at,rejection_reason,metadata,created_at,updated_at
     FROM revale.merchant_withholdings
     WHERE settlement_id=$1${merchantClause}
     ORDER BY created_at DESC`,
    params
  );
  const adjustments=await sql.query(
    `SELECT id,settlement_id,merchant_id,adjustment_type,source_type,source_id,
            amount::float8 AS amount,currency,reason,metadata,created_by,created_at
     FROM revale.settlement_adjustments
     WHERE settlement_id=$1${merchantClause}
     ORDER BY created_at,id`,
    params
  );
  const creditNotes=await sql.query(
    `SELECT id,fee_invoice_id,settlement_id,merchant_id,transaction_id,credit_note_number,access_key,
            subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
            currency,reason,status,withholding_status,
            withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
            withholding_resolution_note,resolved_by,resolved_at,issued_at,metadata,created_at,updated_at
     FROM revale.merchant_fee_credit_notes
     WHERE settlement_id=$1${merchantClause}
     ORDER BY created_at DESC`,
    params
  );
  return {invoice:invoice||null,withholdings,creditNotes,adjustments};
}

export async function ensureFeeCreditNoteForReversal(sql,{
  settlementId,merchantId,transactionId,feeReversal=0,taxReversal=0,reason="Reverso de consumo"
}){
  await ensureSettlementTaxSchema(sql);
  const invoice=await ensureFeeInvoiceForSettlement(sql,settlementId);
  if(!invoice || invoice.merchant_id!==merchantId)return {code:"invoice_missing"};

  const fee=round2(feeReversal);
  const vat=round2(taxReversal);
  if(fee<=0 && vat<=0)return {code:"no_credit_required"};

  if(invoice.status==="pending_issue"){
    const [alreadyProcessed]=await sql.query(
      `SELECT id
       FROM revale.settlement_items
       WHERE settlement_id=$1 AND transaction_id=$2 AND item_type='reversal'
       LIMIT 1`,
      [settlementId,transactionId]
    );
    if(alreadyProcessed)return {code:"invoice_adjusted_before_issue",invoice,idempotent:true};

    const nextSubtotal=Math.max(0,round2(Number(invoice.subtotal||0)-fee));
    const nextVat=Math.max(0,round2(Number(invoice.vat_amount||0)-vat));
    const nextTotal=round2(nextSubtotal+nextVat);
    const [row]=await sql.query(
      `UPDATE revale.merchant_fee_invoices
       SET subtotal=$2,vat_amount=$3,total_amount=$4,
           status=CASE WHEN $4::numeric=0 THEN 'cancelled' ELSE 'pending_issue' END,
           metadata=metadata||jsonb_build_object(
             'adjusted_before_issue',true,
             'last_reversal_transaction',$5,
             'last_reversal_fee',$6::numeric,
             'last_reversal_vat',$7::numeric
           ),
           updated_at=now()
       WHERE id=$1 AND status='pending_issue'
       RETURNING id,settlement_id,merchant_id,invoice_number,access_key,
         subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
         currency,status,issued_at,metadata,created_at,updated_at`,
      [invoice.id,nextSubtotal,nextVat,nextTotal,transactionId,fee,vat]
    );
    return {code:"invoice_adjusted_before_issue",invoice:row||invoice};
  }

  if(invoice.status!=="issued")return {code:"invoice_not_issued",invoice_status:invoice.status};

  const [existing]=await sql.query(
    `SELECT id,fee_invoice_id,settlement_id,merchant_id,transaction_id,credit_note_number,access_key,
            subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
            currency,reason,status,withholding_status,
            withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
            created_at,updated_at
     FROM revale.merchant_fee_credit_notes
     WHERE fee_invoice_id=$1 AND transaction_id=$2
     LIMIT 1`,
    [invoice.id,transactionId]
  );
  if(existing)return {code:"ok",creditNote:existing,idempotent:true};

  const [credited]=await sql.query(
    `SELECT COALESCE(SUM(subtotal),0)::float8 AS subtotal,
            COALESCE(SUM(vat_amount),0)::float8 AS vat
     FROM revale.merchant_fee_credit_notes
     WHERE fee_invoice_id=$1 AND status<>'cancelled'`,
    [invoice.id]
  );
  const remainingSubtotal=Math.max(0,round2(Number(invoice.subtotal||0)-Number(credited?.subtotal||0)));
  const remainingVat=Math.max(0,round2(Number(invoice.vat_amount||0)-Number(credited?.vat||0)));
  const noteSubtotal=Math.min(fee,remainingSubtotal);
  const noteVat=Math.min(vat,remainingVat);
  const noteTotal=round2(noteSubtotal+noteVat);
  if(noteTotal<=0)return {code:"invoice_fully_credited"};

  const [withholding]=await sql.query(
    `SELECT id,total_amount::float8 AS total_amount
     FROM revale.merchant_withholdings
     WHERE fee_invoice_id=$1 AND status='verified'
     ORDER BY verified_at DESC NULLS LAST,created_at DESC
     LIMIT 1`,
    [invoice.id]
  );
  const id="fcn_"+safeIdPart(settlementId)+"_"+safeIdPart(transactionId);
  const [row]=await sql.query(
    `INSERT INTO revale.merchant_fee_credit_notes (
       id,fee_invoice_id,settlement_id,merchant_id,transaction_id,
       subtotal,vat_amount,total_amount,currency,reason,status,withholding_status,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_issue',$11,
       jsonb_build_object(
         'source','post_close_reversal',
         'original_invoice_number',$12,
         'verified_withholding_id',$13,
         'verified_withholding_total',$14::numeric
       )
     )
     ON CONFLICT (fee_invoice_id,transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING
     RETURNING id,fee_invoice_id,settlement_id,merchant_id,transaction_id,credit_note_number,access_key,
       subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
       currency,reason,status,withholding_status,
       withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
       created_at,updated_at`,
    [
      id,invoice.id,settlementId,merchantId,transactionId,
      noteSubtotal,noteVat,noteTotal,String(invoice.currency||"USD").trim(),String(reason||"").slice(0,300),
      withholding?"review_required":"not_required",
      invoice.invoice_number||null,withholding?.id||null,withholding?.total_amount||0
    ]
  );
  return {code:"ok",creditNote:row};
}

export async function registerIssuedFeeCreditNote(sql,{
  creditNoteId,creditNoteNumber,accessKey=null,issuedAt=null,actorId=null
}){
  await ensureSettlementTaxSchema(sql);
  const id=String(creditNoteId||"");
  const number=String(creditNoteNumber||"").trim().slice(0,80);
  const key=String(accessKey||"").trim().slice(0,160)||null;
  if(!id)return {code:"not_found"};
  if(!number)return {code:"credit_note_number_required"};

  try{
    const [row]=await sql.query(
      `UPDATE revale.merchant_fee_credit_notes
       SET credit_note_number=$2,access_key=$3,status='issued',
           issued_at=COALESCE($4::timestamptz,now()),
           metadata=metadata||jsonb_build_object('registered_by',$5),
           updated_at=now()
       WHERE id=$1 AND status IN ('pending_issue','issued')
       RETURNING id,fee_invoice_id,settlement_id,merchant_id,transaction_id,credit_note_number,access_key,
         subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
         currency,reason,status,withholding_status,
         withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
         issued_at,created_at,updated_at`,
      [id,number,key,issuedAt||null,actorId]
    );
    return row?{code:"ok",creditNote:row}:{code:"invalid_status"};
  }catch(error){
    if(String(error?.message||"").toLowerCase().includes("merchant_fee_credit_notes_access_key_unique")){
      return {code:"duplicate_access_key"};
    }
    throw error;
  }
}

export async function resolveFeeCreditNoteWithholding(sql,{
  creditNoteId,withholdingAdjustmentAmount=0,resolutionNote=null,actorId=null
}){
  await ensureSettlementTaxSchema(sql);
  const id=String(creditNoteId||"");
  const amount=round2(withholdingAdjustmentAmount);
  if(amount<0)return {code:"invalid_amount"};

  const [note]=await sql.query(
    `SELECT cn.*,s.status AS settlement_status,
            COALESCE((
              SELECT SUM(w.total_amount)
              FROM revale.merchant_withholdings w
              WHERE w.fee_invoice_id=cn.fee_invoice_id AND w.status='verified'
            ),0)::float8 AS verified_withholding_total
     FROM revale.merchant_fee_credit_notes cn
     JOIN revale.settlements s ON s.id=cn.settlement_id
     WHERE cn.id=$1
     LIMIT 1`,
    [id]
  );
  if(!note)return {code:"not_found"};
  if(note.status!=="issued")return {code:"credit_note_not_issued"};
  if(note.withholding_status==="not_required")return {code:"ok",creditNote:note,idempotent:true};
  if(note.withholding_status==="resolved")return {code:"ok",creditNote:note,idempotent:true};
  const maximumReversible=Math.min(
    round2(note.verified_withholding_total||0),
    round2(note.total_amount||0)
  );
  if(amount>maximumReversible)return {code:"amount_exceeds_withholding",maximum:maximumReversible};

  const [row]=await sql.query(
    `UPDATE revale.merchant_fee_credit_notes
     SET withholding_status='resolved',
         withholding_adjustment_amount=$2,
         withholding_resolution_note=$3,
         resolved_by=$4,resolved_at=now(),updated_at=now()
     WHERE id=$1 AND withholding_status='review_required'
     RETURNING id,fee_invoice_id,settlement_id,merchant_id,transaction_id,credit_note_number,
       subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
       status,withholding_status,
       withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
       withholding_resolution_note,resolved_by,resolved_at`,
    [id,amount,String(resolutionNote||"").trim().slice(0,500)||null,actorId]
  );
  if(!row)return {code:"invalid_status"};

  if(amount>0 && ["closed","failed"].includes(note.settlement_status)){
    await sql.query(
      `INSERT INTO revale.settlement_adjustments (
         id,settlement_id,merchant_id,adjustment_type,source_type,source_id,
         amount,currency,reason,metadata,created_by
       ) VALUES (
         $1,$2,$3,'tax_withholding_reversal','fee_credit_note',$4,$5,'USD',
         'Ajuste de retención asociado a nota de crédito',
         jsonb_build_object('credit_note_number',$6,'resolution_note',$7),$8
       )
       ON CONFLICT (settlement_id,source_type,source_id,adjustment_type) DO NOTHING`,
      [
        "adj_cn_wht_"+safeIdPart(id),note.settlement_id,note.merchant_id,id,-amount,
        note.credit_note_number||null,String(resolutionNote||"").trim().slice(0,500)||null,actorId
      ]
    );
  }
  return {code:"ok",creditNote:row,withholdingAdjustmentAmount:amount};
}

export async function pendingMerchantFiscalCorrections(sql,merchantId){
  await ensureSettlementTaxSchema(sql);
  const [row]=await sql.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='pending_issue')::int AS pending_credit_notes,
       COUNT(*) FILTER (WHERE status='issued' AND withholding_status='review_required')::int AS pending_withholding_reviews
     FROM revale.merchant_fee_credit_notes
     WHERE merchant_id=$1`,
    [merchantId]
  );
  return {
    pendingCreditNotes:Number(row?.pending_credit_notes||0),
    pendingWithholdingReviews:Number(row?.pending_withholding_reviews||0)
  };
}

export async function reconcileSettlementPayout(sql,{
  settlementId,bankReference,bankPostedOn,bankAmount,actorId=null
}){
  await ensureSettlementTaxSchema(sql);
  const id=String(settlementId||"");
  const reference=String(bankReference||"").trim().slice(0,160);
  const postedOn=String(bankPostedOn||"").trim();
  const amount=round2(bankAmount);
  if(!id)return {code:"not_found"};
  if(!reference)return {code:"reference_required"};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(postedOn))return {code:"date_required"};
  if(!(amount>0))return {code:"invalid_amount"};

  const [target]=await sql.query(
    `SELECT s.id,s.merchant_id,s.status,s.currency,
            p.id::text AS payout_id,p.amount::float8 AS expected_amount,p.payout_reference
     FROM revale.settlements s
     JOIN LATERAL (
       SELECT id,amount,payout_reference
       FROM revale.settlement_payouts
       WHERE settlement_id=s.id AND status='paid'
       ORDER BY attempt_no DESC
       LIMIT 1
     ) p ON true
     WHERE s.id=$1
     LIMIT 1`,
    [id]
  );
  if(!target)return {code:"paid_payout_missing"};
  if(!["paid","reconciled"].includes(target.status))return {code:"invalid_status",status:target.status};

  const expected=round2(target.expected_amount);
  const difference=round2(amount-expected);
  const status=Math.abs(difference)<=0.01?"matched":"mismatch";
  const reconciliationId="rec_"+safeIdPart(id)+"_"+safeIdPart(target.payout_id);

  const [row]=await sql.query(
    `INSERT INTO revale.settlement_reconciliations (
       id,settlement_id,payout_id,merchant_id,expected_amount,bank_amount,difference_amount,
       currency,bank_reference,bank_posted_on,status,reconciled_by,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,
       jsonb_build_object('payout_reference',$13)
     )
     ON CONFLICT (settlement_id,payout_id) DO UPDATE SET
       bank_amount=EXCLUDED.bank_amount,
       difference_amount=EXCLUDED.difference_amount,
       bank_reference=EXCLUDED.bank_reference,
       bank_posted_on=EXCLUDED.bank_posted_on,
       status=EXCLUDED.status,
       reconciled_by=EXCLUDED.reconciled_by,
       updated_at=now()
     RETURNING id,settlement_id,payout_id,merchant_id,
       expected_amount::float8 AS expected_amount,bank_amount::float8 AS bank_amount,
       difference_amount::float8 AS difference_amount,currency,bank_reference,bank_posted_on,
       status,reconciled_by,created_at,updated_at`,
    [
      reconciliationId,id,target.payout_id,target.merchant_id,expected,amount,difference,
      String(target.currency||"USD").trim(),reference,postedOn,status,actorId,target.payout_reference||null
    ]
  );

  if(status==="matched"){
    await sql.query(
      `UPDATE revale.settlements
       SET status='reconciled',
           metadata=metadata||jsonb_build_object('reconciled_at',now(),'reconciliation_id',$2),
           updated_at=now()
       WHERE id=$1 AND status IN ('paid','reconciled')`,
      [id,row.id]
    );
    await sql.query(
      `INSERT INTO revale.settlement_events (settlement_id,event_type,actor_id,payload)
       SELECT $1,'reconciled',$2,jsonb_build_object(
         'reconciliation_id',$3,'bank_reference',$4,'bank_amount',$5::numeric
       )
       WHERE NOT EXISTS (
         SELECT 1 FROM revale.settlement_events
         WHERE settlement_id=$1 AND event_type='reconciled' AND payload->>'reconciliation_id'=$3
       )`,
      [id,actorId,row.id,reference,amount]
    );
  }
  return {code:"ok",reconciliation:row};
}

export async function registerIssuedFeeInvoice(sql,{
  settlementId,invoiceNumber,accessKey=null,issuedAt=null,actorId=null
}){
  await ensureSettlementTaxSchema(sql);
  const invoice=await ensureFeeInvoiceForSettlement(sql,settlementId);
  if(!invoice)return {code:"not_found"};

  const number=String(invoiceNumber||"").trim().slice(0,80);
  const key=String(accessKey||"").trim().slice(0,160)||null;
  if(!number)return {code:"invoice_number_required"};

  try{
    const [row]=await sql.query(
      `UPDATE revale.merchant_fee_invoices
       SET invoice_number=$2,access_key=$3,status='issued',
           issued_at=COALESCE($4::timestamptz,now()),
           metadata=metadata||jsonb_build_object('registered_by',$5),
           updated_at=now()
       WHERE settlement_id=$1 AND status IN ('pending_issue','issued')
       RETURNING id,settlement_id,merchant_id,invoice_number,access_key,
         subtotal::float8 AS subtotal,vat_amount::float8 AS vat_amount,total_amount::float8 AS total_amount,
         currency,status,issued_at,metadata,created_at,updated_at`,
      [settlementId,number,key,issuedAt||null,actorId]
    );
    return row?{code:"ok",invoice:row}:{code:"invalid_status"};
  }catch(error){
    if(String(error?.message||"").toLowerCase().includes("merchant_fee_invoices_access_key_unique")){
      return {code:"duplicate_access_key"};
    }
    throw error;
  }
}

export async function reportMerchantWithholding(sql,{
  settlementId,merchantId,documentNumber,authorizationNumber=null,issuedOn,
  incomeTaxAmount=0,vatWithheldAmount=0,reportedBy=null
}){
  await ensureSettlementTaxSchema(sql);
  const invoice=await ensureFeeInvoiceForSettlement(sql,settlementId);
  if(!invoice || invoice.merchant_id!==merchantId)return {code:"not_found"};
  if(invoice.status!=="issued")return {code:"invoice_not_issued",invoice_status:invoice.status};

  const [settlement]=await sql.query(
    `SELECT id,status FROM revale.settlements WHERE id=$1 AND merchant_id=$2 LIMIT 1`,
    [settlementId,merchantId]
  );
  if(!settlement)return {code:"not_found"};
  if(!["closed","failed"].includes(settlement.status)){
    return {code:"payout_locked",status:settlement.status};
  }

  const doc=String(documentNumber||"").trim().slice(0,80);
  const auth=String(authorizationNumber||"").trim().slice(0,160)||null;
  const date=String(issuedOn||"").trim();
  const income=round2(incomeTaxAmount);
  const vat=round2(vatWithheldAmount);
  const total=round2(income+vat);

  if(!doc)return {code:"document_required"};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return {code:"date_required"};
  if(income<0 || vat<0 || total<=0)return {code:"invalid_amount"};
  if(income>round2(invoice.subtotal))return {code:"income_tax_exceeds_base"};
  if(vat>round2(invoice.vat_amount))return {code:"vat_exceeds_tax"};
  if(total>round2(invoice.total_amount))return {code:"withholding_exceeds_invoice"};

  const id="wht_"+safeIdPart(settlementId)+"_"+Date.now().toString(36);
  try{
    const [row]=await sql.query(
      `INSERT INTO revale.merchant_withholdings (
         id,settlement_id,fee_invoice_id,merchant_id,document_number,authorization_number,issued_on,
         income_tax_amount,vat_withheld_amount,total_amount,status,reported_by,metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,'reported',$11,
         jsonb_build_object('source','merchant_portal')
       )
       RETURNING id,settlement_id,fee_invoice_id,merchant_id,document_number,authorization_number,issued_on,
         income_tax_amount::float8 AS income_tax_amount,vat_withheld_amount::float8 AS vat_withheld_amount,
         total_amount::float8 AS total_amount,status,reported_by,created_at`,
      [id,settlementId,invoice.id,merchantId,doc,auth,date,income,vat,total,reportedBy]
    );
    return {code:"ok",withholding:row};
  }catch(error){
    const message=String(error?.message||"").toLowerCase();
    if(message.includes("merchant_withholdings_active_invoice_unique")){
      return {code:"already_reported"};
    }
    if(message.includes("merchant_withholdings_document_unique")){
      return {code:"duplicate_document"};
    }
    throw error;
  }
}

export async function reviewMerchantWithholding(sql,{
  withholdingId,decision,actorId,rejectionReason=null
}){
  await ensureSettlementTaxSchema(sql);
  const id=String(withholdingId||"");
  if(!id)return {code:"not_found"};

  if(decision==="reject"){
    const [row]=await sql.query(
      `UPDATE revale.merchant_withholdings
       SET status='rejected',verified_by=$2,verified_at=now(),rejection_reason=$3,updated_at=now()
       WHERE id=$1 AND status='reported'
       RETURNING id,settlement_id,merchant_id,total_amount::float8 AS total_amount,status`,
      [id,actorId,String(rejectionReason||"").trim().slice(0,500)||null]
    );
    return row?{code:"ok",withholding:row}:{code:"invalid_status"};
  }

  if(decision!=="verify")return {code:"invalid_decision"};

  const [row]=await sql.query(
    `WITH verified AS (
       UPDATE revale.merchant_withholdings
       SET status='verified',verified_by=$2,verified_at=now(),rejection_reason=NULL,updated_at=now()
       WHERE id=$1 AND status='reported'
       RETURNING *
     ),
     adjustment AS (
       INSERT INTO revale.settlement_adjustments (
         id,settlement_id,merchant_id,adjustment_type,source_type,source_id,
         amount,currency,reason,metadata,created_by
       )
       SELECT
         'adj_wht_'||regexp_replace(v.id,'[^a-zA-Z0-9_]','','g'),
         v.settlement_id,v.merchant_id,'tax_withholding_credit','merchant_withholding',v.id,
         v.total_amount,'USD','Retención tributaria verificada sobre factura ReVale',
         jsonb_build_object(
           'document_number',v.document_number,
           'income_tax_amount',v.income_tax_amount,
           'vat_withheld_amount',v.vat_withheld_amount
         ),$2
       FROM verified v
       ON CONFLICT (settlement_id,source_type,source_id,adjustment_type) DO NOTHING
       RETURNING id
     )
     SELECT id,settlement_id,merchant_id,document_number,
            income_tax_amount::float8 AS income_tax_amount,
            vat_withheld_amount::float8 AS vat_withheld_amount,
            total_amount::float8 AS total_amount,status,verified_by,verified_at
     FROM verified`,
    [id,actorId]
  );

  if(row)return {code:"ok",withholding:row};

  const [existing]=await sql.query(
    `SELECT id,settlement_id,merchant_id,total_amount::float8 AS total_amount,status,verified_by,verified_at
     FROM revale.merchant_withholdings WHERE id=$1 LIMIT 1`,
    [id]
  );
  if(existing?.status==="verified")return {code:"ok",withholding:existing,idempotent:true};
  return {code:existing?"invalid_status":"not_found"};
}

export async function settlementPayoutAdjustmentSummary(sql,settlementId){
  await ensureSettlementTaxSchema(sql);
  const [row]=await sql.query(
    `SELECT
       COALESCE(SUM(amount),0)::float8 AS adjustment_total,
       COUNT(*)::int AS adjustment_count
     FROM revale.settlement_adjustments
     WHERE settlement_id=$1`,
    [settlementId]
  );
  return {
    adjustmentTotal:round2(row?.adjustment_total||0),
    adjustmentCount:Number(row?.adjustment_count||0)
  };
}

export async function pendingWithholdingCount(sql,settlementId){
  await ensureSettlementTaxSchema(sql);
  const [row]=await sql.query(
    `SELECT COUNT(*)::int AS pending
     FROM revale.merchant_withholdings
     WHERE settlement_id=$1 AND status='reported'`,
    [settlementId]
  );
  return Number(row?.pending||0);
}
