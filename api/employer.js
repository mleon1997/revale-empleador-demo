import { getSql } from "../lib/revale-db.js";
import { getEmployerPrincipal, roleAllowed } from "../lib/revale-auth.js";
import { createFundingBatch, prepareFundingItems } from "../lib/revale-benefits.js";
import { ensureFundingTreasurySchema } from "../lib/revale-admin-funding.js";

function json(res, code, body) {
  res.status(code)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .json(body);
}

function makeId(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  try {
    const sql = await getSql();
    await ensureFundingTreasurySchema(sql);
    const principal = await getEmployerPrincipal(sql, req);
    if (!principal) return json(res, 401, { ok:false, error:"Sesión requerida" });

    const requireRoles = (roles) => {
      if (!roleAllowed(principal, roles)) {
        json(res, 403, { ok:false, error:"No tienes permisos para esta acción" });
        return false;
      }
      return true;
    };

    if (req.method === "GET" && action === "overview") {
      const [employer] = await sql.query(
        `SELECT id,name,tax_id,slug,active
         FROM revale.employers
         WHERE id=$1
         LIMIT 1`,
        [principal.employerId]
      );

      const [stats] = await sql.query(
        `SELECT
           COUNT(DISTINCT bp.id) FILTER (WHERE bp.active=true)::int AS active_programs,
           COUNT(DISTINCT ee.person_id) FILTER (WHERE ee.status='active')::int AS active_employees,
           COALESCE(SUM(DISTINCT CASE WHEN ba.id IS NOT NULL THEN ba.balance ELSE 0 END),0)::float8 AS visible_balance
         FROM revale.benefit_programs bp
         LEFT JOIN revale.employee_enrollments ee ON ee.program_id=bp.id
         LEFT JOIN revale.cards c ON c.person_id=ee.person_id AND c.active=true
         LEFT JOIN revale.benefit_accounts ba ON ba.card_number=c.card_number
         WHERE bp.employer_id=$1`,
        [principal.employerId]
      );

      const [funding] = await sql.query(
        `SELECT
           COALESCE(SUM(fb.amount) FILTER (WHERE fb.status='pending'),0)::float8 AS pending_funding,
           COALESCE(SUM(fb.amount) FILTER (WHERE fb.status='received'),0)::float8 AS received_funding,
           COALESCE(SUM(fb.amount) FILTER (WHERE fb.status='allocated'),0)::float8 AS allocated_funding,
           COALESCE((
             SELECT SUM(r.amount)
             FROM revale.employer_funding_receipts r
             WHERE r.employer_id=$1 AND r.status='confirmed'
           ),0)::float8 AS cash_received,
           COALESCE((
             SELECT SUM(rf.amount)
             FROM revale.employer_funding_refunds rf
             WHERE rf.employer_id=$1 AND rf.status='confirmed'
           ),0)::float8 AS cash_refunded
         FROM revale.funding_batches fb
         WHERE fb.employer_id=$1`,
        [principal.employerId]
      );

      return json(res, 200, { ok:true, employer, stats:stats||{}, funding:funding||{} });
    }

    if (req.method === "GET" && action === "programs") {
      const rows = await sql.query(
        `SELECT
           bp.id,bp.name,bp.benefit_type,bp.currency,
           bp.allocation_amount::float8 AS allocation_amount,
           bp.allocation_frequency,bp.rollover_policy,
           bp.valid_from,bp.valid_until,bp.active,
           COUNT(ee.id) FILTER (WHERE ee.status='active')::int AS active_employees
         FROM revale.benefit_programs bp
         LEFT JOIN revale.employee_enrollments ee ON ee.program_id=bp.id
         WHERE bp.employer_id=$1
         GROUP BY bp.id
         ORDER BY bp.created_at DESC`,
        [principal.employerId]
      );
      return json(res, 200, { ok:true, programs:rows });
    }

    if (req.method === "GET" && action === "employees") {
      const programId = req.query?.program_id ? String(req.query.program_id) : null;
      const rows = await sql.query(
        `SELECT
           p.id AS person_id,p.first_name,p.last_name,p.email,p.person_identification,
           ee.id AS enrollment_id,ee.program_id,ee.status,ee.starts_on,ee.ends_on,
           bp.name AS program_name,
           ba.id AS account_id,ba.card_number,ba.balance::float8 AS balance
         FROM revale.employee_enrollments ee
         JOIN revale.benefit_programs bp ON bp.id=ee.program_id
         JOIN revale.persons p ON p.id=ee.person_id
         LEFT JOIN revale.cards c ON c.person_id=p.id AND c.active=true
         LEFT JOIN revale.benefit_accounts ba ON ba.card_number=c.card_number
         WHERE bp.employer_id=$1
           AND ($2::text IS NULL OR ee.program_id=$2)
         ORDER BY p.first_name,p.last_name`,
        [principal.employerId, programId]
      );
      return json(res, 200, { ok:true, employees:rows });
    }

    if (req.method === "GET" && action === "rules") {
      const programId = String(req.query?.program_id || "");
      const [program] = await sql.query(
        "SELECT id FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2 LIMIT 1",
        [programId, principal.employerId]
      );
      if (!program) return json(res,404,{ok:false,error:"Programa no encontrado"});
      const rows = await sql.query(
        `SELECT id,rule_type,rule_value,priority,active,created_at,updated_at
         FROM revale.benefit_rules
         WHERE program_id=$1
         ORDER BY priority,id`,
        [programId]
      );
      return json(res,200,{ok:true,rules:rows});
    }

    if (req.method === "GET" && action === "merchant-catalog") {
      const rows = await sql.query(
        `SELECT id,name,slug
         FROM revale.merchants
         WHERE active=true
         ORDER BY name`
      );
      return json(res,200,{ok:true,merchants:rows});
    }

    if (req.method === "GET" && action === "funding") {
      const rows = await sql.query(
        `SELECT
           fb.id,fb.program_id,bp.name AS program_name,fb.external_reference,
           fb.amount::float8 AS amount,fb.currency,fb.status,fb.received_at,fb.created_at,
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
         LEFT JOIN revale.benefit_programs bp ON bp.id=fb.program_id
         LEFT JOIN revale.funding_batch_items fbi ON fbi.funding_batch_id=fb.id
         WHERE fb.employer_id=$1
         GROUP BY fb.id,bp.name
         ORDER BY fb.created_at DESC
         LIMIT 50`,
        [principal.employerId]
      );
      return json(res,200,{ok:true,funding:rows.map(x=>{
        const cashNet=Math.round((Number(x.received_amount||0)-Number(x.refunded_amount||0)+Number.EPSILON)*100)/100;
        const pending=Math.round((Math.max(Number(x.item_total||0)-Number(x.allocated_amount||0),0)+Number.EPSILON)*100)/100;
        return {
          ...x,
          cash_net:cashNet,
          pending_allocation:pending,
          funding_gap:Math.round((Math.max(pending-cashNet,0)+Number.EPSILON)*100)/100,
          unallocated_cash:Math.round((Math.max(cashNet-Number(x.allocated_amount||0),0)+Number.EPSILON)*100)/100
        };
      })});
    }

    if (req.method === "POST" && action === "update-program") {
      if (!requireRoles(["admin","hr"])) return;
      const programId=String(req.body?.program_id||"");
      const allocationAmount=Number(req.body?.allocation_amount);
      const frequency=String(req.body?.allocation_frequency||"monthly");
      const rollover=String(req.body?.rollover_policy||"no_rollover");
      if (!Number.isFinite(allocationAmount) || allocationAmount <= 0) {
        return json(res,400,{ok:false,error:"Monto de asignación inválido"});
      }
      if (!["one_time","weekly","biweekly","monthly","custom"].includes(frequency)) {
        return json(res,400,{ok:false,error:"Frecuencia inválida"});
      }
      if (!["no_rollover","full_rollover","capped_rollover"].includes(rollover)) {
        return json(res,400,{ok:false,error:"Política de acumulación inválida"});
      }
      const [row]=await sql.query(
        `UPDATE revale.benefit_programs
         SET allocation_amount=$1,allocation_frequency=$2,rollover_policy=$3,updated_at=now()
         WHERE id=$4 AND employer_id=$5
         RETURNING id,name,allocation_amount::float8 AS allocation_amount,allocation_frequency,rollover_policy`,
        [Math.round(allocationAmount*100)/100,frequency,rollover,programId,principal.employerId]
      );
      if(!row)return json(res,404,{ok:false,error:"Programa no encontrado"});
      await sql.query(
        `INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'employer_user',$2,'program.updated','benefit_program',$3,$4::jsonb)`,
        [principal.employerId,principal.employerUserId,programId,JSON.stringify({allocationAmount,frequency,rollover})]
      );
      return json(res,200,{ok:true,program:row});
    }

    if (req.method === "POST" && action === "upsert-rule") {
      if (!requireRoles(["admin","hr"])) return;
      const programId=String(req.body?.program_id||"");
      const ruleType=String(req.body?.rule_type||"");
      const ruleValue=req.body?.rule_value||{};
      const allowed=["max_transaction_amount","daily_limit","merchant_allowlist","merchant_blocklist","location_allowlist"];
      if(!allowed.includes(ruleType))return json(res,400,{ok:false,error:"Tipo de regla inválido"});
      const [program]=await sql.query(
        "SELECT id FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2 LIMIT 1",
        [programId,principal.employerId]
      );
      if(!program)return json(res,404,{ok:false,error:"Programa no encontrado"});

      const [existing]=await sql.query(
        "SELECT id FROM revale.benefit_rules WHERE program_id=$1 AND rule_type=$2 AND active=true ORDER BY id DESC LIMIT 1",
        [programId,ruleType]
      );
      let row;
      if(existing){
        [row]=await sql.query(
          `UPDATE revale.benefit_rules
           SET rule_value=$1::jsonb,updated_at=now()
           WHERE id=$2
           RETURNING id,program_id,rule_type,rule_value,priority,active`,
          [JSON.stringify(ruleValue),existing.id]
        );
      }else{
        [row]=await sql.query(
          `INSERT INTO revale.benefit_rules (program_id,rule_type,rule_value,priority,active)
           VALUES ($1,$2,$3::jsonb,100,true)
           RETURNING id,program_id,rule_type,rule_value,priority,active`,
          [programId,ruleType,JSON.stringify(ruleValue)]
        );
      }
      await sql.query(
        `INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'employer_user',$2,'benefit_rule.updated','benefit_rule',$3,$4::jsonb)`,
        [principal.employerId,principal.employerUserId,String(row.id),JSON.stringify({programId,ruleType,ruleValue})]
      );
      return json(res,200,{ok:true,rule:row});
    }

    if (req.method === "POST" && action === "request-funding") {
      if (!requireRoles(["admin","finance"])) return;
      const programId=String(req.body?.program_id||"");
      const amountPerEmployee=Number(req.body?.amount_per_employee);
      const externalReference=String(req.body?.external_reference||"").trim().slice(0,120);
      if(!Number.isFinite(amountPerEmployee)||amountPerEmployee<=0){
        return json(res,400,{ok:false,error:"Monto por empleado inválido"});
      }
      const [program]=await sql.query(
        `SELECT id,name,currency
         FROM revale.benefit_programs
         WHERE id=$1 AND employer_id=$2 AND active=true
         LIMIT 1`,
        [programId,principal.employerId]
      );
      if(!program)return json(res,404,{ok:false,error:"Programa no encontrado"});

      const [countRow]=await sql.query(
        `SELECT COUNT(*)::int AS count
         FROM revale.employee_enrollments
         WHERE program_id=$1 AND status='active'
           AND starts_on<=CURRENT_DATE
           AND (ends_on IS NULL OR ends_on>=CURRENT_DATE)`,
        [programId]
      );
      const count=Number(countRow?.count||0);
      if(!count)return json(res,409,{ok:false,error:"No hay empleados activos en este programa"});
      const total=Math.round(amountPerEmployee*count*100)/100;
      const id=makeId("fund");
      const batch=await createFundingBatch(sql,{
        id,employerId:principal.employerId,programId,
        externalReference,amount:total,currency:String(program.currency||"USD").trim(),
        metadata:{amount_per_employee:Math.round(amountPerEmployee*100)/100,requested_by:principal.employerUserId}
      });
      const items=await prepareFundingItems(sql,{fundingBatchId:id,programId,amountPerEmployee:Math.round(amountPerEmployee*100)/100});

      await sql.query(
        `INSERT INTO revale.audit_events (employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
         VALUES ($1,'employer_user',$2,'funding.requested','funding_batch',$3,$4::jsonb)`,
        [principal.employerId,principal.employerUserId,id,JSON.stringify({programId,employeeCount:items.length,total})]
      );

      return json(res,200,{ok:true,batch:{...batch,employee_count:items.length,total}});
    }

    return json(res,405,{ok:false,error:"Acción no soportada"});
  }catch(error){
    console.error("ReVale employer API error",error);
    return json(res,500,{ok:false,error:"Error interno del servicio"});
  }
}
