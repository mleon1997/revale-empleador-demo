import { createHash, randomUUID } from 'node:crypto';
import { problem } from './revale-employer.js';
import { requireMfa } from './revale-identity.js';

const unavailable=()=>problem(404,'Esta invitación venció, se revocó o ya se utilizó. Solicita un nuevo enlace.');
const hash=token=>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||'')))throw unavailable();
  return createHash('sha256').update(token).digest('hex');
};
const eligible=`i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
  AND a.active=false AND a.auth_user_id IS NULL
  AND lower(a.email)=i.email AND a.role=i.invited_role`;

export async function adminInvitationInfo(sql,token){
  const [row]=await sql.query(`SELECT a.display_name AS first_name,i.email,i.invited_role AS role,i.expires_at
    FROM revale.admin_access_invites i JOIN revale.admin_users a ON a.id=i.admin_user_id
    WHERE i.token_hash=$1 AND ${eligible}`,[hash(token)]);
  if(!row)throw unavailable();
  return row;
}
export async function claimAdminInvitation(sql,token){
  const claimId=randomUUID();
  const [row]=await sql.query(`UPDATE revale.admin_access_invites i SET
    claim_id=$2,claim_until=now()+interval '2 minutes',
    attempts=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempts+1 ELSE 1 END,
    attempt_window=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempt_window ELSE now() END
    FROM revale.admin_users a
    WHERE a.id=i.admin_user_id AND i.token_hash=$1 AND ${eligible}
      AND (i.claim_until IS NULL OR i.claim_until<now())
      AND (i.attempt_window IS NULL OR i.attempt_window<=now()-interval '15 minutes' OR i.attempts<10)
    RETURNING i.claim_id`,[hash(token),claimId]);
  if(!row)throw problem(429,'La invitación está en uso o recibió demasiados intentos. Espera 15 minutos y vuelve a intentar.');
  return row;
}
export async function releaseAdminInvitation(sql,claimId){
  await sql.query('UPDATE revale.admin_access_invites SET claim_id=NULL,claim_until=NULL WHERE claim_id=$1',[claimId]);
}
export async function completeAdminInvitation(sql,token,claimId,user,session){
  const verified=requireMfa(session);
  if(!verified?.user||verified.user.id!==user?.id||String(verified.user.email).toLowerCase()!==String(user.email).toLowerCase())throw problem(401,'Completa tu verificación de seguridad.');
  const [row]=await sql.query(`WITH target AS (
    SELECT a.id FROM revale.admin_access_invites i JOIN revale.admin_users a ON a.id=i.admin_user_id
    WHERE i.token_hash=$1 AND i.claim_id=$2 AND i.claim_until>now() AND ${eligible}
      AND i.email=$4 AND NOT EXISTS(SELECT 1 FROM revale.admin_users other WHERE other.auth_user_id=$3::uuid)
    FOR UPDATE OF i,a
  ), linked AS (
    UPDATE revale.admin_users a SET auth_user_id=$3::uuid,active=true,updated_at=now()
    FROM target t WHERE a.id=t.id RETURNING a.id
  ), accepted AS (
    UPDATE revale.admin_access_invites i SET accepted_at=now(),claim_id=NULL,claim_until=NULL
    FROM linked a WHERE i.admin_user_id=a.id RETURNING i.admin_user_id
  ), audited AS (
    INSERT INTO revale.audit_events(actor_type,actor_id,action,resource_type,resource_id)
    SELECT 'revale_admin',$3,'admin.activated','admin_user',a.id FROM linked a JOIN accepted i ON i.admin_user_id=a.id
    RETURNING id
  ) SELECT id FROM linked`,[hash(token),claimId,user.id,String(user.email).trim().toLowerCase()]);
  if(!row)throw problem(409,'La invitación cambió o ya se utilizó. Solicita un nuevo enlace.');
  return row;
}
