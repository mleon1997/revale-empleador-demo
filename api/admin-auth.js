import { getSql } from "../lib/revale-db.js";
import {
  neonAuthRequest,
  forwardAuthCookies,
  getAdminPrincipal,
  getNeonSession
} from "../lib/revale-auth.js";

function json(res,code,body){
  res.status(code).setHeader("Content-Type","application/json; charset=utf-8").setHeader("Cache-Control","no-store").json(body);
}
async function upstreamJson(response){
  const text=await response.text();try{return text?JSON.parse(text):{}}catch{return{raw:text}}
}
function demoCredential(email,password){
  return email==="ops@demo.revale.app" && password==="ops-demo";
}

export default async function handler(req,res){
  const action=String(req.query?.action||"");
  try{
    const sql=await getSql();

    if(req.method==="GET" && action==="session"){
      const session=await getNeonSession(req);
      if(!session)return json(res,401,{ok:false,error:"Sesión no válida"});
      const principal=await getAdminPrincipal(sql,req);
      if(!principal)return json(res,403,{ok:false,error:"Tu usuario no tiene acceso al Back Office ReVale"});
      return json(res,200,{ok:true,user:{id:session.user.id,email:session.user.email,name:session.user.name},principal});
    }

    if(req.method==="POST" && action==="login"){
      const email=String(req.body?.email||"").trim().toLowerCase();
      const password=String(req.body?.password||"");
      if(!email||!password)return json(res,400,{ok:false,error:"Ingresa correo y contraseña"});

      const [user]=await sql.query(
        `SELECT id,display_name,active FROM revale.admin_users WHERE lower(email)=$1 LIMIT 1`,
        [email]
      );
      if(!user?.active)return json(res,403,{ok:false,error:"Este usuario no tiene acceso activo"});

      let upstream=await neonAuthRequest(req,"/sign-in/email",{method:"POST",body:JSON.stringify({email,password,rememberMe:true})});
      if(!upstream.ok && demoCredential(email,password)){
        const signup=await neonAuthRequest(req,"/sign-up/email",{method:"POST",body:JSON.stringify({email,password,name:user.display_name||"Operaciones ReVale"})});
        if(signup.ok){forwardAuthCookies(signup,res);return json(res,200,{ok:true,bootstrapped:true})}
      }
      if(!upstream.ok){
        const err=await upstreamJson(upstream);
        return json(res,401,{ok:false,error:err?.message||err?.error?.message||"Correo o contraseña incorrectos"});
      }
      forwardAuthCookies(upstream,res);return json(res,200,{ok:true});
    }

    if(req.method==="POST" && action==="logout"){
      const upstream=await neonAuthRequest(req,"/sign-out",{method:"POST",body:JSON.stringify({})});
      forwardAuthCookies(upstream,res);return json(res,200,{ok:true});
    }

    return json(res,405,{ok:false,error:"Acción no soportada"});
  }catch(error){
    console.error("ReVale admin auth error",error);
    return json(res,500,{ok:false,error:"Error de autenticación"});
  }
}
