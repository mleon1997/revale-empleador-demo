import { createHash, randomBytes, randomUUID } from 'node:crypto';

const fail = (status,message) => Object.assign(new Error(message),{status});
const digest = value => createHash('sha256').update(value).digest('hex');
const roles = ['admin','hr','finance','viewer'];
const serial = async (sql,text,args=[]) => (await sql.transaction([sql.query(text,args)],{isolationLevel:'Serializable'}))[0];
const limitValue = value => {
  if(value==null||value==='')return null;
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>500000000||Math.round(n*100)!==Math.round(n*10000)/100)throw fail(400,'Ingresa un límite válido con hasta dos decimales.');
  return Math.round(n*100)/100;
};
export const employerGovernanceSchema = [
  `ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS activation_required boolean NOT NULL DEFAULT false`,
  `ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS approval_limit numeric(14,2) CHECK (approval_limit>=0)`,
  `ALTER TABLE revale.employer_users ADD COLUMN IF NOT EXISTS access_version integer NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS revale.employer_team_invites (
    user_id text PRIMARY KEY REFERENCES revale.employer_users(id), employer_id text NOT NULL REFERENCES revale.employers(id),
    token_hash text NOT NULL UNIQUE, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL, accepted_at timestamptz, attempts integer NOT NULL DEFAULT 0,
    attempt_window timestamptz, claim_id text, claim_until timestamptz)`,
  `CREATE INDEX IF NOT EXISTS employer_team_invites_company_idx ON revale.employer_team_invites(employer_id,expires_at)`,
  `CREATE TABLE IF NOT EXISTS revale.employer_approval_policies (
    employer_id text PRIMARY KEY REFERENCES revale.employers(id), threshold numeric(14,2) NOT NULL DEFAULT 5000 CHECK(threshold>0),
    version integer NOT NULL DEFAULT 1, updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS revale.employer_funding_approvals (
    funding_batch_id text PRIMARY KEY REFERENCES revale.funding_batches(id), employer_id text NOT NULL REFERENCES revale.employers(id),
    program_id text NOT NULL REFERENCES revale.benefit_programs(id), requested_by text NOT NULL REFERENCES revale.employer_users(id),
    requester_auth_id uuid NOT NULL, requester_name text NOT NULL, amount numeric(14,2) NOT NULL CHECK(amount>0), roster_hash text NOT NULL,
    required_approvals integer NOT NULL CHECK(required_approvals IN(1,2)), policy_version integer NOT NULL, threshold numeric(14,2) NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS employer_funding_approvals_queue_idx ON revale.employer_funding_approvals(employer_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS revale.employer_funding_decisions (
    funding_batch_id text NOT NULL REFERENCES revale.employer_funding_approvals(funding_batch_id),
    user_id text NOT NULL REFERENCES revale.employer_users(id), auth_user_id uuid NOT NULL, actor_name text NOT NULL, actor_role text NOT NULL,
    decision text NOT NULL CHECK(decision IN('approve','reject','cancel')), note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(funding_batch_id,user_id), UNIQUE(funding_batch_id,auth_user_id))`,
  `INSERT INTO revale.employer_approval_policies(employer_id) SELECT id FROM revale.employers ON CONFLICT(employer_id) DO NOTHING`
];
const schemas=new WeakMap();
export async function ensureEmployerGovernanceSchema(sql){
  if(!schemas.has(sql))schemas.set(sql,(async()=>{for(const statement of employerGovernanceSchema)await sql.query(statement);})());
  try{await schemas.get(sql);}catch(error){schemas.delete(sql);throw error;}
}

