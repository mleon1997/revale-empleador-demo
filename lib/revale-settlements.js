import {
  ensureSettlementTaxSchema,
  ensureFeeInvoiceForSettlement,
  settlementPayoutAdjustmentSummary,
  pendingWithholdingCount,
  pendingMerchantFiscalCorrections
} from "./revale-settlement-tax.js";

function settlementId(merchantId, periodStart) {
  const day = new Date(periodStart).toISOString().slice(0,10).replace(/-/g,"");
  return "stl_" + String(merchantId).replace(/[^a-z0-9_]/gi,"_") + "_" + day;
}

export async function lastCompletedWeeklyPeriod(sql) {
  const [row] = await sql.query(
    `SELECT
       ((date_trunc('week', now() AT TIME ZONE 'America/Guayaquil') - interval '7 days')
         AT TIME ZONE 'America/Guayaquil') AS period_start,
       (date_trunc('week', now() AT TIME ZONE 'America/Guayaquil')
         AT TIME ZONE 'America/Guayaquil') AS period_end`
  );
  return row;
}

export async function closeLastCompletedWeeklySettlement(sql, merchantId, actorId="system") {
  await ensureSettlementTaxSchema(sql);
  const period = await lastCompletedWeeklyPeriod(sql);
  if (!period?.period_start || !period?.period_end) return { code:"period_error" };

  const [existing] = await sql.query(
    `SELECT id,status,gross_amount::float8 AS gross_amount,
            adjustment_amount::float8 AS adjustment_amount,
            fee_amount::float8 AS fee_amount,tax_amount::float8 AS tax_amount,
            net_amount::float8 AS net_amount,period_start,period_end,bank_account_id
     FROM revale.settlements
     WHERE merchant_id=$1 AND period_start=$2 AND period_end=$3
     LIMIT 1`,
    [merchantId,period.period_start,period.period_end]
  );
  if (existing) {
    await ensureFeeInvoiceForSettlement(sql,existing.id);
    return { code:"ok", idempotent:true, settlement:existing };
  }

  const [terms] = await sql.query(
    `SELECT id,discount_rate::float8 AS discount_rate,tax_rate::float8 AS tax_rate,
            settlement_frequency,settlement_weekday
     FROM revale.merchant_terms
     WHERE merchant_id=$1
       AND active=true
       AND effective_from <= (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date - 1)
       AND (effective_until IS NULL OR effective_until >= (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date - 1))
     ORDER BY effective_from DESC,id DESC
     LIMIT 1`,
    [merchantId,period.period_end]
  );
  if (!terms) return { code:"terms_missing" };
  if (terms.settlement_frequency !== "weekly") return { code:"unsupported_frequency", frequency:terms.settlement_frequency };

  const id = settlementId(merchantId,period.period_start);
  const rows = await sql.query(
    `WITH bank AS (
       SELECT id
       FROM revale.merchant_bank_accounts
       WHERE merchant_id=$1 AND status='verified'
       ORDER BY verified_at DESC NULLS LAST,id DESC
       LIMIT 1
     ),
     consumptions AS (
       SELECT t.id,t.location_id,t.amount
       FROM revale.transactions t
       WHERE t.merchant_id=$1
         AND t.approved_at >= $2
         AND t.approved_at < $3
         AND t.status IN ('approved','reversed')
         AND NOT EXISTS (
           SELECT 1 FROM revale.settlement_items si
           WHERE si.transaction_id=t.id AND si.item_type='consumption'
         )
     ),
     reversals AS (
       SELECT t.id,t.location_id,t.amount
       FROM revale.transactions t
       WHERE t.merchant_id=$1
         AND t.reversed_at >= $2
         AND t.reversed_at < $3
         AND t.status='reversed'
         AND NOT EXISTS (
           SELECT 1 FROM revale.settlement_items si
           WHERE si.transaction_id=t.id AND si.item_type='reversal'
         )
     ),
     summary AS (
       SELECT
         COALESCE((SELECT SUM(amount) FROM consumptions),0)::numeric AS gross,
         COALESCE((SELECT SUM(amount) FROM reversals),0)::numeric AS adjustments
     ),
     inserted AS (
       INSERT INTO revale.settlements (
         id,merchant_id,period_start,period_end,
         gross_amount,adjustment_amount,fee_amount,tax_amount,net_amount,
         currency,status,bank_account_id,closed_at,metadata
       )
       SELECT
         $4,$1,$2,$3,
         s.gross,
         s.adjustments,
         ROUND(GREATEST(s.gross-s.adjustments,0) * $5::numeric,2),
         ROUND(ROUND(GREATEST(s.gross-s.adjustments,0) * $5::numeric,2) * $6::numeric,2),
         ROUND(
           (s.gross-s.adjustments)
           - ROUND(GREATEST(s.gross-s.adjustments,0) * $5::numeric,2)
           - ROUND(ROUND(GREATEST(s.gross-s.adjustments,0) * $5::numeric,2) * $6::numeric,2)
         ,2),
         'USD','closed',(SELECT id FROM bank),now(),
         jsonb_build_object(
           'timezone','America/Guayaquil',
           'discount_rate',$5::numeric,
           'tax_rate',$6::numeric,
           'merchant_terms_id',$7::bigint
         )
       FROM summary s
       WHERE s.gross<>0 OR s.adjustments<>0
       ON CONFLICT (merchant_id,period_start,period_end) DO NOTHING
       RETURNING *
     ),
     consumption_items AS (
       INSERT INTO revale.settlement_items (settlement_id,transaction_id,item_type,amount,metadata)
       SELECT i.id,c.id,'consumption',c.amount,jsonb_build_object('location_id',c.location_id)
       FROM inserted i CROSS JOIN consumptions c
       ON CONFLICT (transaction_id,item_type) WHERE transaction_id IS NOT NULL DO NOTHING
       RETURNING id
     ),
     reversal_items AS (
       INSERT INTO revale.settlement_items (settlement_id,transaction_id,item_type,amount,metadata)
       SELECT i.id,r.id,'reversal',-r.amount,jsonb_build_object('location_id',r.location_id)
       FROM inserted i CROSS JOIN reversals r
       ON CONFLICT (transaction_id,item_type) WHERE transaction_id IS NOT NULL DO NOTHING
       RETURNING id
     ),
     fee_item AS (
       INSERT INTO revale.settlement_items (settlement_id,transaction_id,item_type,amount,metadata)
       SELECT id,NULL,'fee',-fee_amount,jsonb_build_object('rate',$5::numeric)
       FROM inserted WHERE fee_amount<>0
       RETURNING id
     ),
     tax_item AS (
       INSERT INTO revale.settlement_items (settlement_id,transaction_id,item_type,amount,metadata)
       SELECT id,NULL,'tax',-tax_amount,jsonb_build_object('rate',$6::numeric)
       FROM inserted WHERE tax_amount<>0
       RETURNING id
     ),
     event AS (
       INSERT INTO revale.settlement_events (settlement_id,event_type,actor_id,payload)
       SELECT id,'closed',$8,jsonb_build_object('source','weekly_close')
       FROM inserted
       RETURNING id
     )
     SELECT id,status,gross_amount::float8 AS gross_amount,
            adjustment_amount::float8 AS adjustment_amount,
            fee_amount::float8 AS fee_amount,tax_amount::float8 AS tax_amount,
            net_amount::float8 AS net_amount,period_start,period_end,bank_account_id
     FROM inserted`,
    [
      merchantId,
      period.period_start,
      period.period_end,
      id,
      terms.discount_rate,
      terms.tax_rate,
      terms.id,
      actorId
    ]
  );

  if (!rows.length) return { code:"no_activity", period };
  await ensureFeeInvoiceForSettlement(sql,rows[0].id);
  return { code:"ok", settlement:rows[0] };
}

