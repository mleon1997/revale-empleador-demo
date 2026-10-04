function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}

function safeIdPart(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,120);
}

let taxSchemaReadyPromise=null;

export async function ensureSettlementTaxSchema(sql){
  if(taxSchemaReadyPromise)return taxSchemaReadyPromise;
  taxSchemaReadyPromise=(async()=>{
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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS merchant_fee_invoices_access_key_unique
      ON revale.merchant_fee_invoices(access_key)
      WHERE access_key IS NOT NULL;

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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_document_unique
      ON revale.merchant_withholdings(merchant_id,document_number);

    CREATE UNIQUE INDEX IF NOT EXISTS merchant_withholdings_active_invoice_unique
      ON revale.merchant_withholdings(fee_invoice_id)
      WHERE status IN ('reported','verified');

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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS settlement_adjustments_source_unique
      ON revale.settlement_adjustments(settlement_id,source_type,source_id,adjustment_type);

    CREATE INDEX IF NOT EXISTS settlement_adjustments_settlement_idx
      ON revale.settlement_adjustments(settlement_id,created_at);

    CREATE INDEX IF NOT EXISTS merchant_withholdings_status_idx
      ON revale.merchant_withholdings(status,created_at);
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
  })();
  try{
    await taxSchemaReadyPromise;
  }catch(error){
    taxSchemaReadyPromise=null;
    throw error;
  }
}

export async function ensureFeeInvoiceForSettlement(sql,settlementId){
  await ensureSettlementTaxSchema(sql);
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
     ON CONFLICT (settlement_id) DO UPDATE SET
       subtotal=EXCLUDED.subtotal,
       vat_amount=EXCLUDED.vat_amount,
       total_amount=EXCLUDED.total_amount,
       updated_at=now()
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
  return invoice||null;
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
  return {invoice:invoice||null,withholdings,adjustments};
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
