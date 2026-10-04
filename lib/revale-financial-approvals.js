import { createHash } from "node:crypto";

function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}
function safeId(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,90);
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object"){
    return Object.keys(value).sort().reduce((out,key)=>{
      out[key]=canonical(value[key]);return out;
    },{});
  }
  return value;
}
function requestHash(actionType,entityType,entityId,amount,currency,payload){
  return createHash("sha256")
    .update(JSON.stringify(canonical({
      actionType,entityType,entityId,amount:round2(amount),currency,payload:payload||{}
    })))
    .digest("hex");
}

let approvalSchemaPromise=null;

async function bootstrapApprovalSchema(sql){
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.financial_user_permissions (
      admin_user_id text PRIMARY KEY,
      can_make boolean NOT NULL DEFAULT false,
      can_approve boolean NOT NULL DEFAULT false,
      approval_limit numeric(16,2),
      active boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.financial_approval_policies (
      action_type text PRIMARY KEY,
      label text NOT NULL,
      threshold_amount numeric(16,2) NOT NULL DEFAULT 10000 CHECK (threshold_amount >= 0),
      approvals_below integer NOT NULL DEFAULT 1 CHECK (approvals_below BETWEEN 1 AND 5),
      approvals_above integer NOT NULL DEFAULT 2 CHECK (approvals_above BETWEEN 1 AND 5),
      expiry_hours integer NOT NULL DEFAULT 48 CHECK (expiry_hours BETWEEN 1 AND 720),
      active boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.financial_approval_requests (
      id text PRIMARY KEY,
      request_key text NOT NULL UNIQUE,
      action_type text NOT NULL REFERENCES revale.financial_approval_policies(action_type),
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      requested_by text NOT NULL,
      requested_by_name text,
      required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending','approved','rejected','executing','executed',
          'execution_failed','cancelled','expired'
        )),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_note text,
      expires_at timestamptz NOT NULL,
      execution_started_at timestamptz,
      executed_at timestamptz,
      execution_result jsonb,
      failure_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS financial_approval_requests_queue_idx
      ON revale.financial_approval_requests(status,created_at)
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS financial_approval_requests_entity_idx
      ON revale.financial_approval_requests(action_type,entity_type,entity_id,created_at DESC)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.financial_approval_decisions (
      id bigserial PRIMARY KEY,
      request_id text NOT NULL REFERENCES revale.financial_approval_requests(id),
      approver_id text NOT NULL,
      decision text NOT NULL CHECK (decision IN ('approved','rejected')),
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(request_id,approver_id)
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS financial_approval_decisions_request_idx
      ON revale.financial_approval_decisions(request_id,created_at)
  `);

  const policies=[
    ["funding_allocation","Acreditación de fondeo",10000,1,2,48],
    ["merchant_payout","Programación de payout a comercio",10000,1,2,24],
    ["employer_refund","Devolución de fondos a empresa",5000,1,2,24],
    ["safeguarding_topup","Top-up a cuenta segregada",10000,1,2,24],
    ["safeguarding_sweep","Barrido de excedente",5000,1,2,24],
    ["withholding_verification","Verificación de retención",5000,1,2,24],
    ["credit_note_withholding","Ajuste de retención por nota de crédito",5000,1,2,24]
  ];
  for(const p of policies){
    await sql.query(
      `INSERT INTO revale.financial_approval_policies (
         action_type,label,threshold_amount,approvals_below,approvals_above,expiry_hours
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (action_type) DO NOTHING`,
      p
    );
  }

  try{
    await sql.query(`
      INSERT INTO revale.financial_user_permissions (
        admin_user_id,can_make,can_approve,approval_limit,active,metadata
      )
      SELECT
        id::text,
        true,
        true,
        NULL,
        true,
        jsonb_build_object('bootstrap_role',role)
      FROM revale.admin_users
      WHERE active=true AND role IN ('superadmin','finance')
      ON CONFLICT (admin_user_id) DO NOTHING
    `);
  }catch(error){
    console.warn("ReVale financial permission bootstrap skipped",String(error?.message||error));
  }
}

export async function ensureFinancialApprovalSchema(sql){
  if(!approvalSchemaPromise)approvalSchemaPromise=bootstrapApprovalSchema(sql);
  try{await approvalSchemaPromise}
  catch(error){approvalSchemaPromise=null;throw error}
}

export async function financialPermission(sql,adminUserId){
  await ensureFinancialApprovalSchema(sql);
  let [row]=await sql.query(
    `SELECT p.admin_user_id,p.can_make,p.can_approve,
            p.approval_limit::float8 AS approval_limit,p.active,p.metadata,
            u.display_name,u.email,u.role
     FROM revale.financial_user_permissions p
     LEFT JOIN revale.admin_users u ON u.id::text=p.admin_user_id
     WHERE p.admin_user_id=$1
     LIMIT 1`,
    [String(adminUserId||"")]
  );
  if(!row){
    const [admin]=await sql.query(
      `SELECT id::text AS id,display_name,email,role,active
       FROM revale.admin_users WHERE id::text=$1 LIMIT 1`,
      [String(adminUserId||"")]
    );
    if(admin?.active&&["superadmin","finance"].includes(admin.role)){
      [row]=await sql.query(
        `INSERT INTO revale.financial_user_permissions (
           admin_user_id,can_make,can_approve,approval_limit,active,metadata
         ) VALUES ($1,true,true,NULL,true,jsonb_build_object('bootstrap_role',$2))
         ON CONFLICT (admin_user_id) DO UPDATE SET updated_at=now()
         RETURNING admin_user_id,can_make,can_approve,
           approval_limit::float8 AS approval_limit,active,metadata`,
        [admin.id,admin.role]
      );
      row={...row,display_name:admin.display_name,email:admin.email,role:admin.role};
    }
  }
  return row||{
    admin_user_id:String(adminUserId||""),
    can_make:false,can_approve:false,approval_limit:null,active:false
  };
}

export async function listFinancialPolicies(sql){
  await ensureFinancialApprovalSchema(sql);
  return sql.query(
    `SELECT action_type,label,threshold_amount::float8 AS threshold_amount,
            approvals_below,approvals_above,expiry_hours,active,updated_by,updated_at
     FROM revale.financial_approval_policies
     ORDER BY label`
  );
}

export async function listFinancialUsers(sql){
  await ensureFinancialApprovalSchema(sql);
  return sql.query(
    `SELECT u.id::text AS admin_user_id,u.display_name,u.email,u.role,u.active AS user_active,
            COALESCE(p.can_make,false) AS can_make,
            COALESCE(p.can_approve,false) AS can_approve,
            p.approval_limit::float8 AS approval_limit,
            COALESCE(p.active,false) AS permission_active,
            p.updated_by,p.updated_at
     FROM revale.admin_users u
     LEFT JOIN revale.financial_user_permissions p ON p.admin_user_id=u.id::text
     ORDER BY u.active DESC,u.display_name,u.email`
  );
}

export async function updateFinancialUserPermission(sql,{
  adminUserId,canMake,canApprove,approvalLimit=null,active=true,actorId=null
}){
  await ensureFinancialApprovalSchema(sql);
  const id=String(adminUserId||"");
  if(!id)return {code:"not_found"};
  const [user]=await sql.query(
    `SELECT id::text AS id,display_name,email,role,active
     FROM revale.admin_users WHERE id::text=$1 LIMIT 1`,
    [id]
  );
  if(!user)return {code:"not_found"};
  const limit=approvalLimit===null||approvalLimit===undefined||approvalLimit===""
    ? null : round2(approvalLimit);
  if(limit!==null&&limit<0)return {code:"invalid_limit"};
  const [row]=await sql.query(
    `INSERT INTO revale.financial_user_permissions (
       admin_user_id,can_make,can_approve,approval_limit,active,updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (admin_user_id) DO UPDATE SET
       can_make=EXCLUDED.can_make,
       can_approve=EXCLUDED.can_approve,
       approval_limit=EXCLUDED.approval_limit,
       active=EXCLUDED.active,
       updated_by=EXCLUDED.updated_by,
       updated_at=now()
     RETURNING admin_user_id,can_make,can_approve,
       approval_limit::float8 AS approval_limit,active,updated_by,updated_at`,
    [id,Boolean(canMake),Boolean(canApprove),limit,Boolean(active),actorId]
  );
  return {code:"ok",permission:row,user};
}

export async function updateFinancialPolicy(sql,{
  actionType,thresholdAmount,approvalsBelow,approvalsAbove,expiryHours,active=true,actorId=null
}){
  await ensureFinancialApprovalSchema(sql);
  const action=String(actionType||"");
  const threshold=round2(thresholdAmount);
  const below=Number(approvalsBelow),above=Number(approvalsAbove),expiry=Number(expiryHours);
  if(!action)return {code:"not_found"};
  if(threshold<0||!Number.isInteger(below)||!Number.isInteger(above)||
     below<1||below>5||above<1||above>5||!Number.isInteger(expiry)||expiry<1||expiry>720){
    return {code:"invalid_policy"};
  }
  const [row]=await sql.query(
    `UPDATE revale.financial_approval_policies
     SET threshold_amount=$2,approvals_below=$3,approvals_above=$4,
         expiry_hours=$5,active=$6,updated_by=$7,updated_at=now()
     WHERE action_type=$1
     RETURNING action_type,label,threshold_amount::float8 AS threshold_amount,
       approvals_below,approvals_above,expiry_hours,active,updated_by,updated_at`,
    [action,threshold,below,above,expiry,Boolean(active),actorId]
  );
  return row?{code:"ok",policy:row}:{code:"not_found"};
}

export async function createFinancialApprovalRequest(sql,{
  actionType,entityType,entityId,amount=0,currency="USD",
  payload={},requestNote=null,requestedBy,requestedByName=null
}){
  await ensureFinancialApprovalSchema(sql);
  const permission=await financialPermission(sql,requestedBy);
  if(!permission.active||!permission.can_make)return {code:"maker_not_allowed"};

  const [policy]=await sql.query(
    `SELECT action_type,label,threshold_amount::float8 AS threshold_amount,
            approvals_below,approvals_above,expiry_hours,active
     FROM revale.financial_approval_policies
     WHERE action_type=$1
     LIMIT 1`,
    [String(actionType||"")]
  );
  if(!policy||!policy.active)return {code:"policy_disabled"};

  const value=round2(amount);
  if(value<0)return {code:"invalid_amount"};
  const required=value>Number(policy.threshold_amount||0)
    ? Number(policy.approvals_above)
    : Number(policy.approvals_below);
  const curr=String(currency||"USD").trim().toUpperCase().slice(0,3);
  const entity=String(entityId||"");
  const entityKind=String(entityType||"");
  if(!entity||!entityKind)return {code:"entity_required"};

  const hash=requestHash(policy.action_type,entityKind,entity,value,curr,payload||{});
  const requestKey=policy.action_type+":"+entityKind+":"+entity+":"+hash.slice(0,20);

  const [existing]=await sql.query(
    `SELECT r.id,r.action_type,r.entity_type,r.entity_id,r.amount::float8 AS amount,r.currency,
            r.requested_by,r.requested_by_name,r.required_approvals,r.status,r.payload,
            r.request_note,r.expires_at,r.created_at,r.executed_at,r.execution_result,r.failure_reason,
            COALESCE((SELECT COUNT(*) FROM revale.financial_approval_decisions d
                      WHERE d.request_id=r.id AND d.decision='approved'),0)::int AS approval_count
     FROM revale.financial_approval_requests r
     WHERE r.request_key=$1
     LIMIT 1`,
    [requestKey]
  );
  if(existing && !["rejected","cancelled","expired"].includes(existing.status)){
    return {code:"ok",request:existing,idempotent:true};
  }
  const effectiveRequestKey=existing
    ? requestKey+":r"+Date.now().toString(36)
    : requestKey;

  const id="far_"+safeId(policy.action_type)+"_"+Date.now().toString(36);
  const [row]=await sql.query(
    `INSERT INTO revale.financial_approval_requests (
       id,request_key,action_type,entity_type,entity_id,amount,currency,
       requested_by,requested_by_name,required_approvals,status,payload,
       request_note,expires_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11::jsonb,$12,
       now()+make_interval(hours=>$13)
     )
     ON CONFLICT (request_key) DO UPDATE SET
       updated_at=now()
     RETURNING id,request_key,action_type,entity_type,entity_id,
       amount::float8 AS amount,currency,requested_by,requested_by_name,
       required_approvals,status,payload,request_note,expires_at,created_at`,
    [
      id,effectiveRequestKey,policy.action_type,entityKind,entity,value,curr,
      String(requestedBy),requestedByName||null,required,
      JSON.stringify(payload||{}),String(requestNote||"").trim().slice(0,500)||null,
      Number(policy.expiry_hours)
    ]
  );

  const [eligible]=await sql.query(
    `SELECT COUNT(*)::int AS count
     FROM revale.financial_user_permissions p
     JOIN revale.admin_users u ON u.id::text=p.admin_user_id AND u.active=true
     WHERE p.active=true AND p.can_approve=true
       AND p.admin_user_id<>$1
       AND (p.approval_limit IS NULL OR p.approval_limit >= $2)`,
    [String(requestedBy),value]
  );
  return {
    code:"ok",request:{...row,approval_count:0},
    eligibleApprovers:Number(eligible?.count||0),
    hasEnoughApprovers:Number(eligible?.count||0)>=required
  };
}

export async function listFinancialApprovalRequests(sql,{status=null,limit=200}={}){
  await ensureFinancialApprovalSchema(sql);
  await sql.query(
    `UPDATE revale.financial_approval_requests
     SET status='expired',updated_at=now()
     WHERE status='pending'
       AND expires_at<now()`
  );
  const params=[];let where="WHERE 1=1";
  if(status){params.push(String(status));where+=" AND r.status=$"+params.length}
  params.push(Math.max(1,Math.min(Number(limit)||200,500)));
  return sql.query(
    `SELECT
       r.id,r.action_type,p.label AS action_label,r.entity_type,r.entity_id,
       r.amount::float8 AS amount,r.currency,r.requested_by,r.requested_by_name,
       r.required_approvals,r.status,r.payload,r.request_note,r.expires_at,
       r.execution_started_at,r.executed_at,r.execution_result,r.failure_reason,
       r.created_at,r.updated_at,
       COALESCE(COUNT(d.id) FILTER (WHERE d.decision='approved'),0)::int AS approval_count,
       COALESCE(COUNT(d.id) FILTER (WHERE d.decision='rejected'),0)::int AS rejection_count,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'approver_id',d.approver_id,
             'approver_name',u.display_name,
             'decision',d.decision,
             'note',d.note,
             'created_at',d.created_at
           )
           ORDER BY d.created_at
         ) FILTER (WHERE d.id IS NOT NULL),
         '[]'::jsonb
       ) AS decisions
     FROM revale.financial_approval_requests r
     JOIN revale.financial_approval_policies p ON p.action_type=r.action_type
     LEFT JOIN revale.financial_approval_decisions d ON d.request_id=r.id
     LEFT JOIN revale.admin_users u ON u.id::text=d.approver_id
     ${where}
     GROUP BY r.id,p.label
     ORDER BY
       CASE r.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 WHEN 'executing' THEN 3 ELSE 4 END,
       r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
}

export async function approvalDecision(sql,{
  requestId,approverId,decision,note=null
}){
  await ensureFinancialApprovalSchema(sql);
  const id=String(requestId||""),actor=String(approverId||"");
  if(!id)return {code:"not_found"};
  if(!["approve","reject"].includes(decision))return {code:"invalid_decision"};

  const [request]=await sql.query(
    `SELECT r.id,r.action_type,r.amount::float8 AS amount,r.currency,
            r.requested_by,r.required_approvals,r.status,r.expires_at
     FROM revale.financial_approval_requests r
     WHERE r.id=$1
     LIMIT 1`,
    [id]
  );
  if(!request)return {code:"not_found"};
  if(request.requested_by===actor)return {code:"self_approval_forbidden"};
  if(new Date(request.expires_at).getTime()<Date.now()){
    await sql.query(
      `UPDATE revale.financial_approval_requests SET status='expired',updated_at=now()
       WHERE id=$1 AND status IN ('pending','approved')`,
      [id]
    );
    return {code:"expired"};
  }
  if(!["pending","approved"].includes(request.status))return {code:"invalid_status",status:request.status};

  const permission=await financialPermission(sql,actor);
  if(!permission.active||!permission.can_approve)return {code:"approver_not_allowed"};
  if(permission.approval_limit!==null&&permission.approval_limit!==undefined&&
     Number(request.amount)>Number(permission.approval_limit)+0.00001){
    return {code:"approval_limit_exceeded",limit:Number(permission.approval_limit)};
  }

  const decisionValue=decision==="approve"?"approved":"rejected";
  try{
    await sql.query(
      `INSERT INTO revale.financial_approval_decisions (
         request_id,approver_id,decision,note
       ) VALUES ($1,$2,$3,$4)`,
      [id,actor,decisionValue,String(note||"").trim().slice(0,500)||null]
    );
  }catch(error){
    const message=String(error?.message||"").toLowerCase();
    if(message.includes("financial_approval_decisions_request_id_approver_id_key")){
      return {code:"already_decided"};
    }
    throw error;
  }

  if(decisionValue==="rejected"){
    const [row]=await sql.query(
      `UPDATE revale.financial_approval_requests
       SET status='rejected',failure_reason=$2,updated_at=now()
       WHERE id=$1 AND status IN ('pending','approved')
       RETURNING id,status,action_type,entity_type,entity_id,amount::float8 AS amount,currency`,
      [id,String(note||"").trim().slice(0,500)||"Rechazada por aprobador"]
    );
    return {code:"ok",request:row,rejected:true,readyToExecute:false};
  }

  const [counts]=await sql.query(
    `SELECT COUNT(*) FILTER (WHERE decision='approved')::int AS approvals
     FROM revale.financial_approval_decisions
     WHERE request_id=$1`,
    [id]
  );
  const approvals=Number(counts?.approvals||0);
  const ready=approvals>=Number(request.required_approvals);
  const [row]=await sql.query(
    `UPDATE revale.financial_approval_requests
     SET status=CASE WHEN $2 THEN 'approved' ELSE 'pending' END,updated_at=now()
     WHERE id=$1 AND status IN ('pending','approved')
     RETURNING id,action_type,entity_type,entity_id,amount::float8 AS amount,currency,
       requested_by,required_approvals,status,payload,request_note,expires_at`,
    [id,ready]
  );
  return {code:"ok",request:{...row,approval_count:approvals},readyToExecute:ready};
}

export async function getFinancialApprovalRequest(sql,requestId){
  await ensureFinancialApprovalSchema(sql);
  const [row]=await sql.query(
    `SELECT
       r.id,r.action_type,p.label AS action_label,r.entity_type,r.entity_id,
       r.amount::float8 AS amount,r.currency,r.requested_by,r.requested_by_name,
       r.required_approvals,r.status,r.payload,r.request_note,r.expires_at,
       r.execution_started_at,r.executed_at,r.execution_result,r.failure_reason,
       r.created_at,r.updated_at,
       COALESCE((SELECT COUNT(*) FROM revale.financial_approval_decisions d
                 WHERE d.request_id=r.id AND d.decision='approved'),0)::int AS approval_count
     FROM revale.financial_approval_requests r
     JOIN revale.financial_approval_policies p ON p.action_type=r.action_type
     WHERE r.id=$1
     LIMIT 1`,
    [String(requestId||"")]
  );
  return row||null;
}

export async function claimFinancialApprovalForExecution(sql,requestId,actorId){
  await ensureFinancialApprovalSchema(sql);
  const [row]=await sql.query(
    `UPDATE revale.financial_approval_requests
     SET status='executing',execution_started_at=now(),failure_reason=NULL,updated_at=now()
     WHERE id=$1
       AND (
         status='approved'
         OR (status='execution_failed')
         OR (status='executing' AND execution_started_at<now()-interval '5 minutes')
       )
     RETURNING id,action_type,entity_type,entity_id,amount::float8 AS amount,currency,
       requested_by,requested_by_name,required_approvals,status,payload,request_note,
       expires_at,execution_started_at`,
    [String(requestId||"")]
  );
  if(row)return {code:"ok",request:row};
  const [existing]=await sql.query(
    `SELECT id,status FROM revale.financial_approval_requests WHERE id=$1 LIMIT 1`,
    [String(requestId||"")]
  );
  return {code:existing?"not_executable":"not_found",status:existing?.status||null};
}

export async function finishFinancialApprovalExecution(sql,{
  requestId,success,result=null,failureReason=null
}){
  await ensureFinancialApprovalSchema(sql);
  const [row]=await sql.query(
    `UPDATE revale.financial_approval_requests
     SET status=$2,
         executed_at=CASE WHEN $3 THEN now() ELSE executed_at END,
         execution_result=$4::jsonb,
         failure_reason=$5,
         updated_at=now()
     WHERE id=$1 AND status='executing'
     RETURNING id,status,executed_at,execution_result,failure_reason`,
    [
      String(requestId||""),
      success?"executed":"execution_failed",
      Boolean(success),
      JSON.stringify(result||{}),
      success?null:String(failureReason||"Execution failed").slice(0,1000)
    ]
  );
  return row?{code:"ok",request:row}:{code:"invalid_status"};
}

export async function pendingApprovalSummary(sql,adminUserId){
  await ensureFinancialApprovalSchema(sql);
  const permission=await financialPermission(sql,adminUserId);
  const [row]=await sql.query(
    `SELECT
       COUNT(*) FILTER (WHERE r.status='pending')::int AS pending,
       COUNT(*) FILTER (
         WHERE r.status='pending'
           AND r.requested_by<>$1
           AND NOT EXISTS (
             SELECT 1 FROM revale.financial_approval_decisions d
             WHERE d.request_id=r.id AND d.approver_id=$1
           )
           AND ($2::boolean=true)
           AND ($3::numeric IS NULL OR r.amount<=$3::numeric)
       )::int AS actionable
     FROM revale.financial_approval_requests r
     WHERE r.expires_at>=now()`,
    [String(adminUserId||""),Boolean(permission.active&&permission.can_approve),permission.approval_limit]
  );
  return {permission,pending:Number(row?.pending||0),actionable:Number(row?.actionable||0)};
}
