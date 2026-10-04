import { getSql } from "../lib/revale-db.js";
import { getAdminPrincipal, roleAllowed } from "../lib/revale-auth.js";
import {
  ensureFundingTreasurySchema,
  confirmFundingBatchAtomic,
  registerFundingReceipt,
  refundFundingExcess,
  fundingBatchMoneySummary,
  treasuryControl
} from "../lib/revale-admin-funding.js";
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
  ensureSafeguardingSchema,
  safeguardingControl,
  upsertTreasuryAccount,
  recordTreasuryBalance,
  setSafeguardingEnforcement,
  registerTreasuryTransfer
} from "../lib/revale-safeguarding.js";
import {
  ensureBankReconciliationSchema,
  previewBankStatement,
  importBankStatement,
  generateBankMatchSuggestions,
  bankMatchCandidatesForEntry,
  listBankStatementImports,
  listBankStatementEntries,
  getBankStatementEntry,
  markBankStatementEntryMatched,
  ignoreBankStatementEntry
} from "../lib/revale-bank-reconciliation.js";
import {
  ensureFinancialApprovalSchema,
  financialPermission,
  listFinancialPolicies,
  listFinancialUsers,
  updateFinancialUserPermission,
  updateFinancialPolicy,
  createFinancialApprovalRequest,
  listFinancialApprovalRequests,
  approvalDecision,
  getFinancialApprovalRequest,
  claimFinancialApprovalForExecution,
  finishFinancialApprovalExecution,
  pendingApprovalSummary
} from "../lib/revale-financial-approvals.js";
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

async function executeApprovedFinancialAction(sql,request,actorId){
  const payload=request.payload||{};
  if(request.action_type==="funding_allocation"){
    const before=await fundingBatchMoneySummary(sql,request.entity_id);
    if(!before)return {code:"not_found"};
    if(Number(before.pending_allocation||0)>Number(request.amount||0)+0.00001){
      return {code:"approval_amount_exceeded",approved_amount:request.amount,required:before.pending_allocation};
    }
    const [batch]=await sql.query(
      `SELECT id,employer_id,program_id,currency,status
       FROM revale.funding_batches WHERE id=$1 LIMIT 1`,
      [request.entity_id]
    );
    if(!batch)return {code:"not_found"};
    const result=await confirmFundingBatchAtomic(sql,request.entity_id);
    if(result.code!=="ok")return result;
    const allocatedAmount=Number(result.allocatedAmount||result.summary?.allocated_amount||0);
    if(allocatedAmount>Number(request.amount||0)+0.00001){
      return {code:"approval_amount_exceeded",approved_amount:request.amount,allocated_amount:allocatedAmount};
    }
    if(allocatedAmount>0){
      await emitAndPostAccountingEvent(sql,{
        eventType:"funding_allocated",
        sourceType:"funding_batch",
        sourceId:request.entity_id,
        eventKey:"allocated_v2",
        amount:allocatedAmount,
        currency:String(batch.currency||"USD").trim(),
        employerId:batch.employer_id,
        payload:{
          program_id:batch.program_id,
          allocated_by:actorId,
          verified_cash:true,
          financial_approval_request_id:request.id,
          received_amount:result.summary?.received_amount||0,
          excess_after_allocation:result.summary?.cash_available||0
        }
      });
    }
    return {code:"ok",result:{...result,allocatedAmount}};
  }

  if(request.action_type==="merchant_payout"){
    const result=await scheduleSettlementPayout(
      sql,request.entity_id,actorId,{maxApprovedAmount:Number(request.amount||0)}
    );
    if(result.code!=="ok")return result;
    return {code:"ok",result};
  }

  if(request.action_type==="employer_refund"){
    const result=await refundFundingExcess(sql,{
      fundingBatchId:request.entity_id,
      amount:Number(request.amount||0),
      bankReference:payload.bank_reference,
      bankPostedOn:payload.bank_posted_on,
      reason:payload.reason||null,
      treasuryAccountId:payload.treasury_account_id||null,
      actorId
    });
    if(result.code!=="ok")return result;
    await emitAndPostAccountingEvent(sql,{
      eventType:"funding_refunded",
      sourceType:"funding_refund",
      sourceId:result.refund.id,
      eventKey:"confirmed",
      amount:result.refund.amount,
      currency:String(result.refund.currency||request.currency||"USD").trim(),
      employerId:result.refund.employer_id,
      payload:{
        funding_batch_id:request.entity_id,
        bank_reference:result.refund.bank_reference,
        reason:result.refund.reason||null,
        financial_approval_request_id:request.id
      }
    });
    return {code:"ok",result};
  }

  if(request.action_type==="safeguarding_topup"||request.action_type==="safeguarding_sweep"){
    const transferType=request.action_type==="safeguarding_topup"?"safeguarding_topup":"excess_sweep";
    const result=await registerTreasuryTransfer(sql,{
      transferType,
      amount:Number(request.amount||0),
      bankReference:payload.bank_reference,
      bankPostedOn:payload.bank_posted_on,
      fromAccountId:payload.from_account_id||null,
      toAccountId:payload.to_account_id||null,
      actorId
    });
    if(result.code!=="ok")return result;
    const t=result.transfer;
    await emitAndPostAccountingEvent(sql,{
      eventType:t.transfer_type==="safeguarding_topup"?"safeguarding_topup":"safeguarding_sweep",
      sourceType:"treasury_internal_transfer",
      sourceId:t.id,
      eventKey:"confirmed",
      amount:t.amount,
      currency:String(t.currency||"USD").trim(),
      payload:{
        from_account_id:t.from_account_id,
        to_account_id:t.to_account_id,
        bank_reference:t.bank_reference,
        bank_posted_on:t.bank_posted_on,
        financial_approval_request_id:request.id
      }
    });
    return {code:"ok",result};
  }

  if(request.action_type==="withholding_verification"){
    const [current]=await sql.query(
      `SELECT total_amount::float8 AS total_amount,status
       FROM revale.merchant_withholdings WHERE id=$1 LIMIT 1`,
      [request.entity_id]
    );
    if(!current)return {code:"not_found"};
    if(current.status!=="reported"&&current.status!=="verified")return {code:"invalid_status",status:current.status};
    if(Number(current.total_amount||0)>Number(request.amount||0)+0.00001){
      return {code:"approval_amount_exceeded",approved_amount:request.amount,actual_amount:current.total_amount};
    }
    const result=await reviewMerchantWithholding(sql,{
      withholdingId:request.entity_id,
      decision:"verify",
      actorId,
      rejectionReason:null
    });
    if(result.code!=="ok")return result;
    const w=result.withholding;
    if(Number(w.total_amount||request.amount||0)>Number(request.amount||0)+0.00001){
      return {code:"approval_amount_exceeded",approved_amount:request.amount,actual_amount:w.total_amount};
    }
    await emitAndPostAccountingEvent(sql,{
      eventType:"merchant_withholding_verified",
      sourceType:"merchant_withholding",
      sourceId:w.id,
      eventKey:"verified",
      amount:Number(w.total_amount||request.amount||0),
      merchantId:w.merchant_id,
      settlementId:w.settlement_id,
      payload:{
        document_number:w.document_number||null,
        income_tax_amount:w.income_tax_amount||0,
        vat_withheld_amount:w.vat_withheld_amount||0,
        financial_approval_request_id:request.id
      }
    });
    return {code:"ok",result};
  }

  if(request.action_type==="credit_note_withholding"){
    const result=await resolveFeeCreditNoteWithholding(sql,{
      creditNoteId:request.entity_id,
      withholdingAdjustmentAmount:Number(request.amount||0),
      resolutionNote:payload.resolution_note||null,
      actorId
    });
    if(result.code!=="ok")return result;
    const cn=result.creditNote;
    if(Number(request.amount||0)>0){
      await emitAndPostAccountingEvent(sql,{
        eventType:"merchant_withholding_credit_reversed",
        sourceType:"fee_credit_note",
        sourceId:cn.id,
        eventKey:"withholding_credit_reversed",
        amount:Number(request.amount||0),
        merchantId:cn.merchant_id,
        settlementId:cn.settlement_id,
        transactionId:cn.transaction_id||null,
        payload:{
          credit_note_number:cn.credit_note_number||null,
          resolution_note:payload.resolution_note||null,
          financial_approval_request_id:request.id
        }
      });
    }
    return {code:"ok",result};
  }

  return {code:"unsupported_action"};
}