export async function scheduleSettlementPayout(sql, settlementId, actorId="system") {
  await ensureSettlementTaxSchema(sql);
  const [settlement] = await sql.query(
    `SELECT s.id,s.merchant_id,s.status,s.net_amount::float8 AS net_amount,
            s.fee_amount::float8 AS fee_amount,s.tax_amount::float8 AS tax_amount,s.currency,
            mba.id AS bank_account_id
     FROM revale.settlements s
     LEFT JOIN revale.merchant_bank_accounts mba
       ON mba.merchant_id=s.merchant_id AND mba.status='verified'
     WHERE s.id=$1
     ORDER BY mba.verified_at DESC NULLS LAST,mba.id DESC
     LIMIT 1`,
    [settlementId]
  );
  if (!settlement) return { code:"not_found" };
  if (settlement.status === "paid") return { code:"already_paid" };
  if (!["closed","failed"].includes(settlement.status)) return { code:"invalid_status",status:settlement.status };
  if (Number(settlement.fee_amount||0)+Number(settlement.tax_amount||0)>0) {
    const [feeInvoice]=await sql.query(
      `SELECT status FROM revale.merchant_fee_invoices WHERE settlement_id=$1 LIMIT 1`,
      [settlementId]
    );
    if(!feeInvoice || feeInvoice.status!=="issued") return { code:"fee_invoice_pending" };
  }
  const pendingWithholdings=await pendingWithholdingCount(sql,settlementId);
  if (pendingWithholdings>0) return { code:"withholding_pending",pending:pendingWithholdings };
  const fiscalCorrections=await pendingMerchantFiscalCorrections(sql,settlement.merchant_id);
  if(fiscalCorrections.pendingCreditNotes>0){
    return {code:"credit_note_pending",pending:fiscalCorrections.pendingCreditNotes};
  }
  if(fiscalCorrections.pendingWithholdingReviews>0){
    return {code:"credit_note_withholding_review_pending",pending:fiscalCorrections.pendingWithholdingReviews};
  }
  const payoutAdjustments=await settlementPayoutAdjustmentSummary(sql,settlementId);
  const calculatedPayout=Math.round((Number(settlement.net_amount||0)+Number(payoutAdjustments.adjustmentTotal||0)+Number.EPSILON)*100)/100;
  if (!(calculatedPayout>0)) return { code:"non_positive_net",net_amount:settlement.net_amount,adjustments:payoutAdjustments.adjustmentTotal };

  const [ledgerPayable]=await sql.query(
    `SELECT
       COUNT(*)::int AS line_count,
       COALESCE(SUM(l.credit-l.debit),0)::float8 AS balance
     FROM revale.gl_journal_lines l
     JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
     WHERE l.account_id='gl_merchant_payable' AND l.merchant_id=$1`,
    [settlement.merchant_id]
  );
  const ledgerBalance=Math.round((Number(ledgerPayable?.balance||0)+Number.EPSILON)*100)/100;
  const hasLedger=Number(ledgerPayable?.line_count||0)>0;
  const payoutAmount=hasLedger
    ? Math.max(0,Math.min(calculatedPayout,ledgerBalance))
    : calculatedPayout;
  const ledgerOffset=Math.round((calculatedPayout-payoutAmount+Number.EPSILON)*100)/100;
  if (!(payoutAmount>0)) {
    return {
      code:"merchant_balance_offset",
      calculated_payout:calculatedPayout,
      ledger_payable:ledgerBalance,
      offset:ledgerOffset
    };
  }
  if (!settlement.bank_account_id) return { code:"bank_missing" };

  const [attempt] = await sql.query(
    `WITH next_attempt AS (
       SELECT COALESCE(MAX(attempt_no),0)+1 AS n
       FROM revale.settlement_payouts
       WHERE settlement_id=$1
     ),
     payout AS (
       INSERT INTO revale.settlement_payouts (
         settlement_id,attempt_no,bank_account_id,amount,currency,status,scheduled_at,metadata
       )
       SELECT $1,n,$2,$3,$4,'scheduled',now(),
              jsonb_build_object(
                'scheduled_by',$5,
                'calculated_payout',$6::numeric,
                'ledger_payable',$7::numeric,
                'ledger_offset',$8::numeric
              )
       FROM next_attempt
       RETURNING *
     ),
     settlement_update AS (
       UPDATE revale.settlements
       SET status='scheduled',bank_account_id=$2,scheduled_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('closed','failed')
       RETURNING id
     ),
     event AS (
       INSERT INTO revale.settlement_events (settlement_id,event_type,actor_id,payload)
       SELECT $1,'payout_scheduled',$5,jsonb_build_object('payout_id',p.id,'attempt_no',p.attempt_no)
       FROM payout p
       RETURNING id
     )
     SELECT id,settlement_id,attempt_no,status,amount::float8 AS amount,scheduled_at
     FROM payout`,
    [
      settlementId,settlement.bank_account_id,payoutAmount,String(settlement.currency||"USD").trim(),actorId,
      calculatedPayout,ledgerBalance,ledgerOffset
    ]
  );
  return attempt ? { code:"ok", payout:attempt } : { code:"invalid_status" };
}

