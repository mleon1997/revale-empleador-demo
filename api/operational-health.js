import {getSql} from '../lib/revale-db.js';
import {operationalHealth} from '../lib/revale-operational-health.js';

export function createHealthHandler({database=getSql,check=operationalHealth,log=console.error}={}){
  let cached,pending;
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET')return res.status(405).json({ok:false});
    if(!cached||Date.now()-cached.at>30000){
      if(!pending)pending=(async()=>{
        try{
          const result=await check(await database());
          if(!result.ok)log('REVALE_OPERATIONAL_ALERT',JSON.stringify(result.checks));
          cached={at:Date.now(),ok:result.ok};
        }catch{log('REVALE_OPERATIONAL_ALERT','database_or_schema_unavailable');cached={at:Date.now(),ok:false};}
      })().finally(()=>{pending=null;});
      await pending;
    }
    return res.status(cached.ok?200:503).json({ok:cached.ok});
  };
}
export default createHealthHandler();