// Snapshot the exact reviewed roster. The signature is a change detector, not an auth token.
export const rosterSignature = alias => `md5(jsonb_agg(jsonb_build_array(${alias}.enrollment_id::text,${alias}.account_id,${alias}.amount::numeric(14,2)::text) ORDER BY ${alias}.enrollment_id)::text)`;
export function companyApprovalGuard(alias='fb'){
  return `((COALESCE(${alias}.metadata->>'company_approval_required','false')<>'true' AND NOT EXISTS(SELECT 1 FROM revale.employer_funding_approvals existing_ca WHERE existing_ca.funding_batch_id=${alias}.id)) OR EXISTS (
    SELECT 1 FROM revale.employer_funding_approvals ca WHERE ca.funding_batch_id=${alias}.id AND ca.employer_id=${alias}.employer_id
      AND ca.program_id=${alias}.program_id AND ca.status='approved' AND ca.amount=${alias}.amount
      AND ca.roster_hash=(SELECT ${rosterSignature('ci')} FROM revale.funding_batch_items ci WHERE ci.funding_batch_id=${alias}.id)
      AND (SELECT COUNT(*) FROM revale.employer_funding_decisions cd WHERE cd.funding_batch_id=ca.funding_batch_id AND cd.decision='approve'
        AND cd.user_id<>ca.requested_by AND cd.auth_user_id<>ca.requester_auth_id)>=ca.required_approvals))`;
}
export async function companyFundingApproved(sql,id){
  await ensureEmployerGovernanceSchema(sql);
  const [row]=await sql.query(`SELECT ${companyApprovalGuard()} AS approved FROM revale.funding_batches fb WHERE fb.id=$1`,[id]);
  return row?.approved===true;
}

export async function approvalPolicy(sql,employerId){
  const [row]=await sql.query('SELECT threshold::float8,version,updated_at FROM revale.employer_approval_policies WHERE employer_id=$1',[employerId]);
  if(!row)throw fail(409,'Actualiza la configuración de tu empresa.');
  return row;
}
export async function updateApprovalPolicy(sql,principal,body){
  const threshold=limitValue(body.threshold),version=Number(body.version),reason=String(body.reason||'').trim().slice(0,400);
  if(!threshold||!Number.isInteger(version)||reason.length<5)throw fail(400,'Indica el umbral y el motivo del cambio.');
  const [row]=await serial(sql,`WITH actor AS (
    SELECT u.id FROM revale.employer_users u JOIN revale.employers e ON e.id=u.employer_id
    WHERE u.id=$1 AND u.employer_id=$2 AND u.active AND u.role='admin' AND e.active FOR UPDATE OF e
  ), changed AS (
    UPDATE revale.employer_approval_policies SET threshold=$3,version=version+1,updated_by=$1,updated_at=now()
    WHERE employer_id=$2 AND version=$4 AND EXISTS(SELECT 1 FROM actor) RETURNING *
  ), audit AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    SELECT $2,'employer_user',$1,'company.policy_updated','employer',$2,jsonb_build_object('threshold',threshold,'version',version,'reason',$5::text) FROM changed RETURNING id
  ) SELECT threshold::float8,version,updated_at FROM changed`,[principal.employerUserId,principal.employerId,threshold,version,reason]);
  if(!row)throw fail(409,'La configuración o tus permisos cambiaron. Actualiza e intenta nuevamente.');
  return row;
}

