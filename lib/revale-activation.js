import { neonAuthRequest, getIdentitySession } from './revale-auth.js';
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
async function activateInvitation(sql,req,body,flow,{authRequest=neonAuthRequest,readSession=getIdentitySession}={}) {
  const token=String(body.token||''),password=String(body.password||''),mode=String(body.mode||'create');
  const resume=mode==='session'&&process.env.REVALE_AUTH_PROVIDER==='better-auth-mfa';
  if(!resume&&(!['create','existing'].includes(mode)||password.length<(mode==='create'?12:8)||password.length>128))throw problem(400,mode==='create'?'Crea una contraseña de entre 12 y 128 caracteres.':'Ingresa tu contraseña de ReVale.');
  const invitation=await flow.info(sql,token),claim=await flow.claim(sql,token);
  try {
    if(resume){
      const { requireMfa }=await import('./revale-identity.js');
      const session=requireMfa(await readSession(req));
      if(!session?.user||String(session.user.email).toLowerCase()!==invitation.email)throw problem(401,'Esta invitación corresponde a otro acceso.');
      await flow.complete(sql,token,claim.claim_id,session.user);
      return Response.json({ok:true});
    }
    const fresh={headers:{origin:req.headers?.origin,'x-vercel-forwarded-for':req.headers?.['x-vercel-forwarded-for']}};
    const upstream=await authRequest(fresh,mode==='create'?'/sign-up/email':'/sign-in/email',{
      method:'POST',body:JSON.stringify({email:invitation.email,password,...(mode==='create'?{name:invitation.first_name}:{rememberMe:true})})
    });
    if(!upstream.ok)throw problem(401,mode==='create'?'No pudimos crear tu acceso. Si ya tienes cuenta, elige «Ya tengo una cuenta».':'No pudimos validar tu acceso. Revisa tu contraseña y la verificación de tu correo.');
    if(process.env.REVALE_AUTH_PROVIDER==='better-auth-mfa'&&(await upstream.clone().json()).twoFactorRedirect===true)return upstream;
    const cookies=upstream.headers.getSetCookie?.()||[];
    const cookie=cookies.map(value=>value.split(';')[0]).join('; ');
    if(!cookie)throw problem(409,'Revisa tu correo para verificar tu cuenta. Después vuelve a este enlace y elige «Ya tengo una cuenta».');
    const session=await readSession({headers:{cookie,origin:req.headers?.origin}});
    if(!session?.user||String(session.user.email).toLowerCase()!==invitation.email)throw problem(401,'No pudimos validar tu sesión. Intenta nuevamente.');
    await flow.complete(sql,token,claim.claim_id,session.user);
    return upstream;
  } finally {await flow.release(sql,claim.claim_id);}
}

export async function activationResult(upstream,portal,token){
  if(process.env.REVALE_AUTH_PROVIDER!=='better-auth-mfa')return {ok:true};
  const pending=(await upstream.clone().json()).twoFactorRedirect===true;
  return {ok:true,next:'/seguridad/?portal='+portal+(pending?'&activation=1#'+token:'')};
}