async function executeFinancialApprovalRequest(sql,requestId,actorId){
  const claim=await claimFinancialApprovalForExecution(sql,requestId,actorId);
  if(claim.code!=="ok")return claim;
  const request=claim.request;
  try{
    const execution=await executeApprovedFinancialAction(sql,request,actorId);
    if(execution.code!=="ok"){
      await finishFinancialApprovalExecution(sql,{
        requestId:request.id,success:false,result:execution,
        failureReason:execution.code||"domain_error"
      });
      return {code:"execution_failed",request,detail:execution};
    }
    await finishFinancialApprovalExecution(sql,{
      requestId:request.id,success:true,result:execution.result||execution
    });
    return {code:"ok",request,result:execution.result||execution};
  }catch(error){
    await finishFinancialApprovalExecution(sql,{
      requestId:request.id,success:false,
      result:{message:String(error?.message||error)},
      failureReason:String(error?.message||error)
    });
    throw error;
  }
}

async function auditFinancialRequest(sql,{principal,request,action,metadata={}}){
  await sql.query(
    `INSERT INTO revale.audit_events (
       actor_type,actor_id,action,resource_type,resource_id,metadata
     ) VALUES ('revale_admin',$1,$2,'financial_approval_request',$3,$4::jsonb)`,
    [
      principal.adminUserId,action,request.id,
      JSON.stringify({
        actionType:request.action_type,entityType:request.entity_type,
        entityId:request.entity_id,amount:request.amount,currency:request.currency,
        ...metadata
      })
    ]
  );
}

