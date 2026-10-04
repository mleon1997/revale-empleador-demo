import { getSql } from "../lib/revale-db.js";
import { getAdminPrincipal, roleAllowed } from "../lib/revale-auth.js";
import { confirmFundingBatchAtomic } from "../lib/revale-admin-funding.js";
import {
  closeLastCompletedWeeklySettlement,
  scheduleSettlementPayout,
  markSettlementPaid,
  markSettlementFailed
} from "../lib/revale-settlements.js";
import {
  emitAndPostAccountingEvent,
  processPendingAccountingEvents
} from "../lib/revale-accounting.js";
import {
  ensureSettlementTaxSchema,
  reviewMerchantWithholding,
  registerIssuedFeeInvoice,
  registerIssuedFeeCreditNote,
  resolveFeeCreditNoteWithholding,
  reconcileSettlementPayout
} from "../lib/revale-settlement-tax.js";

function json(res,code,body){
  res.status(code).setHeader("Content-Type","application/json; charset=utf-8").setHeader("Cache-Control","no-store").json(body);
}
function slugify(value){
  return String(value||"sucursal").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,70)||"sucursal";
}
function safeLocationId(merchantId,name){
  return "location_"+String(merchantId).replace(/^merchant_/,"").replace(/[^a-z0-9_]+/gi,"_")+"_"+slugify(name).replace(/-/g,"_")+"_"+Date.now().toString(36);
}