export async function markSettlementPaid(sql, settlementId, payoutReference, actorId="system") {
  const reference=String(payoutReference||"").trim();
  if (!reference) return { code:"reference_required" };

  const [row] = await sql.query(
    `WITH payout AS (
       UPDATE revale.settlement_payouts p
       SET status='paid',payout_reference=$2,completed_at=now(),updated_at=now()
       WHERE p.id=(
         SELECT id FROM revale.settlement_payouts
         WHERE settlement_id=$1 AND status IN ('scheduled','processing')
         ORDER BY attempt_no DESC LIMIT 1
       )
       RETURNING p.id,p.attempt_no,p.payout_reference
     ),
     settlement_update AS (
       UPDATE revale.settlements
       SET status='paid',payout_reference=$2,paid_at=now(),updated_at=now()
       WHERE id=$1 AND EXISTS (SELECT 1 FROM payout)
       RETURNING id,status,paid_at,payout_reference
     ),
     event AS (
       INSERT INTO revale.settlement_events (settlement_id,event_type,actor_id,payload)
       SELECT $1,'paid',$3,jsonb_build_object('payout_id',p.id,'reference',$2)
       FROM payout p
       RETURNING id
     )
     SELECT su.*,p.amount::float8 AS payout_amount,p.currency AS payout_currency,p.id AS payout_id,p.attempt_no
     FROM settlement_update su CROSS JOIN payout p`,
    [settlementId,reference,actorId]
  );
  return row ? { code:"ok", settlement:row } : { code:"invalid_status" };
}