export async function team(sql,principal){
  return sql.query(`SELECT u.id,u.display_name,u.email,u.role,u.active,u.approval_limit::float8,u.access_version,u.last_login_at,
    CASE WHEN NOT u.active THEN 'suspended' WHEN u.auth_user_id IS NOT NULL THEN 'activated' WHEN i.user_id IS NULL THEN 'not_invited'
      WHEN i.expires_at<=now() THEN 'expired' ELSE 'invited' END AS access_status,i.expires_at
    FROM revale.employer_users u LEFT JOIN revale.employer_team_invites i ON i.user_id=u.id AND i.employer_id=u.employer_id
    WHERE u.employer_id=$1 ORDER BY u.active DESC,u.display_name,u.id`,[principal.employerId]);
}
export async function updateTeamMember(sql,principal,body){
  const id=String(body.user_id||''),role=String(body.role||''),active=body.active,version=Number(body.version),reason=String(body.reason||'').trim().slice(0,400);
  const limit=limitValue(body.approval_limit);
  if(!roles.includes(role)||typeof active!=='boolean'||!Number.isInteger(version)||reason.length<5)throw fail(400,'Revisa el rol, el estado y el motivo del cambio.');
  if(id===principal.employerUserId)throw fail(403,'Otro administrador debe cambiar tus propios permisos.');
  const [row]=await serial(sql,`WITH actor AS (
    SELECT u.id,u.auth_user_id FROM revale.employer_users u JOIN revale.employers e ON e.id=u.employer_id
    WHERE u.id=$1 AND u.employer_id=$2 AND u.active AND u.role='admin' AND e.active FOR UPDATE OF e
  ), target AS (
    SELECT u.* FROM revale.employer_users u CROSS JOIN actor a WHERE u.id=$3 AND u.employer_id=$2 AND u.id<>a.id
      AND (u.auth_user_id IS NULL OR u.auth_user_id<>a.auth_user_id) AND u.access_version=$7
      AND (u.role<>'admin' OR NOT u.active OR ($4='admin' AND $5::boolean) OR EXISTS(
        SELECT 1 FROM revale.employer_users peer WHERE peer.employer_id=$2 AND peer.id<>u.id AND peer.active AND peer.role='admin' AND peer.auth_user_id IS NOT NULL))
    FOR UPDATE OF u
  ), changed AS (
    UPDATE revale.employer_users u SET role=$4,active=$5,approval_limit=$6,access_version=u.access_version+1,updated_at=now()
    FROM target t WHERE u.id=t.id RETURNING u.id,t.role AS old_role,t.active AS old_active,t.approval_limit AS old_limit
  ), revoked AS (
    UPDATE revale.employer_team_invites SET expires_at=LEAST(expires_at,now()),claim_id=NULL,claim_until=NULL WHERE user_id IN(SELECT id FROM changed) AND accepted_at IS NULL RETURNING user_id
  ), audit AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    SELECT $2,'employer_user',$1,'company.member_updated','employer_user',id,jsonb_build_object('previousRole',old_role,'role',$4::text,'previousActive',old_active,'active',$5::boolean,'previousLimit',old_limit,'approvalLimit',$6::numeric,'reason',$8::text)
    FROM changed RETURNING id
  ) SELECT id FROM changed`,[principal.employerUserId,principal.employerId,id,role,active,limit,version,reason]);
  if(!row)throw fail(409,'El acceso cambió o no puede modificarse. Conserva al menos un administrador con cuenta activa.');
  return row;
}
export async function inviteTeamMember(sql,principal,body){
  const existingId=String(body.user_id||''),email=String(body.email||'').trim().toLowerCase(),name=String(body.display_name||'').trim().slice(0,100),role=String(body.role||'viewer');
  const limit=limitValue(body.approval_limit),token=randomBytes(32).toString('base64url'),id='eu_'+randomUUID().replaceAll('-','');
  if(!existingId&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||name.length<2||!roles.includes(role)))throw fail(400,'Completa nombre, correo y rol para invitar.');
  const [row]=await serial(sql,`WITH actor AS (
    SELECT u.id FROM revale.employer_users u JOIN revale.employers e ON e.id=u.employer_id
    WHERE u.id=$1 AND u.employer_id=$2 AND u.active AND u.role='admin' AND e.active FOR UPDATE OF e
  ), created AS (
    INSERT INTO revale.employer_users(id,employer_id,display_name,email,role,active,approval_limit,activation_required)
    SELECT $3,$2,$4,$5,$6,true,$7,true FROM actor WHERE $8='' AND NOT EXISTS(SELECT 1 FROM revale.employer_users WHERE lower(email)=$5)
    RETURNING id,email,display_name
  ), target AS (
    SELECT id,email,display_name FROM created UNION ALL
    SELECT u.id,u.email,u.display_name FROM revale.employer_users u CROSS JOIN actor a
      WHERE u.id=$8 AND u.employer_id=$2 AND u.active AND u.auth_user_id IS NULL
  ), issued AS (
    INSERT INTO revale.employer_team_invites(user_id,employer_id,token_hash,created_by,expires_at)
    SELECT id,$2,$9,$1,now()+interval '72 hours' FROM target
    ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,created_by=EXCLUDED.created_by,created_at=now(),expires_at=EXCLUDED.expires_at,accepted_at=NULL,attempts=0,attempt_window=NULL,claim_id=NULL,claim_until=NULL
    RETURNING user_id,expires_at
  ), guarded AS (
    UPDATE revale.employer_users SET activation_required=true WHERE id=$8 AND id IN(SELECT user_id FROM issued) RETURNING id
  ), audit AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id)
    SELECT $2,'employer_user',$1,'company.member_invited','employer_user',user_id FROM issued RETURNING id
  ) SELECT t.id,t.email,t.display_name,i.expires_at FROM target t JOIN issued i ON i.user_id=t.id`,[principal.employerUserId,principal.employerId,id,name,email,role,limit,existingId,digest(token)]);
  if(!row)throw fail(409,'No se puede crear esta invitación. Revisa si el correo ya tiene acceso o actualiza el equipo.');
  return {...row,url:'https://empresas.revale.app/empresas/activar/#'+token};
}

