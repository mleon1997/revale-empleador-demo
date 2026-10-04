import { getSql } from "../lib/revale-db.js";
import {
  neonAuthRequest,
  forwardAuthCookies,
  getAdminPrincipal,
  getNeonSession
} from "../lib/revale-auth.js";
import { ensureFinancialApprovalSchema } from "../lib/revale-financial-approvals.js";

function json(res,code,body){
  res.status(code).setHeader("Content-Type","application/json; charset=utf-8").setHeader("Cache-Control","no-store").json(body);
}
async function upstreamJson(response){
  const text=await response.text();try{return text?JSON.parse(text):{}}catch{return{raw:text}}
}
const DEMO_ADMIN_PROFILES=[
  {
    id:"00000000-0000-4000-8000-000000000101",
    email:"ops@demo.revale.app",
    password:"ops-demo",
    displayName:"Operaciones ReVale",
    role:"ops",
    canMake:false,
    canApprove:false,
    approvalLimit:null
  },
  {
    id:"00000000-0000-4000-8000-000000000102",
    email:"maker@demo.revale.app",
    password:"maker-demo",
    displayName:"Finance Maker",
    role:"finance",
    canMake:true,
    canApprove:false,
    approvalLimit:null
  },
  {
    id:"00000000-0000-4000-8000-000000000103",
    email:"approver@demo.revale.app",
    password:"approver-demo",
    displayName:"Finance Approver",
    role:"finance",
    canMake:false,
    canApprove:true,
    approvalLimit:null
  },
  {
    id:"00000000-0000-4000-8000-000000000104",
    email:"admin@demo.revale.app",
    password:"admin-demo",
    displayName:"Superadmin ReVale",
    role:"superadmin",
    canMake:true,
    canApprove:true,
    approvalLimit:null
  }
];

function demoCredential(email,password){
  return DEMO_ADMIN_PROFILES.find(
    p=>p.email===String(email||"").toLowerCase() && p.password===String(password||"")
  )||null;
}

async function ensureDemoAdminUser(sql,profile){
  if(!profile)return null;
  await ensureFinancialApprovalSchema(sql);

  let [user]=await sql.query(
    `SELECT id::text AS id,display_name,email,role,active
     FROM revale.admin_users
     WHERE lower(email)=$1
     LIMIT 1`,
    [profile.email]
  );

  if(user){
    [user]=await sql.query(
      `UPDATE revale.admin_users
       SET display_name=$2,role=$3,active=true,updated_at=now()
       WHERE id::text=$1
       RETURNING id::text AS id,display_name,email,role,active`,
      [user.id,profile.displayName,profile.role]
    );
  }else{
    try{
      [user]=await sql.query(
        `INSERT INTO revale.admin_users (display_name,email,role,active)
         VALUES ($1,$2,$3,true)
         RETURNING id::text AS id,display_name,email,role,active`,
        [profile.displayName,profile.email,profile.role]
      );
    }catch(error){
      const message=String(error?.message||"").toLowerCase();
      if(!message.includes("null value")&&!message.includes("id")){
        throw error;
      }
      [user]=await sql.query(
        `INSERT INTO revale.admin_users (id,display_name,email,role,active)
         VALUES ($1,$2,$3,$4,true)
         RETURNING id::text AS id,display_name,email,role,active`,
        [profile.id,profile.displayName,profile.email,profile.role]
      );
    }
  }

  await sql.query(
    `INSERT INTO revale.financial_user_permissions (
       admin_user_id,can_make,can_approve,approval_limit,active,metadata,updated_by
     ) VALUES (
       $1,$2,$3,$4,true,jsonb_build_object('demo_profile',true,'role_label',$5),'demo_bootstrap'
     )
     ON CONFLICT (admin_user_id) DO UPDATE SET
       can_make=EXCLUDED.can_make,
       can_approve=EXCLUDED.can_approve,
       approval_limit=EXCLUDED.approval_limit,
       active=true,
       metadata=revale.financial_user_permissions.metadata||EXCLUDED.metadata,
       updated_by='demo_bootstrap',
       updated_at=now()`,
    [
      String(user.id),
      Boolean(profile.canMake),
      Boolean(profile.canApprove),
      profile.approvalLimit,
      profile.displayName
    ]
  );

  return user;
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

      const demoProfile=demoCredential(email,password);
      if(demoProfile)await ensureDemoAdminUser(sql,demoProfile);

      const [user]=await sql.query(
        `SELECT id,display_name,active FROM revale.admin_users WHERE lower(email)=$1 LIMIT 1`,
        [email]
      );
      if(!user?.active)return json(res,403,{ok:false,error:"Este usuario no tiene acceso activo"});

      let upstream=await neonAuthRequest(req,"/sign-in/email",{method:"POST",body:JSON.stringify({email,password,rememberMe:true})});
      if(!upstream.ok && demoProfile){
        const signup=await neonAuthRequest(req,"/sign-up/email",{method:"POST",body:JSON.stringify({email,password,name:user.display_name||demoProfile.displayName||"ReVale"})});
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
