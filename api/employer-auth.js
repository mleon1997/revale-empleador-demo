import { getSql } from "../lib/revale-db.js";
import { ensureEmployerGovernanceSchema, teamInvitationInfo } from '../lib/revale-employer-governance.js';
import { activateTeamMember } from '../lib/revale-activation.js';
import {
  neonAuthRequest,
  forwardAuthCookies,
  getEmployerPrincipal,
  getNeonSession
} from "../lib/revale-auth.js";

function json(res,code,body){
  res.status(code)
    .setHeader("Content-Type","application/json; charset=utf-8")
    .setHeader("Cache-Control","no-store")
    .json(body);
}

async function upstreamJson(response){
  const text=await response.text();
  try{return text?JSON.parse(text):{}}catch{return{raw:text}}
}

function demoCredential(email,password){
  return email==="beneficios@demo.revale.app" && password==="beneficios-demo";
}

export default async function handler(req,res){
  const action=String(req.query?.action||"");
  try{
    if(req.method==='POST'&&req.headers?.origin&&req.headers?.host&&req.headers.origin!==`https://${req.headers.host}`&&!(req.headers.host.startsWith('localhost:')&&req.headers.origin===`http://${req.headers.host}`))return json(res,403,{ok:false,error:'Abre esta acción desde ReVale Empresas.'});
    const sql=await getSql();

    if(req.method==='POST'&&['invitation','activate'].includes(action)){
      if(!/^[A-Za-z0-9_-]{43}$/.test(String(req.body?.token||'')))return json(res,404,{ok:false,error:'Esta invitación no está disponible. Pide un nuevo enlace al administrador.'});
      await ensureEmployerGovernanceSchema(sql);
      if(action==='invitation')return json(res,200,{ok:true,invitation:await teamInvitationInfo(sql,req.body.token)});
      const upstream=await activateTeamMember(sql,req,req.body||{});
      forwardAuthCookies(upstream,res);
      return json(res,200,{ok:true});
    }

    if(req.method==="GET" && action==="session"){
      const session=await getNeonSession(req);
      if(!session)return json(res,401,{ok:false,error:"Sesión no válida"});
      const principal=await getEmployerPrincipal(sql,req);
      if(!principal)return json(res,403,{ok:false,error:"Tu usuario no tiene acceso a ReVale Empresas"});
      return json(res,200,{ok:true,user:{id:session.user.id,email:session.user.email,name:session.user.name},principal});
    }

    if(req.method==="POST" && action==="login"){
      const email=String(req.body?.email||"").trim().toLowerCase();
      const password=String(req.body?.password||"");
      if(!email||!password)return json(res,400,{ok:false,error:"Ingresa correo y contraseña"});

      const [user]=await sql.query(
        `SELECT id,display_name,active,COALESCE((to_jsonb(employer_users)->>'activation_required')::boolean,false) AS activation_required
         FROM revale.employer_users
         WHERE lower(email)=$1
         LIMIT 1`,
        [email]
      );
      if(!user?.active)return json(res,403,{ok:false,error:"Este usuario no tiene acceso activo"});
      if(user.activation_required)return json(res,403,{ok:false,error:'Activa tu acceso desde la invitación que compartió el administrador de tu empresa.'});

      let upstream=await neonAuthRequest(req,"/sign-in/email",{
        method:"POST",
        body:JSON.stringify({email,password,rememberMe:true})
      });

      if(!upstream.ok && demoCredential(email,password)){
        const signup=await neonAuthRequest(req,"/sign-up/email",{
          method:"POST",
          body:JSON.stringify({email,password,name:user.display_name||"Administrador de Beneficios"})
        });
        if(signup.ok){
          forwardAuthCookies(signup,res);
          return json(res,200,{ok:true,bootstrapped:true});
        }
      }

      if(!upstream.ok){
        const err=await upstreamJson(upstream);
        return json(res,401,{ok:false,error:err?.message||err?.error?.message||"Correo o contraseña incorrectos"});
      }

      forwardAuthCookies(upstream,res);
      return json(res,200,{ok:true});
    }

    if(req.method==="POST" && action==="logout"){
      const upstream=await neonAuthRequest(req,"/sign-out",{method:"POST",body:JSON.stringify({})});
      forwardAuthCookies(upstream,res);
      return json(res,200,{ok:true});
    }

    return json(res,405,{ok:false,error:"Acción no soportada"});
  }catch(error){
    if(!error.status)console.error("ReVale employer auth error",error);
    return json(res,error.status||500,{ok:false,error:error.status?error.message:"Error de autenticación"});
  }
}