function tokenHash(token){if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||'')))throw fail(404,'Esta invitación no está disponible. Pide un nuevo enlace al administrador.');return digest(token);}
export async function teamInvitationInfo(sql,token){
  const [row]=await sql.query(`SELECT u.display_name AS first_name,u.email,u.role,e.name AS employer_name,i.expires_at
    FROM revale.employer_team_invites i JOIN revale.employer_users u ON u.id=i.user_id AND u.employer_id=i.employer_id
    JOIN revale.employers e ON e.id=i.employer_id WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now()
      AND u.active AND u.auth_user_id IS NULL AND e.active`,[tokenHash(token)]);
  if(!row)throw fail(404,'Esta invitación venció o ya se utilizó. Pide un nuevo enlace o ingresa con tu cuenta.');
  return row;
}
export async function claimTeamInvitation(sql,token){
  await teamInvitationInfo(sql,token);
  const [row]=await sql.query(`UPDATE revale.employer_team_invites SET claim_id=$2,claim_until=now()+interval '90 seconds',
    attempts=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempts+1 ELSE 1 END,
    attempt_window=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempt_window ELSE now() END
    WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() AND (claim_until IS NULL OR claim_until<now())
      AND (attempts<5 OR attempt_window IS NULL OR attempt_window<=now()-interval '15 minutes') RETURNING claim_id`,[tokenHash(token),randomUUID()]);
  if(!row)throw fail(429,'Espera unos minutos antes de intentar otra vez.');
  return row;
}
export async function releaseTeamInvitation(sql,claimId){await sql.query('UPDATE revale.employer_team_invites SET claim_id=NULL,claim_until=NULL WHERE claim_id=$1 AND accepted_at IS NULL',[claimId]);}
export async function completeTeamInvitation(sql,token,claimId,user){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(user?.id||''))||!user?.email)throw fail(401,'No pudimos validar tu cuenta.');
  const [row]=await serial(sql,`WITH target AS (
    SELECT u.id,i.employer_id FROM revale.employer_team_invites i JOIN revale.employer_users u ON u.id=i.user_id AND u.employer_id=i.employer_id
    JOIN revale.employers e ON e.id=i.employer_id WHERE i.token_hash=$1 AND i.claim_id=$2 AND i.claim_until>now()
      AND i.expires_at>now() AND i.accepted_at IS NULL AND u.active AND e.active AND u.auth_user_id IS NULL AND lower(u.email)=$4
      AND NOT EXISTS(SELECT 1 FROM revale.employer_users other WHERE other.auth_user_id=$3::uuid) FOR UPDATE OF i,u,e
  ), linked AS (
    UPDATE revale.employer_users u SET auth_user_id=$3::uuid,activation_required=false,access_version=u.access_version+1,updated_at=now()
    FROM target t WHERE u.id=t.id RETURNING u.id,u.employer_id
  ), accepted AS (
    UPDATE revale.employer_team_invites SET accepted_at=now(),claim_id=NULL,claim_until=NULL WHERE user_id IN(SELECT id FROM linked) RETURNING user_id
  ), audit AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id)
    SELECT employer_id,'employer_user',id,'company.member_activated','employer_user',id FROM linked RETURNING id
  ) SELECT id FROM linked`,[tokenHash(token),claimId,user.id,String(user.email).trim().toLowerCase()]);
  if(!row)throw fail(409,'La invitación cambió o ya se utilizó. Pide un nuevo enlace.');
  return row;
}

