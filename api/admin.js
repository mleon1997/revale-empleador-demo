import { getSql } from "../lib/revale-db.js";
import { getAdminPrincipal, roleAllowed } from "../lib/revale-auth.js";
import { confirmFundingBatchAtomic } from "../lib/revale-admin-funding.js";

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
          (SELECT COUNT(*)::int FROM revale.merchant_bank_account_requests WHERE status='pending') AS pending_banks`
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
      const [batch]=await sql.query("SELECT id,employer_id,status FROM revale.funding_batches WHERE id=$1 LIMIT 1",[id]);
      if(!batch)return json(res,404,{ok:false,error:"Fondeo no encontrado"});
      const result=await confirmFundingBatchAtomic(sql,id);
      if(result.code!=="ok"){
        const messages={no_items:"El fondeo no tiene colaboradores preparados",insufficient_funding:"El monto no cubre las asignaciones",invalid_status:"El fondeo no puede procesarse"};
        return json(res,409,{ok:false,error:messages[result.code]||"No se pudo acreditar el fondeo",detail:result});
      }
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