export default async function handler(req,res){
  const action=String(req.query?.action||"");
  try{
    const sql=await getSql();
    await ensureSettlementTaxSchema(sql);
    await ensureFundingTreasurySchema(sql);
    await ensureSafeguardingSchema(sql);
    await ensureBankReconciliationSchema(sql);
    await ensureFinancialApprovalSchema(sql);
    const principal=await getAdminPrincipal(sql,req);
    if(!principal)return json(res,401,{ok:false,error:"Sesión requerida"});

    const requireRoles=(roles)=>{
      if(!roleAllowed(principal,roles)){json(res,403,{ok:false,error:"No tienes permisos para esta acción"});return false}
      return true;
    };

    if(req.method==="GET" && action==="financial-approvals"){
      if(!requireRoles(["superadmin","finance"]))return;
      const [requests,policies,summary]=await Promise.all([
        listFinancialApprovalRequests(sql,{limit:250}),
        listFinancialPolicies(sql),
        pendingApprovalSummary(sql,principal.adminUserId)
      ]);
      const users=principal.role==="superadmin"?await listFinancialUsers(sql):[];
      return json(res,200,{
        ok:true,requests,policies,users,
        myPermission:summary.permission,
        pending:summary.pending,actionable:summary.actionable
      });
    }

    if(req.method==="POST" && action==="financial-approval-decision"){
      if(!requireRoles(["superadmin","finance"]))return;
      const requestId=String(req.body?.id||"");
      const decision=String(req.body?.decision||"");
      const note=String(req.body?.note||"").trim().slice(0,500);
      const result=await approvalDecision(sql,{
        requestId,approverId:principal.adminUserId,decision,note
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Solicitud de aprobación no encontrada",
          invalid_decision:"Decisión inválida",
          self_approval_forbidden:"No puedes aprobar una solicitud creada por ti",
          expired:"La solicitud expiró",
          invalid_status:"La solicitud ya no acepta decisiones",
          approver_not_allowed:"Tu usuario no tiene permiso de aprobador financiero",
          approval_limit_exceeded:"El monto supera tu límite personal de aprobación",
          already_decided:"Ya emitiste una decisión sobre esta solicitud"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo registrar la decisión",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,
        action:decision==="approve"?"financial_approval.approved":"financial_approval.rejected",
        metadata:{note:note||null,approvalCount:result.request?.approval_count||null}
      });

      let execution=null;
      if(result.readyToExecute && !result.rejected){
        execution=await executeFinancialApprovalRequest(sql,requestId,principal.adminUserId);
        if(execution.code==="ok"){
          await auditFinancialRequest(sql,{
            principal,request:execution.request,
            action:"financial_approval.executed",
            metadata:{executionResult:execution.result||null}
          });
        }else{
          await auditFinancialRequest(sql,{
            principal,request:result.request,
            action:"financial_approval.execution_failed",
            metadata:{execution}
          });
        }
      }
      return json(res,200,{ok:true,result,execution});
    }

    if(req.method==="POST" && action==="retry-financial-approval"){
      if(!requireRoles(["superadmin","finance"]))return;
      const requestId=String(req.body?.id||"");
      const request=await getFinancialApprovalRequest(sql,requestId);
      if(!request)return json(res,404,{ok:false,error:"Solicitud no encontrada"});
      const permission=await financialPermission(sql,principal.adminUserId);
      if(!permission.active||!permission.can_approve){
        return json(res,403,{ok:false,error:"Tu usuario no tiene permiso de aprobador financiero"});
      }
      if(request.requested_by===principal.adminUserId){
        return json(res,403,{ok:false,error:"El creador de la solicitud no puede ejecutar su propia aprobación"});
      }
      const execution=await executeFinancialApprovalRequest(sql,requestId,principal.adminUserId);
      if(execution.code!=="ok"){
        return json(res,409,{ok:false,error:"El reintento no pudo ejecutarse",detail:execution});
      }
      await auditFinancialRequest(sql,{
        principal,request:execution.request,
        action:"financial_approval.retried",
        metadata:{executionResult:execution.result||null}
      });
      return json(res,200,{ok:true,execution});
    }

    if(req.method==="POST" && action==="financial-policy"){
      if(!requireRoles(["superadmin"]))return;
      const result=await updateFinancialPolicy(sql,{
        actionType:req.body?.action_type,
        thresholdAmount:req.body?.threshold_amount,
        approvalsBelow:Number(req.body?.approvals_below),
        approvalsAbove:Number(req.body?.approvals_above),
        expiryHours:Number(req.body?.expiry_hours),
        active:req.body?.active!==false,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="invalid_policy"?"Configuración de aprobación inválida":"Política no encontrada",detail:result});
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'financial_policy.updated','financial_approval_policy',$2,$3::jsonb)`,
        [principal.adminUserId,result.policy.action_type,JSON.stringify(result.policy)]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="financial-user-permission"){
      if(!requireRoles(["superadmin"]))return;
      const result=await updateFinancialUserPermission(sql,{
        adminUserId:req.body?.admin_user_id,
        canMake:Boolean(req.body?.can_make),
        canApprove:Boolean(req.body?.can_approve),
        approvalLimit:req.body?.approval_limit,
        active:req.body?.active!==false,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="invalid_limit"?"Límite de aprobación inválido":"Usuario no encontrado",detail:result});
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'financial_permission.updated','admin_user',$2,$3::jsonb)`,
        [principal.adminUserId,result.permission.admin_user_id,JSON.stringify(result.permission)]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="GET" && action==="overview"){
      const [counts]=await sql.query(
        `SELECT
          (SELECT COUNT(*)::int FROM revale.merchants WHERE active=true) AS merchants,
          (SELECT COUNT(*)::int FROM revale.employers WHERE active=true) AS employers,
          (SELECT COUNT(*)::int FROM revale.transactions WHERE status='approved') AS approved_transactions,
          (SELECT COUNT(*)::int FROM revale.funding_batches WHERE status='pending') AS pending_funding,
          (SELECT COUNT(*)::int FROM revale.funding_batches WHERE status='received') AS funding_ready_to_allocate,
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
      const approvals=await pendingApprovalSummary(sql,principal.adminUserId);
      return json(res,200,{ok:true,counts:counts||{},money:money||{},recent,approvals});
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
      const [row]=await sql.query(
        `SELECT s.id,s.merchant_id,s.status,s.currency,
                s.net_amount::float8 AS net_amount,
                COALESCE((
                  SELECT SUM(sa.amount) FROM revale.settlement_adjustments sa
                  WHERE sa.settlement_id=s.id
                ),0)::float8 AS adjustment_total,
                COALESCE((
                  SELECT SUM(l.credit-l.debit)
                  FROM revale.gl_journal_lines l
                  JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
                  WHERE l.account_id='gl_merchant_payable' AND l.merchant_id=s.merchant_id
                ),0)::float8 AS ledger_payable,
                (SELECT COUNT(*) FROM revale.gl_journal_lines l
                 JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
                 WHERE l.account_id='gl_merchant_payable' AND l.merchant_id=s.merchant_id)::int AS ledger_lines
         FROM revale.settlements s
         WHERE s.id=$1
         LIMIT 1`,
        [id]
      );
      if(!row)return json(res,404,{ok:false,error:"Liquidación no encontrada"});
      if(!["closed","failed"].includes(row.status)){
        return json(res,409,{ok:false,error:"La liquidación no puede solicitar pago en su estado actual"});
      }
      const calculated=Math.round((Number(row.net_amount||0)+Number(row.adjustment_total||0)+Number.EPSILON)*100)/100;
      const payable=Number(row.ledger_lines||0)>0
        ? Math.max(0,Math.min(calculated,Number(row.ledger_payable||0)))
        : calculated;
      if(!(payable>0))return json(res,409,{ok:false,error:"La liquidación no tiene saldo pagable"});

      const result=await createFinancialApprovalRequest(sql,{
        actionType:"merchant_payout",
        entityType:"settlement",
        entityId:id,
        amount:payable,
        currency:String(row.currency||"USD").trim(),
        payload:{merchant_id:row.merchant_id,calculated_payout:calculated},
        requestNote:req.body?.note||null,
        requestedBy:principal.adminUserId,
        requestedByName:principal.displayName
      });
      if(result.code!=="ok"){
        const messages={
          maker_not_allowed:"Tu usuario no tiene permiso para crear solicitudes financieras",
          policy_disabled:"La política de aprobación para payouts está deshabilitada"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo crear la solicitud de pago",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,action:"financial_approval.requested",
        metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
      });
      return json(res,200,{ok:true,approvalRequired:true,result});
    }

    if(req.method==="POST" && action==="mark-payout-paid"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const reference=String(req.body?.payout_reference||"").trim().slice(0,160);
      const result=await markSettlementPaid(sql,id,reference,principal.adminUserId);
      if(result.code!=="ok"){
        const message=result.code==="reference_required"
          ?"Ingresa la referencia de la transferencia"
          :result.code==="safeguarding_blocked"
            ?"Safeguarding bloqueó el pago porque la cobertura ya no es suficiente"
            :"La liquidación no puede marcarse como pagada";
        return json(res,409,{ok:false,error:message,detail:result});
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
      if(adjustmentAmount<0)return json(res,400,{ok:false,error:"El ajuste de retención no puede ser negativo"});
      const [cn]=await sql.query(
        `SELECT cn.id,cn.merchant_id,cn.settlement_id,cn.transaction_id,
                cn.status,cn.withholding_status,cn.total_amount::float8 AS total_amount,
                COALESCE((
                  SELECT SUM(w.total_amount)
                  FROM revale.merchant_withholdings w
                  WHERE w.fee_invoice_id=cn.fee_invoice_id AND w.status='verified'
                ),0)::float8 AS verified_withholding_total
         FROM revale.merchant_fee_credit_notes cn
         WHERE cn.id=$1
         LIMIT 1`,
        [id]
      );
      if(!cn)return json(res,404,{ok:false,error:"Nota de crédito no encontrada"});
      if(cn.status!=="issued"||cn.withholding_status!=="review_required"){
        return json(res,409,{ok:false,error:"La nota de crédito no está lista para resolver retención"});
      }
      const maximum=Math.min(Number(cn.total_amount||0),Number(cn.verified_withholding_total||0));
      if(adjustmentAmount>maximum+0.00001){
        return json(res,409,{ok:false,error:"El ajuste supera el máximo reversible de la retención"});
      }
      const result=await createFinancialApprovalRequest(sql,{
        actionType:"credit_note_withholding",
        entityType:"merchant_fee_credit_note",
        entityId:id,
        amount:adjustmentAmount,
        currency:"USD",
        payload:{
          resolution_note:note||null,merchant_id:cn.merchant_id,
          settlement_id:cn.settlement_id,transaction_id:cn.transaction_id||null
        },
        requestNote:note||null,
        requestedBy:principal.adminUserId,
        requestedByName:principal.displayName
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="maker_not_allowed"?"Tu usuario no tiene permiso para crear solicitudes financieras":"No se pudo crear la aprobación del ajuste",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,action:"financial_approval.requested",
        metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
      });
      return json(res,200,{ok:true,approvalRequired:true,result});
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

      if(decision==="verify"){
        const [w]=await sql.query(
          `SELECT id,settlement_id,merchant_id,total_amount::float8 AS total_amount,status
           FROM revale.merchant_withholdings WHERE id=$1 LIMIT 1`,
          [withholdingId]
        );
        if(!w)return json(res,404,{ok:false,error:"Retención no encontrada"});
        if(w.status!=="reported")return json(res,409,{ok:false,error:"La retención ya no está pendiente de verificación"});
        const result=await createFinancialApprovalRequest(sql,{
          actionType:"withholding_verification",
          entityType:"merchant_withholding",
          entityId:withholdingId,
          amount:Number(w.total_amount||0),
          currency:"USD",
          payload:{settlement_id:w.settlement_id,merchant_id:w.merchant_id},
          requestNote:req.body?.note||null,
          requestedBy:principal.adminUserId,
          requestedByName:principal.displayName
        });
        if(result.code!=="ok"){
          return json(res,409,{ok:false,error:result.code==="maker_not_allowed"?"Tu usuario no tiene permiso para crear solicitudes financieras":"No se pudo crear la aprobación de retención",detail:result});
        }
        await auditFinancialRequest(sql,{
          principal,request:result.request,action:"financial_approval.requested",
          metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
        });
        return json(res,200,{ok:true,approvalRequired:true,result});
      }

      const result=await reviewMerchantWithholding(sql,{
        withholdingId,
        decision:"reject",
        actorId:principal.adminUserId,
        rejectionReason
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="not_found"?"Retención no encontrada":"La retención ya fue resuelta",detail:result});
      }
      const w=result.withholding;
      await sql.query(
        `INSERT INTO revale.audit_events (
           merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ($1,'revale_admin',$2,'withholding.rejected','merchant_withholding',$3,$4::jsonb)`,
        [
          w.merchant_id||null,principal.adminUserId,w.id,
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

    if(req.method==="GET" && action==="safeguarding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const control=await safeguardingControl(sql);
      return json(res,200,{ok:true,control});
    }

    if(req.method==="POST" && action==="treasury-account"){
      if(!requireRoles(["superadmin","finance"]))return;
      const result=await upsertTreasuryAccount(sql,{
        id:req.body?.id||null,
        bankName:req.body?.bank_name,
        accountName:req.body?.account_name,
        accountNumberLast4:req.body?.account_number_last4,
        purpose:req.body?.purpose,
        currency:req.body?.currency||"USD",
        isPrimary:Boolean(req.body?.is_primary),
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={fields_required:"Completa banco y nombre de cuenta",invalid_purpose:"Tipo de cuenta inválido"};
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo guardar la cuenta",detail:result});
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'treasury.account_upserted','treasury_bank_account',$2,$3::jsonb)`,
        [
          principal.adminUserId,result.account.id,
          JSON.stringify({
            bankName:result.account.bank_name,purpose:result.account.purpose,
            isPrimary:result.account.is_primary,last4:result.account.account_number_last4
          })
        ]
      );
      return json(res,200,{ok:true,account:result.account,control:await safeguardingControl(sql)});
    }

    if(req.method==="POST" && action==="treasury-balance"){
      if(!requireRoles(["superadmin","finance"]))return;
      const result=await recordTreasuryBalance(sql,{
        accountId:String(req.body?.account_id||""),
        balance:req.body?.balance,
        availableBalance:req.body?.available_balance,
        asOf:req.body?.as_of,
        source:req.body?.source||"manual",
        statementReference:req.body?.statement_reference,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          account_not_found:"Cuenta de tesorería no encontrada",
          account_inactive:"La cuenta está inactiva",
          invalid_balance:"Ingresa un saldo válido",
          invalid_available_balance:"Ingresa un saldo disponible válido",
          invalid_as_of:"Ingresa la fecha y hora del saldo"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo registrar el saldo",detail:result});
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'treasury.balance_recorded','treasury_bank_balance',$2,$3::jsonb)`,
        [
          principal.adminUserId,result.snapshot.id,
          JSON.stringify({
            accountId:result.snapshot.bank_account_id,balance:result.snapshot.balance,
            availableBalance:result.snapshot.available_balance,asOf:result.snapshot.as_of
          })
        ]
      );
      return json(res,200,{ok:true,snapshot:result.snapshot,control:await safeguardingControl(sql)});
    }

    if(req.method==="POST" && action==="safeguarding-enforcement"){
      if(!requireRoles(["superadmin","finance"]))return;
      const result=await setSafeguardingEnforcement(sql,{
        enabled:Boolean(req.body?.enabled),
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        return json(res,409,{
          ok:false,
          error:"No se puede activar enforcement hasta tener cuentas, saldos vigentes y cobertura de al menos 100%",
          detail:result
        });
      }
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,$2,'safeguarding_settings','default',$3::jsonb)`,
        [
          principal.adminUserId,
          req.body?.enabled?"safeguarding.enforcement_enabled":"safeguarding.enforcement_disabled",
          JSON.stringify({enabled:Boolean(req.body?.enabled)})
        ]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="treasury-transfer"){
      if(!requireRoles(["superadmin","finance"]))return;
      const transferType=String(req.body?.transfer_type||"");
      const amount=Number(req.body?.amount||0);
      const bankReference=String(req.body?.bank_reference||"").trim().slice(0,160);
      const bankPostedOn=String(req.body?.bank_posted_on||"");
      const fromAccountId=req.body?.from_account_id?String(req.body.from_account_id):null;
      const toAccountId=req.body?.to_account_id?String(req.body.to_account_id):null;
      if(!["safeguarding_topup","excess_sweep"].includes(transferType)){
        return json(res,400,{ok:false,error:"Tipo de transferencia inválido"});
      }
      if(!(amount>0)||!bankReference||!/^\d{4}-\d{2}-\d{2}$/.test(bankPostedOn)){
        return json(res,400,{ok:false,error:"Completa monto, referencia y fecha bancaria"});
      }
      const actionType=transferType==="safeguarding_topup"?"safeguarding_topup":"safeguarding_sweep";
      const result=await createFinancialApprovalRequest(sql,{
        actionType,
        entityType:"treasury_transfer",
        entityId:transferType+":"+bankReference+":"+bankPostedOn,
        amount,
        currency:"USD",
        payload:{
          transfer_type:transferType,bank_reference:bankReference,
          bank_posted_on:bankPostedOn,from_account_id:fromAccountId,to_account_id:toAccountId
        },
        requestNote:req.body?.note||null,
        requestedBy:principal.adminUserId,
        requestedByName:principal.displayName
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="maker_not_allowed"?"Tu usuario no tiene permiso para crear solicitudes financieras":"No se pudo crear la aprobación de tesorería",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,action:"financial_approval.requested",
        metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
      });
      return json(res,200,{ok:true,approvalRequired:true,result});
    }

    if(req.method==="POST" && action==="bank-statement-preview"){
      if(!requireRoles(["superadmin","finance"]))return;
      try{
        const result=await previewBankStatement({
          filename:req.body?.filename,
          text:req.body?.text||null,
          dataBase64:req.body?.data_base64||null
        });
        if(result.code!=="ok")return json(res,409,{ok:false,error:"No se encontraron filas utilizables en el archivo",detail:result});
        return json(res,200,{ok:true,preview:result});
      }catch(error){
        const code=String(error?.message||error);
        const messages={
          FILE_TOO_LARGE:"El archivo supera el máximo de 3 MB",
          XLSX_DATA_REQUIRED:"No se recibió el contenido XLSX",
          XLSX_NO_SHEET:"El archivo XLSX no contiene hojas"
        };
        return json(res,400,{ok:false,error:messages[code]||"No se pudo leer el extracto bancario"});
      }
    }

    if(req.method==="POST" && action==="bank-statement-import"){
      if(!requireRoles(["superadmin","finance"]))return;
      try{
        const result=await importBankStatement(sql,{
          treasuryAccountId:String(req.body?.treasury_account_id||""),
          filename:req.body?.filename,
          text:req.body?.text||null,
          dataBase64:req.body?.data_base64||null,
          mapping:req.body?.mapping||{},
          actorId:principal.adminUserId
        });
        if(result.code!=="ok"){
          const messages={
            account_not_found:"Cuenta de tesorería no encontrada",
            account_inactive:"La cuenta de tesorería está inactiva",
            empty:"El archivo está vacío",
            date_column_required:"Selecciona la columna de fecha",
            amount_column_required:"Selecciona monto o columnas débito/crédito",
            no_valid_rows:"No se encontraron movimientos con fecha y monto válidos"
          };
          return json(res,409,{ok:false,error:messages[result.code]||"No se pudo importar el extracto",detail:result});
        }

        let balanceSnapshot=null;
        if(req.body?.update_balance && result.closingBalance && !result.idempotent){
          const bookingDate=result.closingBalance.bookingDate;
          const balanceResult=await recordTreasuryBalance(sql,{
            accountId:String(req.body?.treasury_account_id||""),
            balance:result.closingBalance.balance,
            availableBalance:result.closingBalance.balance,
            asOf:bookingDate+"T23:59:59-05:00",
            source:"bank_import",
            statementReference:result.closingBalance.reference,
            actorId:principal.adminUserId
          });
          if(balanceResult.code==="ok")balanceSnapshot=balanceResult.snapshot;
        }

        await sql.query(
          `INSERT INTO revale.audit_events (
             actor_type,actor_id,action,resource_type,resource_id,metadata
           ) VALUES ('revale_admin',$1,'bank_statement.imported','bank_statement_import',$2,$3::jsonb)`,
          [
            principal.adminUserId,result.importId||result.import?.id,
            JSON.stringify({
              filename:req.body?.filename||null,inserted:result.inserted||0,
              duplicates:result.duplicates||0,suggested:result.suggested||0,
              balanceUpdated:Boolean(balanceSnapshot)
            })
          ]
        );
        return json(res,200,{ok:true,result,balanceSnapshot,control:await safeguardingControl(sql)});
      }catch(error){
        const code=String(error?.message||error);
        const messages={
          FILE_TOO_LARGE:"El archivo supera el máximo de 3 MB",
          XLSX_DATA_REQUIRED:"No se recibió el contenido XLSX",
          XLSX_NO_SHEET:"El archivo XLSX no contiene hojas"
        };
        return json(res,400,{ok:false,error:messages[code]||"No se pudo importar el extracto bancario"});
      }
    }

    if(req.method==="GET" && action==="bank-statement-imports"){
      if(!requireRoles(["superadmin","finance"]))return;
      const items=await listBankStatementImports(sql,50);
      return json(res,200,{ok:true,items});
    }

    if(req.method==="GET" && action==="bank-statement-entries"){
      if(!requireRoles(["superadmin","finance"]))return;
      const items=await listBankStatementEntries(sql,{
        importId:req.query?.import_id?String(req.query.import_id):null,
        status:req.query?.status?String(req.query.status):null,
        limit:500
      });
      return json(res,200,{ok:true,items});
    }

    if(req.method==="POST" && action==="refresh-bank-matches"){
      if(!requireRoles(["superadmin","finance"]))return;
      const importId=String(req.body?.import_id||"");
      const result=await generateBankMatchSuggestions(sql,importId);
      return json(res,200,{ok:true,result});
    }

    if(req.method==="GET" && action==="bank-match-candidates"){
      if(!requireRoles(["superadmin","finance"]))return;
      const entryId=String(req.query?.id||"");
      const result=await bankMatchCandidatesForEntry(sql,entryId,30);
      if(result.code!=="ok")return json(res,404,{ok:false,error:"Movimiento bancario no encontrado"});
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="ignore-bank-entry"){
      if(!requireRoles(["superadmin","finance"]))return;
      const entryId=String(req.body?.id||"");
      const result=await ignoreBankStatementEntry(sql,{
        entryId,actorId:principal.adminUserId,reason:req.body?.reason
      });
      if(result.code!=="ok")return json(res,409,{ok:false,error:"El movimiento no puede ignorarse",detail:result});
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'bank_statement_entry.ignored','bank_statement_entry',$2,$3::jsonb)`,
        [principal.adminUserId,entryId,JSON.stringify({reason:req.body?.reason||null})]
      );
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="confirm-bank-match"){
      if(!requireRoles(["superadmin","finance"]))return;
      const entryId=String(req.body?.id||"");
      const entry=await getBankStatementEntry(sql,entryId);
      if(!entry)return json(res,404,{ok:false,error:"Movimiento bancario no encontrado"});
      if(entry.match_status==="matched"){
        return json(res,200,{ok:true,idempotent:true,entry});
      }

      const candidateType=String(req.body?.candidate_type||entry.suggested_type||"");
      const candidateId=String(req.body?.candidate_id||entry.suggested_id||"");
      if(!candidateType||!candidateId){
        return json(res,400,{ok:false,error:"Selecciona un match antes de confirmar"});
      }

      const absoluteAmount=Math.abs(Number(entry.amount||0));
      const bankReference=String(entry.bank_reference||("STATEMENT-"+entry.id)).slice(0,160);
      let matchedType=candidateType,matchedId=candidateId,matchMetadata={};

      if(candidateType==="funding_batch"){
        if(Number(entry.amount)<=0)return json(res,409,{ok:false,error:"Un fondeo debe corresponder a un ingreso bancario"});
        const result=await registerFundingReceipt(sql,{
          fundingBatchId:candidateId,
          amount:absoluteAmount,
          bankReference,
          bankPostedOn:entry.booking_date,
          treasuryAccountId:entry.treasury_account_id,
          actorId:principal.adminUserId
        });
        if(result.code!=="ok"){
          return json(res,409,{ok:false,error:"No se pudo aplicar el ingreso al fondeo",detail:result});
        }
        await emitAndPostAccountingEvent(sql,{
          eventType:"funding_cash_received",
          sourceType:"funding_receipt",
          sourceId:result.receipt.id,
          eventKey:"confirmed",
          amount:result.receipt.amount,
          currency:String(result.receipt.currency||"USD").trim(),
          employerId:result.receipt.employer_id,
          payload:{
            funding_batch_id:candidateId,
            bank_reference:result.receipt.bank_reference,
            bank_posted_on:result.receipt.bank_posted_on,
            bank_statement_entry_id:entry.id,
            confirmed_by:principal.adminUserId
          }
        });
        matchedType="funding_receipt";matchedId=result.receipt.id;
        matchMetadata={funding_batch_id:candidateId,created_from_statement:true};
      }else if(candidateType==="funding_receipt"){
        const [row]=await sql.query(
          `SELECT id,treasury_account_id,amount::float8 AS amount
           FROM revale.employer_funding_receipts WHERE id=$1 AND status='confirmed' LIMIT 1`,
          [candidateId]
        );
        if(!row||row.treasury_account_id!==entry.treasury_account_id||Math.abs(Number(row.amount)-absoluteAmount)>0.01){
          return json(res,409,{ok:false,error:"El fondeo registrado no coincide con cuenta/monto del extracto"});
        }
      }else if(candidateType==="funding_refund"){
        if(Number(entry.amount)>=0)return json(res,409,{ok:false,error:"Una devolución debe ser un débito bancario"});
        const [row]=await sql.query(
          `SELECT id,treasury_account_id,amount::float8 AS amount
           FROM revale.employer_funding_refunds WHERE id=$1 AND status='confirmed' LIMIT 1`,
          [candidateId]
        );
        if(!row||row.treasury_account_id!==entry.treasury_account_id||Math.abs(Number(row.amount)-absoluteAmount)>0.01){
          return json(res,409,{ok:false,error:"La devolución registrada no coincide con cuenta/monto del extracto"});
        }
      }else if(candidateType==="treasury_transfer"){
        const [row]=await sql.query(
          `SELECT id,from_account_id,to_account_id,amount::float8 AS amount
           FROM revale.treasury_internal_transfers WHERE id=$1 AND status='confirmed' LIMIT 1`,
          [candidateId]
        );
        if(!row||Math.abs(Number(row.amount)-absoluteAmount)>0.01){
          return json(res,409,{ok:false,error:"La transferencia interna no coincide con el monto del extracto"});
        }
        const expectedSign=row.to_account_id===entry.treasury_account_id?1:row.from_account_id===entry.treasury_account_id?-1:0;
        if(!expectedSign||Math.sign(Number(entry.amount))!==expectedSign){
          return json(res,409,{ok:false,error:"La transferencia no corresponde a esta cuenta o dirección"});
        }
      }else if(candidateType==="settlement_payout"){
        if(Number(entry.amount)>=0)return json(res,409,{ok:false,error:"Un payout debe corresponder a un débito bancario"});
        const [payout]=await sql.query(
          `SELECT p.id::text AS id,p.settlement_id,p.source_treasury_account_id,
                  p.amount::float8 AS amount,p.currency,p.status,s.merchant_id
           FROM revale.settlement_payouts p
           JOIN revale.settlements s ON s.id=p.settlement_id
           WHERE p.id::text=$1
           LIMIT 1`,
          [candidateId]
        );
        if(!payout)return json(res,404,{ok:false,error:"Payout no encontrado"});
        if(payout.source_treasury_account_id!==entry.treasury_account_id||Math.abs(Number(payout.amount)-absoluteAmount)>0.01){
          return json(res,409,{ok:false,error:"El payout no coincide con cuenta/monto del extracto"});
        }

        let bankEvidenceOverride=false;
        if(["scheduled","processing"].includes(payout.status)){
          const paid=await markSettlementPaid(
            sql,payout.settlement_id,bankReference,principal.adminUserId,{bankEvidence:true}
          );
          if(paid.code!=="ok")return json(res,409,{ok:false,error:"No se pudo registrar el payout observado en banco",detail:paid});
          bankEvidenceOverride=Boolean(paid.bankEvidenceOverride);
          if(bankEvidenceOverride){
            await sql.query(
              `INSERT INTO revale.audit_events (
                 merchant_id,actor_type,actor_id,action,resource_type,resource_id,metadata
               ) VALUES ($1,'revale_admin',$2,'safeguarding.bank_evidence_override','settlement',$3,$4::jsonb)`,
              [
                payout.merchant_id,principal.adminUserId,payout.settlement_id,
                JSON.stringify({bankStatementEntryId:entry.id,coverageStatus:paid.safeguard?.status||null})
              ]
            );
          }
        }

        await emitAndPostAccountingEvent(sql,{
          eventType:"merchant_payout_paid",
          sourceType:"settlement",
          sourceId:payout.settlement_id,
          eventKey:"paid",
          amount:Number(payout.amount||0),
          currency:String(payout.currency||"USD").trim(),
          merchantId:payout.merchant_id,
          settlementId:payout.settlement_id,
          payload:{
            payout_reference:bankReference,payout_id:payout.id,payout_amount:Number(payout.amount||0),
            bank_statement_entry_id:entry.id,bank_evidence_override:bankEvidenceOverride
          }
        });

        const reconciliation=await reconcileSettlementPayout(sql,{
          settlementId:payout.settlement_id,
          bankReference,
          bankPostedOn:entry.booking_date,
          bankAmount:absoluteAmount,
          actorId:principal.adminUserId
        });
        if(reconciliation.code!=="ok"){
          return json(res,409,{ok:false,error:"El pago se identificó, pero no pudo conciliarse",detail:reconciliation});
        }
        matchMetadata={settlement_id:payout.settlement_id,reconciliation_id:reconciliation.reconciliation?.id||null};
      }else{
        return json(res,400,{ok:false,error:"Tipo de match no soportado"});
      }

      const matched=await markBankStatementEntryMatched(sql,{
        entryId,matchedType,matchedId,actorId:principal.adminUserId,
        metadata:{...matchMetadata,confirmed_candidate_type:candidateType,confirmed_candidate_id:candidateId}
      });
      await sql.query(
        `INSERT INTO revale.audit_events (
           actor_type,actor_id,action,resource_type,resource_id,metadata
         ) VALUES ('revale_admin',$1,'bank_statement_entry.matched','bank_statement_entry',$2,$3::jsonb)`,
        [
          principal.adminUserId,entryId,
          JSON.stringify({candidateType,candidateId,matchedType,matchedId,amount:entry.amount,bookingDate:entry.booking_date})
        ]
      );
      return json(res,200,{ok:true,matched,control:await safeguardingControl(sql)});
    }

    if(req.method==="GET" && action==="funding-queue"){
      const rows=await sql.query(
        `SELECT
           fb.id,fb.employer_id,e.name AS employer_name,fb.program_id,bp.name AS program_name,
           fb.external_reference,fb.amount::float8 AS amount,fb.currency,fb.status,fb.received_at,fb.created_at,
           COUNT(fbi.id)::int AS employee_count,
           COALESCE(SUM(fbi.amount),0)::float8 AS item_total,
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
             WHERE i.funding_batch_id=fb.id AND i.status='allocated'
           ),0)::float8 AS allocated_amount
         FROM revale.funding_batches fb
         JOIN revale.employers e ON e.id=fb.employer_id
         LEFT JOIN revale.benefit_programs bp ON bp.id=fb.program_id
         LEFT JOIN revale.funding_batch_items fbi ON fbi.funding_batch_id=fb.id
         GROUP BY fb.id,e.name,bp.name
         ORDER BY CASE fb.status WHEN 'pending' THEN 0 WHEN 'received' THEN 1 WHEN 'allocated' THEN 2 ELSE 3 END,fb.created_at DESC
         LIMIT 100`
      );
      const items=rows.map(x=>{
        const received=Number(x.received_amount||0);
        const refunded=Number(x.refunded_amount||0);
        const allocated=Number(x.allocated_amount||0);
        const prepared=Number(x.item_total||0);
        const cashAvailable=Math.round((received-refunded-allocated+Number.EPSILON)*100)/100;
        const pendingAllocation=Math.round((prepared-allocated+Number.EPSILON)*100)/100;
        return {
          ...x,
          cash_available:cashAvailable,
          pending_allocation:pendingAllocation,
          funding_gap:Math.round((Math.max(pendingAllocation-cashAvailable,0)+Number.EPSILON)*100)/100,
          excess_after_allocation:Math.round((Math.max(cashAvailable-pendingAllocation,0)+Number.EPSILON)*100)/100
        };
      });
      return json(res,200,{ok:true,items});
    }

    if(req.method==="GET" && action==="treasury-control"){
      if(!requireRoles(["superadmin","finance"]))return;
      const control=await treasuryControl(sql);
      return json(res,200,{ok:true,control});
    }

    if(req.method==="POST" && action==="record-funding-receipt"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const amount=Number(req.body?.amount||0);
      const bankReference=String(req.body?.bank_reference||"").trim().slice(0,160);
      const bankPostedOn=String(req.body?.bank_posted_on||"");
      const result=await registerFundingReceipt(sql,{
        fundingBatchId:id,amount,bankReference,bankPostedOn,
        treasuryAccountId:req.body?.treasury_account_id||null,
        actorId:principal.adminUserId
      });
      if(result.code!=="ok"){
        const messages={
          not_found:"Fondeo no encontrado",
          invalid_status:"Este fondeo ya no acepta nuevos ingresos",
          invalid_amount:"Ingresa un monto bancario válido",
          reference_required:"Ingresa la referencia bancaria",
          date_required:"Ingresa la fecha del movimiento bancario",
          currency_mismatch:"La moneda del movimiento no coincide con el fondeo",
          duplicate_reference:"La referencia bancaria ya está aplicada a otro fondeo",
          treasury_account_not_found:"La cuenta de tesorería no existe",
          invalid_treasury_account:"Selecciona una cuenta activa de fondos de clientes",
          treasury_account_required:"Configura una cuenta segregada para registrar este ingreso"
        };
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo registrar el ingreso",detail:result});
      }
      await emitAndPostAccountingEvent(sql,{
          eventType:"funding_cash_received",
          sourceType:"funding_receipt",
          sourceId:result.receipt.id,
          eventKey:"confirmed",
          amount:result.receipt.amount,
          currency:String(result.receipt.currency||"USD").trim(),
          employerId:result.receipt.employer_id,
          payload:{
            funding_batch_id:id,
            bank_reference:result.receipt.bank_reference,
            bank_posted_on:result.receipt.bank_posted_on,
            confirmed_by:principal.adminUserId
          }
        });
      if(!result.idempotent){
        await sql.query(
          `INSERT INTO revale.audit_events (
             employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata
           ) VALUES ($1,'revale_admin',$2,'funding.cash_received','employer_funding_receipt',$3,$4::jsonb)`,
          [
            result.receipt.employer_id,principal.adminUserId,result.receipt.id,
            JSON.stringify({
              fundingBatchId:id,amount:result.receipt.amount,
              bankReference:result.receipt.bank_reference,ready:result.ready
            })
          ]
        );
      }
      return json(res,200,{ok:true,result});
    }

    if(req.method==="POST" && action==="refund-funding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const amount=Number(req.body?.amount||0);
      const bankReference=String(req.body?.bank_reference||"").trim().slice(0,160);
      const bankPostedOn=String(req.body?.bank_posted_on||"");
      const reason=String(req.body?.reason||"").trim().slice(0,500);
      const treasuryAccountId=String(req.body?.treasury_account_id||"");
      const summary=await fundingBatchMoneySummary(sql,id);
      if(!summary)return json(res,404,{ok:false,error:"Fondeo no encontrado"});
      if(!(amount>0))return json(res,400,{ok:false,error:"Ingresa un monto de devolución válido"});
      if(amount>Number(summary.cash_available||0)+0.00001){
        return json(res,409,{ok:false,error:"La devolución supera los fondos empresariales no asignados"});
      }
      if(!bankReference||!/^\d{4}-\d{2}-\d{2}$/.test(bankPostedOn)||!treasuryAccountId){
        return json(res,400,{ok:false,error:"Completa cuenta de salida, referencia y fecha bancaria"});
      }
      const result=await createFinancialApprovalRequest(sql,{
        actionType:"employer_refund",
        entityType:"funding_batch",
        entityId:id,
        amount,
        currency:String(summary.currency||"USD").trim(),
        payload:{
          bank_reference:bankReference,bank_posted_on:bankPostedOn,
          reason:reason||null,treasury_account_id:treasuryAccountId,
          employer_id:summary.employer_id
        },
        requestNote:reason||null,
        requestedBy:principal.adminUserId,
        requestedByName:principal.displayName
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="maker_not_allowed"?"Tu usuario no tiene permiso para crear solicitudes financieras":"No se pudo crear la solicitud de devolución",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,action:"financial_approval.requested",
        metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
      });
      return json(res,200,{ok:true,approvalRequired:true,result});
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
      const summary=await fundingBatchMoneySummary(sql,id);
      if(!summary)return json(res,404,{ok:false,error:"Fondeo no encontrado"});
      if(summary.status!=="received"){
        return json(res,409,{ok:false,error:"Primero confirma que el dinero ingresó al banco"});
      }
      const amount=Number(summary.pending_allocation||0);
      if(!(amount>0))return json(res,409,{ok:false,error:"El fondeo no tiene asignaciones pendientes"});
      if(Number(summary.cash_available||0)+0.00001<amount){
        return json(res,409,{ok:false,error:"Los fondos bancarios verificados no cubren las asignaciones"});
      }
      const result=await createFinancialApprovalRequest(sql,{
        actionType:"funding_allocation",
        entityType:"funding_batch",
        entityId:id,
        amount,
        currency:String(summary.currency||"USD").trim(),
        payload:{employer_id:summary.employer_id,program_id:summary.program_id},
        requestNote:req.body?.note||null,
        requestedBy:principal.adminUserId,
        requestedByName:principal.displayName
      });
      if(result.code!=="ok"){
        return json(res,409,{ok:false,error:result.code==="maker_not_allowed"?"Tu usuario no tiene permiso para crear solicitudes financieras":"No se pudo crear la aprobación del fondeo",detail:result});
      }
      await auditFinancialRequest(sql,{
        principal,request:result.request,action:"financial_approval.requested",
        metadata:{eligibleApprovers:result.eligibleApprovers,hasEnoughApprovers:result.hasEnoughApprovers}
      });
      return json(res,200,{ok:true,approvalRequired:true,result});
    }

    if(req.method==="POST" && action==="reject-funding"){
      if(!requireRoles(["superadmin","finance"]))return;
      const id=String(req.body?.id||"");
      const reason=String(req.body?.reason||"").trim().slice(0,400);
      const summary=await fundingBatchMoneySummary(sql,id);
      if(!summary)return json(res,404,{ok:false,error:"Fondeo no encontrado"});
      if(Number(summary.received_amount||0)-Number(summary.refunded_amount||0)>0.00001){
        return json(res,409,{ok:false,error:"Este fondeo ya tiene dinero recibido. Devuelve primero los fondos no asignados antes de cancelarlo."});
      }
      const [row]=await sql.query(
        `UPDATE revale.funding_batches
         SET status='cancelled',updated_at=now(),metadata=metadata||jsonb_build_object('rejection_reason',$2,'rejected_by',$3)
         WHERE id=$1 AND status='pending'
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