export async function markSettlementFailed(sql, settlementId, reason, actorId="system") {
  const failure=String(reason||"").trim().slice(0,500);
  const [row] = await sql.query(
    `WITH payout AS (
       UPDATE revale.settlement_payouts p
       SET status='failed',failure_reason=$2,completed_at=now(),updated_at=now()
       WHERE p.id=(
         SELECT id FROM revale.settlement_payouts
         WHERE settlement_id=$1 AND status IN ('scheduled','processing')
         ORDER BY attempt_no DESC LIMIT 1
       )
       RETURNING p.id,p.attempt_no
     ),
     settlement_update AS (
       UPDATE revale.settlements
       SET status='failed',updated_at=now(),metadata=metadata||jsonb_build_object('last_failure_reason',$2)
       WHERE id=$1 AND EXISTS (SELECT 1 FROM payout)
       RETURNING id,status
     ),
     event AS (
       INSERT INTO revale.settlement_events (settlement_id,event_type,actor_id,payload)
       SELECT $1,'payout_failed',$3,jsonb_build_object('payout_id',p.id,'reason',$2)
       FROM payout p
       RETURNING id
     )
     SELECT * FROM settlement_update`,
    [settlementId,failure||null,actorId]
  );
  return row ? { code:"ok", settlement:row } : { code:"invalid_status" };
}