export default async function handler(req,res){
  const action=String(req.query?.action||"");
  try{
    const sql=await getSql();
    await ensureSettlementTaxSchema(sql);
    const principal=await getAdminPrincipal(sql,req);
    if(!principal)return json(res,401,{ok:false,error:"Sesión requerida"});

    const requireRoles=(roles)=>{
      if(!roleAllowed(principal,roles)){json(res,403,{ok:false,error:"No tienes permisos para esta acción"});return false}
      return true;
    };

    if(req.method==="GET" && action==="overview"){
      const [counts]=await sql.query(
        `SELECT
          (SELECT COUNT(*)::int FROM revale.merchants WHERE active=true) AS merchants,
          (SELECT COUNT(*)::int FROM revale.employers WHERE active=true) AS employers,
          (SELECT COUNT(*)::int FROM revale.transactions WHERE status='approved') AS approved_transactions,
          (SELECT COUNT(*)::int FROM revale.funding_batches WHERE status='pending') AS pending_funding,
          (SELECT COUNT(*)::int FROM revale.merchant_location_requests WHERE status='pending') AS pending_branches,
          (SELECT COUNT(*)::int FROM revale.merchant_bank_account_requests WHERE status='pending') AS pending_banks,
          (SELECT COUNT(*)::int FROM revale.merchant_withholdings WHERE status='reported') AS pending_withholdings,
          (SELECT COUNT(*)::int FROM revale.merchant_fee_credit_notes WHERE status='pending_issue') AS pending_credit_notes,
          (SELECT COUNT(*)::int FROM revale.merchant_fee_credit_notes WHERE status='issued' AND withholding_status='review_required') AS pending_credit_note_tax_reviews,
          (SELECT COUNT(*)::int FROM revale.settlements WHERE status IN ('closed','failed')) AS settlement_action_required,
          (SELECT COUNT(*)::int FROM revale.settlements WHERE status='scheduled') AS payouts_scheduled,
          (SELECT COUNT(*)::int FROM revale.settlements WHERE status='paid') AS pending_reconciliations,
          (SELECT COUNT(*)::int FROM revale.settlement_reconciliations WHERE status='mismatch') AS reconciliation_mismatches`
      );
      const [money]=await sql.query(
        `SELECT
          COALESCE(SUM(amount),0)::float8 AS approved_volume
         FROM revale.transactions
         WHERE status IN ('approved','reversed')`
      );
      const recent=await sql.query(
        `SELECT id,actor_type,actor_id,action,resource_type,resource_id,merchant_id,employer_id,metadata,created_at
         FROM revale.audit_events
         ORDER BY created_at DESC
         LIMIT 12`
      );
      return json(res,200,{ok:true,counts:counts||{},money:money||{},recent});
    }

    if(req.method==="GET" && action==="settlements"){
      const rows=await sql.query(
        `SELECT
           s.id,s.merchant_id,m.name AS merchant_name,
           s.period_start,s.period_end,
           s.gross_amount::float8 AS gross_amount,
           s.adjustment_amount::float8 AS adjustment_amount,
           s.fee_amount::float8 AS fee_amount,
           s.tax_amount::float8 AS tax_amount,
           s.net_amount::float8 AS net_amount,
           COALESCE(sa.adjustment_total,0)::float8 AS payout_adjustment_amount,
           (s.net_amount+COALESCE(sa.adjustment_total,0))::float8 AS transfer_amount,
           COALESCE(wh.pending_count,0)::int AS pending_withholdings,
           COALESCE(wh.verified_total,0)::float8 AS verified_withholding_amount,
           fi.id AS fee_invoice_id,fi.invoice_number,fi.status AS fee_invoice_status,
           fi.total_amount::float8 AS fee_invoice_total,
           COALESCE(cn.pending_count,0)::int AS merchant_pending_credit_notes,
           COALESCE(cn.review_count,0)::int AS merchant_pending_credit_note_tax_reviews,
           rec.status AS reconciliation_status,rec.bank_reference AS reconciliation_reference,
           rec.bank_posted_on,rec.bank_amount::float8 AS reconciliation_bank_amount,
           rec.difference_amount::float8 AS reconciliation_difference_amount,
           s.currency,s.status,s.closed_at,s.scheduled_at,s.paid_at,s.payout_reference,
           mba.bank_name,mba.account_type,
           CASE WHEN mba.account_number IS NULL THEN NULL ELSE '•••• '||right(mba.account_number,4) END AS account_number_masked,
           lp.id AS payout_id,lp.attempt_no,lp.status AS payout_status,lp.failure_reason,
           lp.amount::float8 AS payout_amount
         FROM revale.settlements s
         JOIN revale.merchants m ON m.id=s.merchant_id
         LEFT JOIN revale.merchant_bank_accounts mba ON mba.id=s.bank_account_id
         LEFT JOIN revale.merchant_fee_invoices fi ON fi.settlement_id=s.id
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE status='pending_issue') AS pending_count,
             COUNT(*) FILTER (WHERE status='issued' AND withholding_status='review_required') AS review_count
           FROM revale.merchant_fee_credit_notes
           WHERE merchant_id=s.merchant_id
         ) cn ON true
         LEFT JOIN LATERAL (
           SELECT status,bank_reference,bank_posted_on,bank_amount,difference_amount
           FROM revale.settlement_reconciliations
           WHERE settlement_id=s.id
           ORDER BY updated_at DESC
           LIMIT 1
         ) rec ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(amount),0) AS adjustment_total
           FROM revale.settlement_adjustments
           WHERE settlement_id=s.id
         ) sa ON true
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE status='reported') AS pending_count,
             COALESCE(SUM(total_amount) FILTER (WHERE status='verified'),0) AS verified_total
           FROM revale.merchant_withholdings
           WHERE settlement_id=s.id
         ) wh ON true
         LEFT JOIN LATERAL (
           SELECT id,attempt_no,status,failure_reason,amount
           FROM revale.settlement_payouts
           WHERE settlement_id=s.id
           ORDER BY attempt_no DESC
           LIMIT 1
         ) lp ON true
         ORDER BY s.period_end DESC,m.name
         LIMIT 200`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="POST" && action==="close-settlements"){
      if(!requireRoles(["superadmin","finance"]))return;
      const merchants=await sql.query("SELECT id,name FROM revale.merchants WHERE active=true ORDER BY name");
      const results=[];
      for(const merchant of merchants){
        const result=await closeLastCompletedWeeklySettlement(sql,merchant.id,principal.adminUserId);
        results.push({merchant_id:merchant.id,merchant_name:merchant.name,...result});
        if(result.code==="ok"){
          await emitAndPostAccountingEvent(sql,{
            eventType:"settlement_closed",
            sourceType:"settlement",
            sourceId:result.settlement.id,
            eventKey:"closed",
            amount:Number(result.settlement.fee_amount||0)+Number(result.settlement.tax_amount||0),
            merchantId:merchant.id,
            settlementId:result.settlement.id,
            payload:{
              gross_amount:result.settlement.gross_amount,
              adjustment_amount:result.settlement.adjustment_amount,
              fee_amount:result.settlement.fee_amount,
              tax_amount:result.settlement.tax_amount,
              net_amount:result.settlement.net_amount,
              period_start:result.settlement.period_start,
              period_end:result.settlement.period_end
            }
          });
        }
        if(result.code==="ok" && !result.idempotent){
          await sql.query(
            `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
             VALUES ($1,'revale_admin',$2,'settlement.closed','settlement',$3,$4::jsonb)`,
            [merchant.id,principal.adminUserId,result.settlement.id,JSON.stringify({periodStart:result.settlement.period_start,periodEnd:result.settlement.period_end})]
          );
        }
      }
      return json(res,200,{ok:true,results});
    }

    if(req.method==="POST" && action==="schedule-payout"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const result=await scheduleSettlementPayout(sql,id,principal.adminUserId);
      if(result.code!=="ok"){
        const messages={
          not_found:"Liquidación no encontrada",
          already_paid:"Esta liquidación ya está pagada",
          invalid_status:"La liquidación no puede programarse en su estado actual",
          non_positive_net:"El neto de esta liquidación no requiere transferencia",
          bank_missing:"El comercio no tiene una cuenta bancaria verificada",
          fee_invoice_pending:"Registra primero la factura ReVale emitida para esta liquidación",
          withholding_pending:"Existe una retención reportada pendiente de verificación",
          merchant_balance_offset:"El mayor contable del comercio no tiene saldo pagable; existe un reverso o saldo anterior que compensa esta liquidación",
          credit_note_pending:"Existe una nota de crédito ReVale pendiente de emisión para este comercio",
          credit_note_withholding_review_pending:"Existe una nota de crédito cuya retención asociada requiere revisión de Finanzas"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo programar el pago",detail:result});
      }
      const [settlement]=await sql.query("SELECT merchant_id FROM revale.settlements WHERE id=$1",[id]);
      await sql.query(
        `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'revale_admin',$2,'settlement.payout_scheduled','settlement',$3,$4::jsonb)`,
        [settlement?.merchant_id||null,principal.adminUserId,id,JSON.stringify({payoutId:result.payout.id,attemptNo:result.payout.attempt_no})]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="mark-payout-paid"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const reference=String(req.body?.payout_reference||"").trim().slice(0,160);
      const result=await markSettlementPaid(sql,id,reference,principal.adminUserId);
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="reference_required"?"Ingresa la referencia de la transferencia":"La liquidación no puede marcarse como pagada",detail:result});
      }
      const [settlement]=await sql.query("SELECT merchant_id,currency FROM revale.settlements WHERE id=$1",[id]);
      const payoutAmount=Number(result.settlement?.payout_amount||0);
      await emitAndPostAccountingEvent(sql,{
        eventType:"merchant_payout_paid",
        sourceType:"settlement",
        sourceId:id,
        eventKey:"paid",
        amount:payoutAmount,
        currency:String(result.settlement?.payout_currency||settlement?.currency||"USD").trim(),
        merchantId:settlement?.merchant_id||null,
        settlementId:id,
        payload:{payout_reference:reference,payout_id:result.settlement?.payout_id||null,payout_amount:payoutAmount}
      });
      await sql.query(
        `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'revale_admin',$2,'settlement.paid','settlement',$3,$4::jsonb)`,
        [settlement?.merchant_id||null,principal.adminUserId,id,JSON.stringify({payoutReference:reference})]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="mark-payout-failed"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const reason=String(req.body?.reason||"").trim().slice(0,500);
      const result=await markSettlementFailed(sql,id,reason,principal.adminUserId);
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:"La liquidación no tiene un pago programado activo",detail:result});
      }
      const [settlement]=await sql.query("SELECT merchant_id FROM revale.settlements WHERE id=$1",[id]);
      await sql.query(
        `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'revale_admin',$2,'settlement.payout_failed','settlement',$3,$4::jsonb)`,
        [settlement?.merchant_id||null,principal.adminUserId,id,JSON.stringify({reason})]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="register-fee-invoice"){
      if(!requireRoles(["superadmin","finance"]))return;
      const settlementId=String(req.body?.settlement_id||"");
      const invoiceNumber=String(req.body?.invoice_number||"").trim().slice(0,80);
      const accessKey=String(req.body?.access_key||"").trim().slice(0,160);
      const issuedAt=req.body?.issued_at?String(req.body.issued_at):null;
      const result=await registerIssuedFeeInvoice(sql,{
        settlementId,invoiceNumber,accessKey,issuedAt,actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Liquidación no encontrada",
          invoice_number_required:"Ingresa el número de factura",
          duplicate_access_key:"La clave de acceso ya está registrada",
          invalid_status:"La factura ya no puede modificarse"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo registrar la factura",detail:result});
      }
      const fi=result.invoice;
      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,'fee_invoice.issued','merchant_fee_invoice',$3,$4::jsonb)`,
        [
          fi.merchant_id,principal.adminUserId,fi.id,
          JSON.stringify({settlementId:fi.settlement_id,invoiceNumber:fi.invoice_number,accessKey:fi.access_key||null})
        ]
      );
      return json(res,200,{ok:true,invoice:fi});
    }

    if(req.method==="GET" && action==="credit-notes"){
      if(!requireRoles(["superadmin","finance"]))return;
      const rows=await sql.query(
        `SELECT
           cn.id,cn.fee_invoice_id,cn.settlement_id,cn.merchant_id,m.name AS merchant_name,
           cn.transaction_id,cn.credit_note_number,cn.access_key,
           cn.subtotal::float8 AS subtotal,cn.vat_amount::float8 AS vat_amount,
           cn.total_amount::float8 AS total_amount,cn.currency,cn.reason,cn.status,
           cn.withholding_status,
           cn.withholding_adjustment_amount::float8 AS withholding_adjustment_amount,
           cn.withholding_resolution_note,cn.resolved_by,cn.resolved_at,cn.issued_at,cn.created_at,
           fi.invoice_number,fi.total_amount::float8 AS invoice_total,
           s.period_start,s.period_end,s.status AS settlement_status,
           COALESCE((
             SELECT SUM(w.total_amount)
             FROM revale.merchant_withholdings w
             WHERE w.fee_invoice_id=cn.fee_invoice_id AND w.status='verified'
           ),0)::float8 AS verified_withholding_total
         FROM revale.merchant_fee_credit_notes cn
         JOIN revale.merchants m ON m.id=cn.merchant_id
         JOIN revale.merchant_fee_invoices fi ON fi.id=cn.fee_invoice_id
         JOIN revale.settlements s ON s.id=cn.settlement_id
         ORDER BY
           CASE
             WHEN cn.status='pending_issue' THEN 1
             WHEN cn.status='issued' AND cn.withholding_status='review_required' THEN 2
             ELSE 3
           END,
           cn.created_at DESC
         LIMIT 200`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="POST" && action==="register-fee-credit-note"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const number=String(req.body?.credit_note_number||"").trim().slice(0,80);
      const accessKey=String(req.body?.access_key||"").trim().slice(0,160);
      const issuedAt=req.body?.issued_at?String(req.body.issued_at):null;
      const result=await registerIssuedFeeCreditNote(sql,{
        creditNoteId:id,creditNoteNumber:number,accessKey,issuedAt,actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Nota de crédito no encontrada",
          credit_note_number_required:"Ingresa el número de nota de crédito",
          duplicate_access_key:"La clave de acceso ya está registrada",
          invalid_status:"La nota de crédito ya no puede modificarse"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo registrar la nota de crédito",detail:result});
      }
      const cn=result.creditNote;
      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,'fee_credit_note.issued','merchant_fee_credit_note',$3,$4::jsonb)`,
        [
          cn.merchant_id,principal.adminUserId,cn.id,
          JSON.stringify({
            settlementId:cn.settlement_id,transactionId:cn.transaction_id,
            creditNoteNumber:cn.credit_note_number,totalAmount:cn.total_amount
          })
        ]
      );
      return json(res,200,{ok:true,creditNote:cn});
    }

    if(req.method==="POST" && action==="resolve-credit-note-withholding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const adjustmentAmount=Number(req.body?.withholding_adjustment_amount||0);
      const note=String(req.body?.resolution_note||"").trim().slice(0,500);
      const result=await resolveFeeCreditNoteWithholding(sql,{
        creditNoteId:id,
        withholdingAdjustmentAmount:adjustmentAmount,
        resolutionNote:note,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Nota de crédito no encontrada",
          invalid_amount:"El ajuste de retención no puede ser negativo",
          credit_note_not_issued:"Registra primero la nota de crédito emitida",
          amount_exceeds_withholding:"El ajuste supera la retención verificada de la factura",
          invalid_status:"La revisión tributaria ya fue resuelta"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo resolver la retención",detail:result});
      }
      const cn=result.creditNote;
      if(Number(result.withholdingAdjustmentAmount||0)>0){
        await emitAndPostAccountingEvent(sql,{
          eventType:"merchant_withholding_credit_reversed",
          sourceType:"fee_credit_note",
          sourceId:cn.id,
          eventKey:"withholding_credit_reversed",
          amount:Number(result.withholdingAdjustmentAmount||0),
          merchantId:cn.merchant_id,
          settlementId:cn.settlement_id,
          transactionId:cn.transaction_id||null,
          payload:{
            credit_note_number:cn.credit_note_number||null,
            resolution_note:cn.withholding_resolution_note||null
          }
        });
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,'fee_credit_note.withholding_resolved','merchant_fee_credit_note',$3,$4::jsonb)`,
        [
          cn.merchant_id,principal.adminUserId,cn.id,
          JSON.stringify({
            settlementId:cn.settlement_id,
            withholdingAdjustmentAmount:Number(result.withholdingAdjustmentAmount||0),
            resolutionNote:cn.withholding_resolution_note||null
          })
        ]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="reconcile-settlement"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const result=await reconcileSettlementPayout(sql,{
        settlementId:id,
        bankReference:req.body?.bank_reference,
        bankPostedOn:req.body?.bank_posted_on,
        bankAmount:req.body?.bank_amount,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Liquidación no encontrada",
          reference_required:"Ingresa la referencia bancaria",
          date_required:"Ingresa la fecha de contabilización bancaria",
          invalid_amount:"Ingresa el monto debitado en banco",
          paid_payout_missing:"No existe un payout pagado para conciliar",
          invalid_status:"La liquidación no está lista para conciliación"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo conciliar la liquidación",detail:result});
      }
      const rec=result.reconciliation;
      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,$3,'settlement_reconciliation',$4,$5::jsonb)`,
        [
          rec.merchant_id,principal.adminUserId,
          rec.status==="matched"?"settlement.reconciled":"settlement.reconciliation_mismatch",
          rec.id,
          JSON.stringify({
            settlementId:rec.settlement_id,expectedAmount:rec.expected_amount,
            bankAmount:rec.bank_amount,differenceAmount:rec.difference_amount,
            bankReference:rec.bank_reference
          })
        ]
      );
      return json(res,200,{ok:true,reconciliation:rec});
    }

    if(req.method==="GET" && action==="withholdings"){
      if(!requireRoles(["superadmin","finance"]))return;
      const rows=await sql.query(
        `SELECT
           w.id,w.settlement_id,w.fee_invoice_id,w.merchant_id,m.name AS merchant_name,
           w.document_number,w.authorization_number,w.issued_on,
           w.income_tax_amount::float8 AS income_tax_amount,
           w.vat_withheld_amount::float8 AS vat_withheld_amount,
           w.total_amount::float8 AS total_amount,
           w.status,w.reported_by,w.verified_by,w.verified_at,w.rejection_reason,w.created_at,
           fi.invoice_number,fi.subtotal::float8 AS invoice_subtotal,
           fi.vat_amount::float8 AS invoice_vat,fi.total_amount::float8 AS invoice_total,
           s.period_start,s.period_end,s.status AS settlement_status
         FROM revale.merchant_withholdings w
         JOIN revale.merchants m ON m.id=w.merchant_id
         JOIN revale.merchant_fee_invoices fi ON fi.id=w.fee_invoice_id
         JOIN revale.settlements s ON s.id=w.settlement_id
         ORDER BY CASE w.status WHEN 'reported' THEN 1 WHEN 'verified' THEN 2 ELSE 3 END,w.created_at DESC
         LIMIT 200`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="POST" && action==="review-withholding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const withholdingId=String(req.body?.id||"");
      const decision=String(req.body?.decision||"");
      const rejectionReason=String(req.body?.rejection_reason||"").trim().slice(0,500);
      if(!withholdingId || !["verify","reject"].includes(decision)){
        return json(res,400,{ok:false,error:"Solicitud de retención inválida"});
      }
      const result=await reviewMerchantWithholding(sql,{
        withholdingId,
        decision,
        actorId:principal.adminUserId,
        rejectionReason
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="not_found"?"Retención no encontrada":"La retención ya fue resuelta",detail:result});
      }

      const w=result.withholding;
      if(decision==="verify"){
        await emitAndPostAccountingEvent(sql,{
          eventType:"merchant_withholding_verified",
          sourceType:"merchant_withholding",
          sourceId:w.id,
          eventKey:"verified",
          amount:w.total_amount,
          merchantId:w.merchant_id,
          settlementId:w.settlement_id,
          payload:{
            document_number:w.document_number||null,
            income_tax_amount:w.income_tax_amount||0,
            vat_withheld_amount:w.vat_withheld_amount||0
          }
        });
      }

      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,$3,'merchant_withholding',$4,$5::jsonb)`,
        [
          w.merchant_id||null,
          principal.adminUserId,
          decision==="verify"?"withholding.verified":"withholding.rejected",
          w.id,
          JSON.stringify({settlementId:w.settlement_id,totalAmount:w.total_amount,rejectionReason:rejectionReason||null})
        ]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="GET" && action==="accounting"){
      if(!requireRoles(["superadmin","finance"]))return;
      const [status]=await sql.query(
        `SELECT
          COUNT(*) FILTER (WHERE status='pending')::int AS pending,
          COUNT(*) FILTER (WHERE status='error')::int AS errors,
          COUNT(*) FILTER (WHERE status='posted')::int AS posted
         FROM revale.accounting_events`
      );
      const accounts=await sql.query(
        `SELECT
           a.id,a.internal_code,a.local_account_code,a.name,a.account_type,a.normal_balance,a.ifrs_category,a.ecuador_reporting_line,
           COALESCE(SUM(l.debit),0)::float8 AS debits,
           COALESCE(SUM(l.credit),0)::float8 AS credits,
           CASE
             WHEN a.normal_balance='debit' THEN (COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0))::float8
             ELSE (COALESCE(SUM(l.credit),0)-COALESCE(SUM(l.debit),0))::float8
           END AS balance
         FROM revale.gl_accounts a
         LEFT JOIN revale.gl_journal_lines l ON l.account_id=a.id
         LEFT JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
         WHERE a.active=true
         GROUP BY a.id
         ORDER BY a.internal_code`
      );
      const journals=await sql.query(
        `SELECT j.id,j.source_type,j.source_id,j.event_key,j.journal_date,j.currency,j.description,j.status,
                j.merchant_id,j.employer_id,j.person_id,j.settlement_id,j.transaction_id,j.posted_at,
                COALESCE(SUM(l.debit),0)::float8 AS debits,
                COALESCE(SUM(l.credit),0)::float8 AS credits
         FROM revale.gl_journals j
         LEFT JOIN revale.gl_journal_lines l ON l.journal_id=j.id
         GROUP BY j.id
         ORDER BY j.posted_at DESC
         LIMIT 100`
      );
      return json(res,200,{ok:true,status:status||{},accounts,journals});
    }

    if(req.method==="POST" && action==="accounting-reconcile"){
      if(!requireRoles(["superadmin","finance"]))return;
      const results=await processPendingAccountingEvents(sql,200);
      return json(res,200,{ok:true,results});
    }

    if(req.method==="GET" && action==="funding-queue"){
      const rows=await sql.query(
        `SELECT fb.id,fb.employer_id,e.name AS employer_name,fb.program_id,bp.name AS program_name,
                fb.external_reference,fb.amount::float8 AS amount,fb.currency,fb.status,fb.created_at,
                COUNT(fbi.id)::int AS employee_count,
                COALESCE(SUM(fbi.amount),0)::float8 AS item_total
         FROM revale.funding_batches fb
         JOIN revale.employers e ON e.id=fb.employer_id
         LEFT JOIN revale.benefit_programs bp ON bp.id=fb.program_id
         LEFT JOIN revale.funding_batch_items fbi ON fbi.funding_batch_id=fb.id
         GROUP BY fb.id,e.name,bp.name
         ORDER BY CASE fb.status WHEN 'pending' THEN 0 WHEN 'received' THEN 1 ELSE 2 END,fb.created_at DESC
         LIMIT 100`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="GET" && action==="branch-queue"){
      const rows=await sql.query(
        `SELECT r.id,r.merchant_id,m.name AS merchant_name,r.requested_by,r.name,r.address,r.requested_terminals,r.status,r.created_at,r.reviewed_at
         FROM revale.merchant_location_requests r
         JOIN revale.merchants m ON m.id=r.merchant_id
         ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC
         LIMIT 100`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="GET" && action==="bank-queue"){
      const rows=await sql.query(
        `SELECT r.id,r.merchant_id,m.name AS merchant_name,r.bank_name,r.account_type,r.account_number,
                r.holder_name,r.holder_identification,r.requested_by,r.status,r.reviewed_by,r.reviewed_at,r.rejection_reason,r.created_at
         FROM revale.merchant_bank_account_requests r
         JOIN revale.merchants m ON m.id=r.merchant_id
         ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC
         LIMIT 100`
      );
      return json(res,200,{ok:true,items:rows.map(x=>({...x,account_number_masked:"•••• "+String(x.account_number||"").slice(-4),account_number:undefined}))});
    }

    if(req.method==="GET" && action==="merchants"){
      const rows=await sql.query(
        `SELECT m.id,m.name,m.slug,m.tax_id,m.active,m.created_at,
                COUNT(DISTINCT ml.id) FILTER (WHERE ml.active=true)::int AS locations,
                COUNT(DISTINCT mu.id) FILTER (WHERE mu.active=true)::int AS users
         FROM revale.merchants m
         LEFT JOIN revale.merchant_locations ml ON ml.merchant_id=m.id
         LEFT JOIN revale.merchant_users mu ON mu.merchant_id=m.id
         GROUP BY m.id
         ORDER BY m.name`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="GET" && action==="employers"){
      const rows=await sql.query(
        `SELECT e.id,e.name,e.slug,e.tax_id,e.active,e.created_at,
                COUNT(DISTINCT bp.id) FILTER (WHERE bp.active=true)::int AS programs,
                COUNT(DISTINCT ee.person_id) FILTER (WHERE ee.status='active')::int AS employees
         FROM revale.employers e
         LEFT JOIN revale.benefit_programs bp ON bp.employer_id=e.id
         LEFT JOIN revale.employee_enrollments ee ON ee.program_id=bp.id
         GROUP BY e.id
         ORDER BY e.name`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="GET" && action==="audit"){
      const rows=await sql.query(
        `SELECT id,merchant_id,employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at
         FROM revale.audit_events
         ORDER BY created_at DESC
         LIMIT 200`
      );
      return json(res,200,{ok:true,items:rows});
    }

    if(req.method==="POST" && action==="approve-funding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const [batch]=await sql.query("SELECT id,employer_id,program_id,amount::float8 AS amount,currency,status FROM revale.funding_batches WHERE id=$1 LIMIT 1",[id]);
      if(!batch)return json(res,404,{ok:false,error:"Fondeo no encontrado"});
      const result=await confirmFundingBatchAtomic(sql,id);
      if(result.code!=="ok"){
        const messages={no_items:"El fondeo no tiene colaboradores preparados",insufficient_funding:"El monto no cubre las asignaciones",invalid_status:"El fondeo no puede procesarse"};
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo acreditar el fondeo",detail:result});
      }
      await emitAndPostAccountingEvent(sql,{
        eventType:"funding_received",
        sourceType:"funding_batch",
        sourceId:id,
        eventKey:"allocated",
        amount:batch.amount,
        currency:String(batch.currency||"USD").trim(),
        employerId:batch.employer_id,
        payload:{program_id:batch.program_id,allocated_by:principal.adminUserId}
      });
      await sql.query(
        `INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'revale_admin',$2,'funding.allocated','funding_batch',$3,$4::jsonb)`,
        [batch.employer_id,principal.adminUserId,id,JSON.stringify({role:principal.role})]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="reject-funding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const reason=String(req.body?.reason||"").trim().slice(0,400);
      const [row]=await sql.query(
        `UPDATE revale.funding_batches
         SET status='cancelled',updated_at=now(),metadata=metadata||jsonb_build_object('rejection_reason',$2,'rejected_by',$3)
         WHERE id=$1 AND status IN ('pending','received')
         RETURNING id,employer_id,status`,
        [id,reason||null,principal.adminUserId]
      );
      if(!row)return json(res,409,{ok:false,error:"El fondeo ya no puede rechazarse"});
      await sql.query("UPDATE revale.funding_batch_items SET status='cancelled' WHERE funding_batch_id=$1 AND status='pending'",[id]);
      await sql.query(
        `INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'revale_admin',$2,'funding.rejected','funding_batch',$3,$4::jsonb)`,
        [row.employer_id,principal.adminUserId,id,JSON.stringify({reason})]
      );
      return json(res,200,{ok:true,item:row});
    }

    if(req.method==="POST" && action==="resolve-branch"){
      if(!requireRoles(["superadmin","ops"]))return;
      const id=Number(req.body?.id||0),decision=String(req.body?.decision||"");
      if(!id||!["approve","reject"].includes(decision))return json(res,400,{ok:false,error:"Solicitud inválida"});
      const [request]=await sql.query("SELECT * FROM revale.merchant_location_requests WHERE id=$1 AND status='pending' LIMIT 1",[id]);
      if(!request)return json(res,404,{ok:false,error:"Solicitud no encontrada o ya resuelta"});

      if(decision==="reject"){
        const [row]=await sql.query("UPDATE revale.merchant_location_requests SET status='rejected',reviewed_at=now(),metadata=metadata||jsonb_build_object('reviewed_by',$2) WHERE id=$1 RETURNING *",[id,principal.adminUserId]);
        await sql.query(
          `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
           VALUES ($1,'revale_admin',$2,'branch.rejected','merchant_location_request',$3,'{}'::jsonb)`,
          [request.merchant_id,principal.adminUserId,String(id)]
        );
        return json(res,200,{ok:true,item:row});
      }

      const locationId=safeLocationId(request.merchant_id,request.name);
      const baseSlug=slugify(request.name);
      await sql.query("BEGIN");
      try{
        const [loc]=await sql.query(
          `INSERT INTO revale.merchant_locations (id,merchant_id,name,active,slug,metadata)
           VALUES ($1,$2,$3,true,$4,jsonb_build_object('demo_terminal','Caja 01','address',$5,'requested_terminals',$6))
           RETURNING id,merchant_id,name,slug,active,metadata`,
          [locationId,request.merchant_id,request.name,baseSlug+"-"+String(id),request.address||null,request.requested_terminals]
        );
        await sql.query("UPDATE revale.merchant_location_requests SET status='approved',reviewed_at=now(),metadata=metadata||jsonb_build_object('reviewed_by',$2,'location_id',$3) WHERE id=$1",[id,principal.adminUserId,locationId]);
        await sql.query(
          `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
           VALUES ($1,'revale_admin',$2,'branch.approved','merchant_location',$3,$4::jsonb)`,
          [request.merchant_id,principal.adminUserId,locationId,JSON.stringify({requestId:id})]
        );
        await sql.query("COMMIT");
        return json(res,200,{ok:true,location:loc});
      }catch(error){await sql.query("ROLLBACK");throw error}
    }

    if(req.method==="POST" && action==="resolve-bank"){
      if(!requireRoles(["superadmin","finance","risk"]))return;
      const id=Number(req.body?.id||0),decision=String(req.body?.decision||""),reason=String(req.body?.reason||"").trim().slice(0,400);
      if(!id||!["approve","reject"].includes(decision))return json(res,400,{ok:false,error:"Solicitud inválida"});
      const [request]=await sql.query("SELECT * FROM revale.merchant_bank_account_requests WHERE id=$1 AND status='pending' LIMIT 1",[id]);
      if(!request)return json(res,404,{ok:false,error:"Solicitud no encontrada o ya resuelta"});

      if(decision==="reject"){
        const [row]=await sql.query(
          `UPDATE revale.merchant_bank_account_requests
           SET status='rejected',reviewed_by=$2,reviewed_at=now(),rejection_reason=$3,updated_at=now()
           WHERE id=$1 RETURNING id,merchant_id,status,rejection_reason`,
          [id,principal.adminUserId,reason||null]
        );
        await sql.query(
          `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
           VALUES ($1,'revale_admin',$2,'bank_account.rejected','merchant_bank_account_request',$3,$4::jsonb)`,
          [request.merchant_id,principal.adminUserId,String(id),JSON.stringify({reason})]
        );
        return json(res,200,{ok:true,item:row});
      }

      await sql.query("BEGIN");
      try{
        await sql.query("UPDATE revale.merchant_bank_accounts SET status='superseded',updated_at=now() WHERE merchant_id=$1 AND status IN ('verified','pending')",[request.merchant_id]);
        const [account]=await sql.query(
          `INSERT INTO revale.merchant_bank_accounts (
             merchant_id,bank_name,account_type,account_number,holder_name,holder_identification,
             status,requested_by,verified_by,verified_at,metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,'verified',$7,$8,now(),jsonb_build_object('source_request_id',$9))
           RETURNING id,merchant_id,bank_name,account_type,holder_name,status,verified_at`,
          [request.merchant_id,request.bank_name,request.account_type,request.account_number,request.holder_name,request.holder_identification,request.requested_by,principal.adminUserId,id]
        );
        await sql.query(
          `UPDATE revale.merchant_bank_account_requests
           SET status='approved',reviewed_by=$2,reviewed_at=now(),updated_at=now()
           WHERE id=$1`,
          [id,principal.adminUserId]
        );
        await sql.query(
          `INSERT INTO revale.audit_events (merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
           VALUES ($1,'revale_admin',$2,'bank_account.verified','merchant_bank_account',$3,$4::jsonb)`,
          [request.merchant_id,principal.adminUserId,String(account.id),JSON.stringify({requestId:id})]
        );
        await sql.query("COMMIT");
        return json(res,200,{ok:true,account});
      }catch(error){await sql.query("ROLLBACK");throw error}
    }

    return json(res,405,{ok:false,error:"Acción no soportada"});
  }catch(error){
    console.error("ReVale admin API error",error);
    return json(res,500,{ok:false,error:"Error interno del servicio"});
  }
}
