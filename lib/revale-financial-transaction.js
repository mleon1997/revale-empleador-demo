// All financial administration mutations share a real PostgreSQL transaction.
// No external payments or notifications may be sent inside a retryable callback.
export function transactionSql(query) {
  const sql=(strings,...args)=>sql.query(strings.reduce((s,v,i)=>s+(i?'$'+i:'')+v,''),args);
  sql.inTransaction=true;
  sql.query=(text,args=[])=>{
    if(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(text))throw new Error('NESTED_TRANSACTION_CONTROL_FORBIDDEN');
    let promise;
    return {text,args,then(resolve,reject){
      if(!promise) promise=query(text,args).then(r=>r.rows).catch(error=>{sql.lastError ||= error;throw error;});
      return promise.then(resolve,reject);
    }};
  };
  sql.transaction=async queries=>{const results=[];for(const q of queries)results.push(await q);return results;};
  return sql;
}

export async function financialTransaction(sql,work) {
  if(sql.inTransaction)return work(sql);
  if(typeof sql.withTransaction!=='function')throw new Error('TRANSACTION_CONNECTION_REQUIRED');
  for(let attempt=0;attempt<5;attempt++){
    try{return await sql.withTransaction(async tx=>{
      // Settlement, reversal, withholding and treasury changes use one gate.
      // Redemption confirmations retain their existing account-level SSI path.
      await tx.query('SELECT pg_advisory_xact_lock(72638621)');
      const result=await work(tx);
      if(tx.lastError)throw tx.lastError;
      return result;
    });}catch(error){
      if(!['40001','40P01'].includes(error.code))throw error;
      if(attempt===4)throw Object.assign(new Error('Hay otra operación en proceso. Actualiza e intenta nuevamente.'),{status:409,code:'TRANSACTION_BUSY'});
    }
  }
}

export async function financialResponse(sql,res,work) {
  const result=await financialTransaction(sql,async tx=>{
    const response={code:200,headers:{},body:undefined};
    const buffered={status(code){response.code=code;return this;},setHeader(key,value){response.headers[key]=value;return this;},json(body){response.body=body;return this;}};
    await work(tx,buffered);
    if(response.code>=500)throw new Error('FINANCIAL_RESPONSE_FAILED');
    return response;
  });
  res.status(result.code);
  for(const [key,value] of Object.entries(result.headers))res.setHeader(key,value);
  return res.json(result.body);
}
