function journalIdForEvent(eventId){
  return "jrnl_evt_" + String(eventId);
}

function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}

function eventLines(event){
  const amount=round2(event.amount);
  const p=event.payload||{};

  if(event.event_type==="funding_received"){
    return {
      description:"Recepción y acreditación de fondos de beneficio",
      lines:[
        {account_id:"gl_cash_client_funds",debit:amount,credit:0,description:"Fondos recibidos de empresa"},
        {account_id:"gl_employee_benefit_liability",debit:0,credit:amount,description:"Obligación por beneficios acreditados"}
      ]
    };
  }

  if(event.event_type==="funding_cash_received"){
    return {
      description:"Recepción bancaria de fondos empresariales",
      lines:[
        {account_id:"gl_cash_client_funds",debit:amount,credit:0,description:"Ingreso de fondos de empresa a cuenta de clientes"},
        {account_id:"gl_employer_prefund_liability",debit:0,credit:amount,description:"Fondos empresariales pendientes de asignación"}
      ]
    };
  }

  if(event.event_type==="funding_allocated"){
    return {
      description:"Liberación de fondeo a saldos de colaboradores",
      lines:[
        {account_id:"gl_employer_prefund_liability",debit:amount,credit:0,description:"Aplicación de fondos empresariales verificados"},
        {account_id:"gl_employee_benefit_liability",debit:0,credit:amount,description:"Obligación por beneficios acreditados a colaboradores"}
      ]
    };
  }

  if(event.event_type==="funding_refunded"){
    return {
      description:"Devolución de fondos empresariales no asignados",
      lines:[
        {account_id:"gl_employer_prefund_liability",debit:amount,credit:0,description:"Disminución de fondos empresariales pendientes"},
        {account_id:"gl_cash_client_funds",debit:0,credit:amount,description:"Salida de fondos devueltos a la empresa"}
      ]
    };
  }

  if(event.event_type==="redemption_approved"){
    return {
      description:"Redención aprobada en comercio aliado",
      lines:[
        {account_id:"gl_employee_benefit_liability",debit:amount,credit:0,description:"Disminución obligación con colaborador"},
        {account_id:"gl_merchant_payable",debit:0,credit:amount,description:"Obligación bruta con comercio"}
      ]
    };
  }

  if(event.event_type==="redemption_reversed"){
    return {
      description:"Reverso de redención",
      lines:[
        {account_id:"gl_merchant_payable",debit:amount,credit:0,description:"Reverso de obligación con comercio"},
        {account_id:"gl_employee_benefit_liability",debit:0,credit:amount,description:"Restitución de beneficio al colaborador"}
      ]
    };
  }

  if(event.event_type==="settled_redemption_reversed"){
    const fee=round2(p.fee_reversal);
    const tax=round2(p.tax_reversal);
    const merchantRecovery=round2(p.merchant_recovery);
    const lines=[];
    if(merchantRecovery>0)lines.push({account_id:"gl_merchant_payable",debit:merchantRecovery,credit:0,description:"Saldo recuperable del comercio por reverso post-cierre"});
    if(fee>0)lines.push({account_id:"gl_fee_revenue",debit:fee,credit:0,description:"Reverso de ingreso por servicio ReVale"});
    if(tax>0)lines.push({account_id:"gl_vat_payable",debit:tax,credit:0,description:"Reverso de IVA generado sobre fee"});
    lines.push({account_id:"gl_employee_benefit_liability",debit:0,credit:amount,description:"Restitución de beneficio al colaborador"});
    return {description:"Reverso de redención posterior al cierre",lines};
  }

  if(event.event_type==="settlement_closed"){
    const fee=round2(p.fee_amount);
    const tax=round2(p.tax_amount);
    const total=round2(fee+tax);
    if(total<=0) return {description:"Cierre de liquidación sin comisión",lines:[]};
    const lines=[
      {account_id:"gl_merchant_payable",debit:total,credit:0,description:"Retención de fee e IVA del settlement"}
    ];
    if(fee>0)lines.push({account_id:"gl_fee_revenue",debit:0,credit:fee,description:"Ingreso por servicio ReVale"});
    if(tax>0)lines.push({account_id:"gl_vat_payable",debit:0,credit:tax,description:"IVA generado sobre fee ReVale"});
    return {description:"Reconocimiento de comisión al cierre de liquidación",lines};
  }

  if(event.event_type==="merchant_withholding_verified"){
    if(amount<=0) return {description:"Retención tributaria sin valor",lines:[]};
    return {
      description:"Reconocimiento de retención tributaria del comercio",
      lines:[
        {account_id:"gl_tax_withholding_receivable",debit:amount,credit:0,description:"Crédito tributario por retención recibida"},
        {account_id:"gl_merchant_payable",debit:0,credit:amount,description:"Mayor valor a liquidar al comercio por retención"}
      ]
    };
  }

  if(event.event_type==="merchant_withholding_credit_reversed"){
    if(amount<=0) return {description:"Ajuste de retención sin valor",lines:[]};
    return {
      description:"Reverso de crédito tributario por retención",
      lines:[
        {account_id:"gl_merchant_payable",debit:amount,credit:0,description:"Saldo recuperable del comercio por retención anulada o ajustada"},
        {account_id:"gl_tax_withholding_receivable",debit:0,credit:amount,description:"Disminución del crédito tributario por retención"}
      ]
    };
  }

  if(event.event_type==="safeguarding_topup"){
    return {
      description:"Top-up de fondos propios a cuenta segregada",
      lines:[
        {account_id:"gl_cash_client_funds",debit:amount,credit:0,description:"Ingreso de fondos propios a cuenta de clientes"},
        {account_id:"gl_cash_operating",debit:0,credit:amount,description:"Salida de caja propia hacia safeguarding"}
      ]
    };
  }

  if(event.event_type==="safeguarding_sweep"){
    return {
      description:"Barrido de excedente desde cuenta segregada",
      lines:[
        {account_id:"gl_cash_operating",debit:amount,credit:0,description:"Ingreso de excedente a caja propia"},
        {account_id:"gl_cash_client_funds",debit:0,credit:amount,description:"Salida de fondos no requeridos para safeguarding"}
      ]
    };
  }

  if(event.event_type==="merchant_payout_paid"){
    return {
      description:"Pago de liquidación a comercio aliado",
      lines:[
        {account_id:"gl_merchant_payable",debit:amount,credit:0,description:"Cancelación de obligación con comercio"},
        {account_id:"gl_cash_client_funds",debit:0,credit:amount,description:"Salida de fondos hacia comercio"}
      ]
    };
  }

  return null;
}

