import { neonAuthRequest, getNeonSession } from './revale-auth.js';
import { invitationInfo, claimInvitation, releaseInvitation, completeInvitation } from './revale-onboarding.js';
import { problem } from './revale-employer.js';
import { teamInvitationInfo, claimTeamInvitation, releaseTeamInvitation, completeTeamInvitation } from './revale-employer-governance.js';

// Credentials stay in the identity provider. ReVale only binds an authenticated
// identity to the person named by a valid, single-use company invitation.
export async function activateEmployee(sql,req,body,options={}) {
  return activateInvitation(sql,req,body,{info:invitationInfo,claim:claimInvitation,release:releaseInvitation,complete:completeInvitation},options);
}
export async function activateTeamMember(sql,req,body,options={}) {
  return activateInvitation(sql,req,body,{info:teamInvitationInfo,claim:claimTeamInvitation,release:releaseTeamInvitation,complete:completeTeamInvitation},options);
}
async function activateInvitation(sql,req,body,flow,{authRequest=neonAuthRequest,readSession=getNeonSession}={}) {
  const token=String(body.token||''),password=String(body.password||''),mode=String(body.mode||'create');
  if(!['create','existing'].includes(mode)||password.length<(mode==='create'?12:8)||password.length>128)throw problem(400,mode==='create'?'Crea una contraseña de entre 12 y 128 caracteres.':'Ingresa tu contraseña de ReVale.');
  const invitation=await flow.info(sql,token),claim=await flow.claim(sql,token);
  try {
    const fresh={headers:{origin:req.headers?.origin}};
    const upstream=await authRequest(fresh,mode==='create'?'/sign-up/email':'/sign-in/email',{
      method:'POST',body:JSON.stringify({email:invitation.email,password,...(mode==='create'?{name:invitation.first_name}:{rememberMe:true})})
    });
    if(!upstream.ok)throw problem(401,mode==='create'?'No pudimos crear tu acceso. Si ya tienes cuenta, elige «Ya tengo una cuenta».':'No pudimos validar tu acceso. Revisa tu contraseña y la verificación de tu correo.');
    const cookies=upstream.headers.getSetCookie?.()||[];
    const cookie=cookies.map(value=>value.split(';')[0]).join('; ');
    if(!cookie)throw problem(409,'Revisa tu correo para verificar tu cuenta. Después vuelve a este enlace y elige «Ya tengo una cuenta».');
    const session=await readSession({headers:{cookie,origin:req.headers?.origin}});
    if(!session?.user||String(session.user.email).toLowerCase()!==invitation.email)throw problem(401,'No pudimos validar tu sesión. Intenta nuevamente.');
    await flow.complete(sql,token,claim.claim_id,session.user);
    return upstream;
  } finally {await flow.release(sql,claim.claim_id);}
}
