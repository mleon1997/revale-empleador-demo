import { getSql } from '../lib/revale-db.js';
import { getEmployerPrincipal } from '../lib/revale-auth.js';
import { ensureFundingTreasurySchema } from '../lib/revale-admin-funding.js';
import { ensureOnboardingSchema, previewEmployees, importEmployees, issueEmployeeInvite } from '../lib/revale-onboarding.js';
import { ensureEmployerGovernanceSchema, team, inviteTeamMember, updateTeamMember, approvalPolicy, updateApprovalPolicy, approvalInbox, approvalDetail, approvalSummary, decideFunding } from '../lib/revale-employer-governance.js';
import { overview, programs, employees, funding, fundingDetail, report, requestFunding, updateEnrollment,
  updateProgram, saveRules, upsertRule, merchantPresentation, capabilities, problem } from '../lib/revale-employer.js';

function json(res,status,body){return res.status(status).setHeader('Content-Type','application/json; charset=utf-8').setHeader('Cache-Control','private, no-store').json(body);}
export function createEmployerHandler({database=getSql,authenticate=getEmployerPrincipal,ensureSchema=async sql=>{await ensureFundingTreasurySchema(sql);await ensureOnboardingSchema(sql);await ensureEmployerGovernanceSchema(sql);}}={}) {
  return async function handler(req,res) {
    try {
      if(req.method==='POST'&&req.headers?.origin&&req.headers?.host&&req.headers.origin!==`https://${req.headers.host}`&&!(req.headers.host.startsWith('localhost:')&&req.headers.origin===`http://${req.headers.host}`))throw problem(403,'Abre esta acción desde ReVale Empresas.');
      const sql=await database(),principal=await authenticate(sql,req);
      if(!principal)return json(res,401,{ok:false,error:'Inicia sesión en ReVale Empresas.'});
      await ensureSchema(sql);
      const action=String(req.query?.action||'overview');
      const can=capabilities(principal);
      const requireCapability=key=>{if(!can[key])throw problem(403,'Tu rol no permite realizar esta acción.');};
      if(req.method==='GET') {
        const offset=Math.min(100000,Math.max(0,Math.floor(Number(req.query?.offset)||0)));
        if(action==='dashboard') {
          const [base,funds,merchants,policy,approvals]=await Promise.all([overview(sql,principal),funding(sql,principal.employerId),sql.query('SELECT id,name,slug FROM revale.merchants WHERE active=true ORDER BY name'),approvalPolicy(sql,principal.employerId),approvalSummary(sql,principal)]);
          return json(res,200,{ok:true,...base,fundingList:funds,policy,approvals,merchants:merchants.map(r=>merchantPresentation(principal,r))});
        }
        if(action==='overview')return json(res,200,{ok:true,...await overview(sql,principal)});
        if(action==='programs')return json(res,200,{ok:true,programs:await programs(sql,principal.employerId)});
        if(action==='employees')return json(res,200,{ok:true,employees:await employees(sql,principal.employerId,req.query?.program_id||null)});
        if(action==='funding')return json(res,200,{ok:true,...await funding(sql,principal.employerId,offset)});
        if(action==='funding-detail'){const id=String(req.query?.id||'');return json(res,200,{ok:true,...await fundingDetail(sql,principal.employerId,id),approval:await approvalDetail(sql,principal,id)});}
        if(action==='team')return json(res,200,{ok:true,members:await team(sql,principal),policy:await approvalPolicy(sql,principal.employerId)});
        if(action==='approvals')return json(res,200,{ok:true,...await approvalInbox(sql,principal,req.query)});
        if(action==='reports')return json(res,200,{ok:true,...await report(sql,principal,req.query)});
        if(action==='merchant-catalog') {
          const rows=await sql.query('SELECT id,name,slug FROM revale.merchants WHERE active=true ORDER BY name');
          return json(res,200,{ok:true,merchants:rows.map(r=>merchantPresentation(principal,r))});
        }
        if(action==='rules') {
          const [program]=await sql.query('SELECT id FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2',[String(req.query?.program_id||''),principal.employerId]);
          if(!program)throw problem(404,'Programa no encontrado.');
          const rules=await sql.query('SELECT id,rule_type,rule_value,priority,active FROM revale.benefit_rules WHERE program_id=$1 AND active=true ORDER BY priority,id',[program.id]);
          return json(res,200,{ok:true,rules});
        }
      }
      if(req.method==='POST') {
        if(action==='invite-team'){requireCapability('manageTeam');return json(res,200,{ok:true,invitation:await inviteTeamMember(sql,principal,req.body||{})});}
        if(action==='update-team'){requireCapability('manageTeam');return json(res,200,{ok:true,member:await updateTeamMember(sql,principal,req.body||{})});}
        if(action==='update-approval-policy'){requireCapability('managePolicy');return json(res,200,{ok:true,policy:await updateApprovalPolicy(sql,principal,req.body||{})});}
        if(action==='decide-funding'){if(req.body?.decision!=='cancel')requireCapability('approveFunding');else requireCapability('requestFunding');return json(res,200,{ok:true,...await decideFunding(sql,principal,req.body||{})});}
        if(action==='preview-employees'){requireCapability('manageEmployees');return json(res,200,{ok:true,...await previewEmployees(sql,principal,req.body||{})});}
        if(action==='import-employees'){requireCapability('manageEmployees');return json(res,200,{ok:true,...await importEmployees(sql,principal,req.body||{})});}
        if(action==='invite-employee'){requireCapability('manageEmployees');return json(res,200,{ok:true,...await issueEmployeeInvite(sql,principal,req.body||{})});}
        if(action==='request-funding'){requireCapability('requestFunding');return json(res,200,{ok:true,...await requestFunding(sql,principal,req.body||{})});}
        if(action==='update-enrollment'){requireCapability('manageEmployees');return json(res,200,{ok:true,enrollment:await updateEnrollment(sql,principal,req.body||{})});}
        if(action==='update-program'){requireCapability('manageBenefits');return json(res,200,{ok:true,program:await updateProgram(sql,principal,req.body||{})});}
        if(action==='upsert-rule'){requireCapability('manageBenefits');return json(res,200,{ok:true,rule:await upsertRule(sql,principal,req.body||{})});}
        if(action==='save-rules'){requireCapability('manageBenefits');return json(res,200,{ok:true,program:await saveRules(sql,principal,req.body||{})});}
      }
      return json(res,405,{ok:false,error:'Acción no soportada.'});
    } catch(error) {
      if(['40001','40P01','23505'].includes(error.code))error=problem(409,'Otra persona actualizó este registro o el acceso ya existe. Revisa los datos e intenta nuevamente.');
      if(!error.status)console.error('ReVale employer API error',error);
      return json(res,error.status||500,{ok:false,error:error.status?error.message:'No pudimos completar la operación. Intenta nuevamente.'});
    }
  };
}
export default createEmployerHandler();