export async function emitAccountingEvent(sql,{
  eventType,sourceType,sourceId,eventKey="default",amount=null,currency="USD",
  merchantId=null,employerId=null,personId=null,benefitAccountId=null,
  settlementId=null,transactionId=null,payload={}
}){
  const [row]=await sql.query(
    `INSERT INTO revale.accounting_events (
       event_type,source_type,source_id,event_key,amount,currency,
       merchant_id,employer_id,person_id,benefit_account_id,settlement_id,transaction_id,payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (source_type,source_id,event_key)
     DO UPDATE SET payload=revale.accounting_events.payload||EXCLUDED.payload
     RETURNING *`,
    [
      eventType,sourceType,String(sourceId),eventKey,amount,currency,
      merchantId,employerId,personId,benefitAccountId,settlementId,transactionId,
      JSON.stringify(payload||{})
    ]
  );
  return row;
}

export async function postAccountingEvent(sql,eventId){
  const [event]=await sql.query(
    `SELECT * FROM revale.accounting_events WHERE id=$1 LIMIT 1`,
    [eventId]
  );
  if(!event)return {code:"not_found"};
  if(event.status==="posted")return {code:"ok",idempotent:true};

  const mapped=eventLines(event);
  if(!mapped){
    await sql.query(
      "UPDATE revale.accounting_events SET status='ignored',error_message='Unsupported event type' WHERE id=$1",
      [eventId]
    );
    return {code:"ignored"};
  }
  if(!mapped.lines.length){
    await sql.query(
      "UPDATE revale.accounting_events SET status='posted',posted_at=now(),error_message=NULL WHERE id=$1",
      [eventId]
    );
    return {code:"ok",empty:true};
  }

  const debit=round2(mapped.lines.reduce((a,x)=>a+Number(x.debit||0),0));
  const credit=round2(mapped.lines.reduce((a,x)=>a+Number(x.credit||0),0));
  if(debit!==credit || debit<=0){
    await sql.query(
      "UPDATE revale.accounting_events SET status='error',error_message=$2 WHERE id=$1",
      [eventId,"Unbalanced journal"]
    );
    return {code:"unbalanced",debit,credit};
  }

  const journalId=journalIdForEvent(event.id);
  const lines=mapped.lines.map((line,index)=>({
    line_no:index+1,
    account_id:line.account_id,
    debit:round2(line.debit),
    credit:round2(line.credit),
    description:line.description||mapped.description
  }));

  try{
    await sql.query(
      `WITH journal AS (
         INSERT INTO revale.gl_journals (
           id,source_type,source_id,event_key,journal_date,currency,description,status,
           merchant_id,employer_id,person_id,settlement_id,transaction_id,metadata,posted_at
         ) VALUES (
           $1,$2,$3,$4,CURRENT_DATE,$5,$6,'posted',$7,$8,$9,$10,$11,$12::jsonb,now()
         )
         ON CONFLICT (source_type,source_id,event_key) DO NOTHING
         RETURNING id
       ),
       line_data AS (
         SELECT *
         FROM jsonb_to_recordset($13::jsonb)
         AS x(line_no integer,account_id text,debit numeric,credit numeric,description text)
       )
       INSERT INTO revale.gl_journal_lines (
         journal_id,line_no,account_id,debit,credit,
         merchant_id,employer_id,person_id,benefit_account_id,settlement_id,transaction_id,
         description,metadata
       )
       SELECT
         j.id,l.line_no,l.account_id,l.debit,l.credit,
         $7,$8,$9,$14,$10,$11,l.description,
         jsonb_build_object('accounting_event_id',$15::text)
       FROM journal j CROSS JOIN line_data l`,
      [
        journalId,event.source_type,event.source_id,event.event_key,String(event.currency||"USD").trim(),
        mapped.description,event.merchant_id,event.employer_id,event.person_id,event.settlement_id,event.transaction_id,
        JSON.stringify({accounting_event_id:event.id,event_type:event.event_type}),
        JSON.stringify(lines),event.benefit_account_id,event.id
      ]
    );

    const [journal]=await sql.query(
      `SELECT id FROM revale.gl_journals
       WHERE source_type=$1 AND source_id=$2 AND event_key=$3 LIMIT 1`,
      [event.source_type,event.source_id,event.event_key]
    );
    if(!journal)throw new Error("GL_JOURNAL_NOT_CREATED");

    await sql.query(
      "UPDATE revale.accounting_events SET status='posted',posted_at=now(),error_message=NULL WHERE id=$1",
      [event.id]
    );
    return {code:"ok",journal_id:journal.id};
  }catch(error){
    await sql.query(
      "UPDATE revale.accounting_events SET status='error',error_message=$2 WHERE id=$1",
      [event.id,String(error?.message||error).slice(0,500)]
    );
    throw error;
  }
}

export async function emitAndPostAccountingEvent(sql,args){
  const event=await emitAccountingEvent(sql,args);
  try{
    const posting=await postAccountingEvent(sql,event.id);
    return {event,posting};
  }catch(error){
    console.error("ReVale accounting posting error",error);
    return {event,posting:{code:"error",error:String(error?.message||error)}};
  }
}

export async function processPendingAccountingEvents(sql,limit=100){
  const rows=await sql.query(
    `SELECT id FROM revale.accounting_events
     WHERE status IN ('pending','error')
     ORDER BY created_at,id
     LIMIT $1`,
    [Math.max(1,Math.min(Number(limit)||100,500))]
  );
  const results=[];
  for(const row of rows){
    try{results.push({id:row.id,...await postAccountingEvent(sql,row.id)})}
    catch(error){results.push({id:row.id,code:"error",error:String(error?.message||error)})}
  }
  return results;
}