const APPROVAL_SELECT=`SELECT a.*,a.amount::float8 AS amount,a.threshold::float8 AS threshold,b.external_reference,b.status AS funding_status,p.name AS program_name,
  (SELECT COUNT(*)::int FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=a.funding_batch_id AND d.decision='approve') AS approved_count
  FROM revale.employer_funding_approvals a JOIN revale.funding_batches b ON b.id=a.funding_batch_id JOIN revale.benefit_programs p ON p.id=a.program_id`;
export async function approvalDetail(sql,principal,id){
  const [row]=await sql.query(APPROVAL_SELECT+' WHERE a.funding_batch_id=$1 AND a.employer_id=$2',[id,principal.employerId]);
  if(!row)return null;
  const [decisions,eligible]=await Promise.all([
    sql.query('SELECT user_id,actor_name,actor_role,decision,note,created_at FROM revale.employer_funding_decisions WHERE funding_batch_id=$1 ORDER BY created_at,user_id',[id]),
    sql.query(`SELECT u.id,u.display_name,u.role FROM revale.employer_users u WHERE u.employer_id=$1 AND u.active AND u.role IN('admin','finance')
      AND u.auth_user_id IS NOT NULL AND u.id<>$2 AND u.auth_user_id<>$4::uuid AND (u.approval_limit IS NULL OR u.approval_limit>=$3)
      AND NOT EXISTS(SELECT 1 FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=$5 AND (d.user_id=u.id OR d.auth_user_id=u.auth_user_id))
      ORDER BY u.display_name`,[principal.employerId,row.requested_by,row.amount,row.requester_auth_id,id])
  ]);
  const pending=row.status==='pending'&&['pending','received'].includes(row.funding_status),remaining=Math.max(0,row.required_approvals-row.approved_count);
  const {requester_auth_id,...safe}=row;
  return {...safe,decisions,eligible_approvers:eligible,remaining_approvals:remaining,can_decide:pending&&eligible.some(u=>u.id===principal.employerUserId),
    can_cancel:pending&&row.requested_by===principal.employerUserId,blocked:pending&&eligible.length<remaining};
}
export async function approvalInbox(sql,principal,query={}){
  const filter=String(query.filter||'pending'),offset=Math.min(100000,Math.max(0,Math.floor(Number(query.offset)||0)));
  if(!['pending','mine','history'].includes(filter))throw fail(400,'Filtro de aprobaciones inválido.');
  const rows=await sql.query(APPROVAL_SELECT+` WHERE a.employer_id=$1 AND
    CASE WHEN $2='history' THEN a.status<>'pending' OR b.status='cancelled'
      WHEN $2='mine' THEN a.status='pending' AND b.status<>'cancelled' AND a.requested_by<>$3 AND a.requester_auth_id<>u.auth_user_id
        AND u.active AND u.role IN('admin','finance') AND (u.approval_limit IS NULL OR u.approval_limit>=a.amount)
        AND NOT EXISTS(SELECT 1 FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=a.funding_batch_id AND (d.user_id=u.id OR d.auth_user_id=u.auth_user_id))
      ELSE a.status='pending' AND b.status<>'cancelled' END ORDER BY a.created_at DESC,a.funding_batch_id DESC LIMIT 51 OFFSET $4`.replace(' WHERE a.employer_id',` JOIN revale.employer_users u ON u.id=$3 AND u.employer_id=a.employer_id WHERE a.employer_id`),[principal.employerId,filter,principal.employerUserId,offset]);
  return {items:rows.slice(0,50).map(({requester_auth_id,...row})=>row),hasMore:rows.length>50,nextOffset:offset+Math.min(rows.length,50)};
}
export async function approvalSummary(sql,principal){
  const [row]=await sql.query(`SELECT COUNT(*)::int AS pending,COUNT(*) FILTER(WHERE a.requested_by<>u.id AND a.requester_auth_id<>u.auth_user_id
    AND u.active AND u.role IN('admin','finance') AND (u.approval_limit IS NULL OR u.approval_limit>=a.amount)
    AND NOT EXISTS(SELECT 1 FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=a.funding_batch_id AND (d.user_id=u.id OR d.auth_user_id=u.auth_user_id)))::int AS mine
    FROM revale.employer_funding_approvals a JOIN revale.funding_batches b ON b.id=a.funding_batch_id
    JOIN revale.employer_users u ON u.id=$2 AND u.employer_id=a.employer_id WHERE a.employer_id=$1 AND a.status='pending' AND b.status<>'cancelled'`,[principal.employerId,principal.employerUserId]);
  return row;
}
export async function decideFunding(sql,principal,body){
  const id=String(body.id||''),decision=String(body.decision||''),note=String(body.note||'').trim().slice(0,600);
  if(!['approve','reject','cancel'].includes(decision)||(['reject','cancel'].includes(decision)&&note.length<5))throw fail(400,'Indica la decisión y el motivo cuando rechaces o retires una solicitud.');
  const [row]=await serial(sql,`WITH target AS (
    SELECT a.*,u.id AS actor_id,u.auth_user_id AS actor_auth,u.display_name AS actor_name,u.role AS actor_role FROM revale.employer_funding_approvals a
    JOIN revale.funding_batches b ON b.id=a.funding_batch_id JOIN revale.employers e ON e.id=a.employer_id
    JOIN revale.employer_users u ON u.id=$2 AND u.employer_id=a.employer_id
    WHERE a.funding_batch_id=$1 AND a.employer_id=$3 AND a.status='pending' AND b.status IN('pending','received') AND u.active AND e.active AND u.auth_user_id IS NOT NULL
      AND a.amount=b.amount AND a.program_id=b.program_id AND a.roster_hash=(SELECT ${rosterSignature('i')} FROM revale.funding_batch_items i WHERE i.funding_batch_id=b.id)
      AND CASE WHEN $4='cancel' THEN a.requested_by=u.id ELSE a.requested_by<>u.id AND a.requester_auth_id<>u.auth_user_id AND u.role IN('admin','finance') AND (u.approval_limit IS NULL OR u.approval_limit>=a.amount) END
      AND NOT EXISTS(SELECT 1 FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=a.funding_batch_id AND (d.user_id=u.id OR d.auth_user_id=u.auth_user_id))
    FOR UPDATE OF a,b,e
  ), decided AS (
    INSERT INTO revale.employer_funding_decisions(funding_batch_id,user_id,auth_user_id,actor_name,actor_role,decision,note)
    SELECT funding_batch_id,actor_id,actor_auth,actor_name,actor_role,$4,$5 FROM target RETURNING *
  ), changed AS (
    UPDATE revale.employer_funding_approvals a SET status=CASE WHEN $4='cancel' THEN 'cancelled' WHEN $4='reject' THEN 'rejected'
      WHEN (SELECT COUNT(*) FROM revale.employer_funding_decisions d WHERE d.funding_batch_id=a.funding_batch_id AND d.decision='approve')+1>=a.required_approvals THEN 'approved' ELSE 'pending' END,
      decided_at=now() FROM decided d WHERE a.funding_batch_id=d.funding_batch_id RETURNING a.status,a.funding_batch_id
  ), audit AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    SELECT $3,'employer_user',$2,'company.funding_decided','funding_batch',funding_batch_id,jsonb_build_object('decision',$4::text,'note',$5::text,'status',status) FROM changed RETURNING id
  ) SELECT * FROM changed`,[id,principal.employerUserId,principal.employerId,decision,note]);
  if(!row){
    const detail=await approvalDetail(sql,principal,id);
    const previous=detail?.decisions.find(d=>d.user_id===principal.employerUserId);
    if(previous?.decision===decision&&previous.note===note)return {approval:detail,idempotent:true};
    throw fail(409,'No puedes tomar esta decisión: la solicitud cambió, ya participaste, eres quien la preparó o tu permiso no cubre el monto.');
  }
  return {approval:await approvalDetail(sql,principal,id),idempotent:false};
}
