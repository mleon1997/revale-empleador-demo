const store = globalThis.__revaleDemoStore || (globalThis.__revaleDemoStore = new Map());

function json(res, code, body){
  res.status(code).setHeader("Content-Type","application/json; charset=utf-8").setHeader("Cache-Control","no-store").json(body);
}
function id(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="RV-";
  for(let i=0;i<5;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function token(){
  return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
}
function clean(){
  const now=Date.now();
  for(const [k,v] of store.entries()) if(now-v.createdAt>10*60*1000) store.delete(k);
}

export default async function handler(req,res){
  clean();
  const action=(req.query && req.query.action) || "";
  if(req.method==="POST" && action==="create"){
    const amount=Number(req.body?.amount || 0);
    if(!Number.isFinite(amount) || amount<=0 || amount>500) return json(res,400,{error:"Monto inválido"});
    const tx=id(), t=token();
    const row={tx,token:t,amount:Math.round(amount*100)/100,reference:String(req.body?.reference||"").slice(0,40),status:"pending",createdAt:Date.now(),approvedAt:null};
    store.set(tx,row);
    return json(res,200,{tx,token:t,amount:row.amount,status:row.status,expiresAt:row.createdAt+5*60*1000});
  }
  if(req.method==="GET" && (action==="get" || action==="status")){
    const tx=String(req.query?.tx||"");
    const t=String(req.query?.token||"");
    const row=store.get(tx);
    if(!row || row.token!==t) return json(res,404,{error:"Transacción no encontrada"});
    if(Date.now()>row.createdAt+5*60*1000 && row.status==="pending") row.status="expired";
    return json(res,200,{tx:row.tx,amount:row.amount,reference:row.reference,status:row.status,createdAt:row.createdAt,approvedAt:row.approvedAt,expiresAt:row.createdAt+5*60*1000});
  }
  if(req.method==="POST" && action==="confirm"){
    const tx=String(req.body?.tx||"");
    const t=String(req.body?.token||"");
    const row=store.get(tx);
    if(!row || row.token!==t) return json(res,404,{error:"Transacción no encontrada"});
    if(Date.now()>row.createdAt+5*60*1000) return json(res,410,{error:"QR expirado"});
    row.status="approved"; row.approvedAt=Date.now(); store.set(tx,row);
    return json(res,200,{ok:true,status:"approved"});
  }
  return json(res,405,{error:"Acción no soportada"});
}