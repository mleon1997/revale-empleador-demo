import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { problem, moneyValue, period } from './revale-employer.js';

export const onboardingSchema = [
  `ALTER TABLE revale.persons ADD COLUMN IF NOT EXISTS activation_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS activated_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS revale.employee_imports (
    id text PRIMARY KEY, employer_id text NOT NULL REFERENCES revale.employers(id),
    request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS revale.employee_access_invites (
    person_id text PRIMARY KEY REFERENCES revale.persons(id),
    enrollment_id bigint NOT NULL REFERENCES revale.employee_enrollments(id),
    employer_id text NOT NULL REFERENCES revale.employers(id), token_hash text NOT NULL UNIQUE,
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    accepted_at timestamptz, attempts integer NOT NULL DEFAULT 0, attempt_window timestamptz,
    claim_id text, claim_until timestamptz)`,
  `CREATE INDEX IF NOT EXISTS employee_access_invites_employer_idx ON revale.employee_access_invites(employer_id,expires_at)`
];
const schemas = new WeakMap();
export async function ensureOnboardingSchema(sql) {
  if (!schemas.has(sql)) schemas.set(sql, (async()=>{
    for (const statement of onboardingSchema) await sql.query(statement);
  })());
  try { await schemas.get(sql); } catch(error) { schemas.delete(sql); throw error; }
}
const digest = value => createHash('sha256').update(value).digest('hex');
const today = () => period().to;
const clean = value => String(value ?? '').trim();
const provisioningSchemas = new WeakMap();
async function checkProvisioningSchema(sql) {
  if(provisioningSchemas.has(sql))return provisioningSchemas.get(sql);
  const ready=(async()=>{
    const supplied={persons:['id','person_identification','first_name','last_name','email','company_identification','active','activation_required'],cards:['card_number','person_id','active'],benefit_accounts:['id','card_number','balance']};
    const columns=await sql.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='revale' AND table_name IN ('persons','cards','benefit_accounts')
        AND is_nullable='NO' AND column_default IS NULL AND is_identity='NO' AND is_generated='NEVER'`);
    const missing=columns.filter(c=>!supplied[c.table_name]?.includes(c.column_name));
    if(missing.length){console.error('ReVale onboarding schema requires additional columns',missing);throw problem(503,'ReVale debe completar la configuración del alta de colaboradores. Tus datos todavía no se han incorporado.');}
  })();
  provisioningSchemas.set(sql,ready);
  try{await ready;}catch(error){provisioningSchemas.delete(sql);throw error;}
}
const identification = value => clean(value).toUpperCase().replace(/[\s-]/g,'');
const header = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const columns = {nombres:'first_name',nombre:'first_name',firstname:'first_name',apellidos:'last_name',apellido:'last_name',lastname:'last_name',correo:'email',correoelectronico:'email',email:'email',identificacion:'person_identification',cedula:'person_identification',personidentification:'person_identification',inicio:'starts_on',fechainicio:'starts_on',startson:'starts_on',departamento:'department',department:'department',centrodecosto:'cost_center',costcenter:'cost_center',monto:'allocation_amount',montousd:'allocation_amount',allocationamount:'allocation_amount'};

function csvGrid(text) {
  const first = text.split(/\r?\n/,1)[0];
  const delimiter = (first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length ? ';' : ',';
  const grid=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(ch==='"') { if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted; }
    else if(!quoted&&(ch===delimiter||ch==='\n'||ch==='\r')) {
      row.push(cell);cell='';
      if(ch!==delimiter){if(ch==='\r'&&text[i+1]==='\n')i++;grid.push(row);row=[];}
    } else cell+=ch;
    if(grid.length>502||cell.length>2000)throw problem(400,'Usa hasta 500 colaboradores por archivo y campos de menos de 2.000 caracteres.');
  }
  if(quoted)throw problem(400,'El CSV tiene comillas sin cerrar. Revisa el archivo.');
  if(cell||row.length){row.push(cell);grid.push(row);}
  return grid;
}
export async function readEmployeeRows(body) {
  if(Array.isArray(body.rows))return body.rows;
  const file=body.file;
  if(!file||!/^.+\.(csv|xlsx)$/i.test(clean(file.name))||typeof file.content!=='string'||file.content.length>2800000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))throw problem(400,'Selecciona un archivo CSV o Excel (.xlsx) de hasta 2 MB.');
  const bytes=Buffer.from(file.content,'base64');
  if(bytes.length>2000000)throw problem(400,'El archivo supera los 2 MB.');
  let grid;
  if(/\.csv$/i.test(file.name))grid=csvGrid(bytes.toString('utf8').replace(/^\uFEFF/,''));
  else {
    // Bound expanded ZIP size before ExcelJS parses an uploaded workbook.
    let expanded=0,entries=0;
    for(let i=0;i+46<bytes.length;i++)if(bytes.readUInt32LE(i)===0x02014b50){expanded+=bytes.readUInt32LE(i+24);entries++;}
    if(!entries||entries>250||expanded>12000000)throw problem(400,'El Excel es demasiado complejo. Usa la plantilla de ReVale.');
    try {
      const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);
      const sheet=workbook.worksheets[0];
      if(!sheet||sheet.rowCount>501||sheet.columnCount>20)throw problem(400,'Usa la primera hoja, con hasta 500 colaboradores y 20 columnas.');
      grid=[];
      sheet.eachRow({includeEmpty:true},row=>{const cells=[];for(let c=1;c<=sheet.columnCount;c++){
        const cell=row.getCell(c);if(cell.type===6||cell.value?.formula||cell.value?.sharedFormula)throw problem(400,'Reemplaza las fórmulas por valores antes de importar.');
        cells.push(cell.value instanceof Date?cell.value.toISOString().slice(0,10):cell.text);
      }grid.push(cells);});
    }catch(error){if(error.status)throw error;throw problem(400,'No pudimos leer ese Excel. Usa un archivo .xlsx válido.');}
  }
  const headings=(grid.shift()||[]).map(v=>columns[header(v)]||null);
  const known=headings.filter(Boolean);
  if(new Set(known).size!==known.length||!['first_name','last_name','email','person_identification'].every(v=>known.includes(v)))throw problem(400,'Incluye una sola columna de Nombres, Apellidos, Correo e Identificación.');
  return grid.filter(row=>row.some(v=>clean(v))).map(row=>Object.fromEntries(headings.flatMap((key,i)=>key?[[key,row[i]??'']]:[])));
}
export function normalizeEmployees(input) {
  if(!Array.isArray(input)||!input.length||input.length>500)throw problem(400,'Incluye entre 1 y 500 colaboradores.');
  const records=input.map((row,index)=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw problem(400,'Revisa el formato de los colaboradores.');
    const r={row:index+1,first_name:clean(row.first_name),last_name:clean(row.last_name),email:clean(row.email).toLowerCase(),person_identification:identification(row.person_identification),starts_on:clean(row.starts_on)||today(),department:clean(row.department),cost_center:clean(row.cost_center),allocation_amount:clean(row.allocation_amount)===''?null:row.allocation_amount};
    const errors=[];
    if(!r.first_name||!r.last_name||r.first_name.length>80||r.last_name.length>80)errors.push('Completa nombres y apellidos (máximo 80 caracteres).');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)||r.email.length>254)errors.push('Revisa el correo.');
    if(!/^[A-Z0-9]{5,30}$/.test(r.person_identification))errors.push('Revisa la identificación; conserva los ceros iniciales.');
    try{period({from:r.starts_on,to:r.starts_on});}catch{errors.push('Usa la fecha de inicio AAAA-MM-DD.');}
    if(r.department.length>80||r.cost_center.length>80)errors.push('Departamento y centro de costo admiten hasta 80 caracteres.');
    if(r.allocation_amount!==null)try{r.allocation_amount=moneyValue(r.allocation_amount);}catch{errors.push('El monto debe ser positivo, con hasta dos decimales.');}
    return {...r,errors};
  });
  const emails=new Map(),ids=new Map();
  for(const row of records){emails.set(row.email,(emails.get(row.email)||0)+1);ids.set(row.person_identification,(ids.get(row.person_identification)||0)+1);}
  for(const row of records)if(emails.get(row.email)>1||ids.get(row.person_identification)>1)row.errors.push('Correo o identificación repetidos dentro de la carga.');
  return records;
}
const identityMatch = `lower(p.email)=r.email OR regexp_replace(upper(p.person_identification),'[[:space:]-]','','g')=r.person_identification`;
export async function previewEmployees(sql, principal, body) {
  const rows=normalizeEmployees(await readEmployeeRows(body));
  const [program]=await sql.query('SELECT id,name FROM revale.benefit_programs WHERE id=$1 AND employer_id=$2 AND active=true',[String(body.program_id||''),principal.employerId]);
  if(!program)throw problem(404,'Elige un beneficio activo de tu empresa.');
  await checkProvisioningSchema(sql);
  const checks=await sql.query(`SELECT r.row,
    EXISTS(SELECT 1 FROM revale.persons p WHERE ${identityMatch}) AS found,
    EXISTS(SELECT 1 FROM revale.persons p JOIN revale.employee_enrollments ee ON ee.person_id=p.id
      WHERE ee.program_id=$2 AND lower(p.email)=r.email AND regexp_replace(upper(p.person_identification),'[[:space:]-]','','g')=r.person_identification) AS enrolled
    FROM jsonb_to_recordset($1::jsonb) AS r(row int,email text,person_identification text)`,[JSON.stringify(rows),program.id]);
  for(const row of rows){const check=checks.find(c=>c.row===row.row);if(check.found&&!check.enrolled)row.errors.push('Estos datos requieren revisión con ReVale antes de vincularlos.');row.status=row.errors.length?'error':check.enrolled?'existing':'new';}
  return {program,rows,summary:{new:rows.filter(r=>r.status==='new').length,existing:rows.filter(r=>r.status==='existing').length,errors:rows.filter(r=>r.status==='error').length}};
}
export async function importEmployees(sql, principal, body) {
  const rows=normalizeEmployees(body.rows);const programId=String(body.program_id||''),key=String(body.request_id||'');
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw problem(400,'Vuelve a revisar la carga antes de confirmarla.');
  const hash=digest(JSON.stringify([programId,rows]));const id='imp_'+digest(principal.employerId+':'+key).slice(0,32);
  const [previous]=await sql.query('SELECT request_hash,result FROM revale.employee_imports WHERE id=$1 AND employer_id=$2',[id,principal.employerId]);
  if(previous){if(previous.request_hash!==hash)throw problem(409,'La carga ya se utilizó con otros datos.');return {...previous.result,idempotent:true};}
  const preview=await previewEmployees(sql,principal,{program_id:programId,rows});
  if(preview.summary.errors)throw problem(400,'Corrige todas las filas señaladas antes de incorporar al equipo.');
  const input=preview.rows.map(r=>({...r,person_id:'person_'+randomUUID().replaceAll('-',''),card_number:'RV-'+randomBytes(10).toString('hex').toUpperCase(),account_id:'acct_'+randomUUID().replaceAll('-','')}));
  const query=`WITH program AS (
    SELECT bp.id,e.tax_id FROM revale.benefit_programs bp JOIN revale.employers e ON e.id=bp.employer_id
    WHERE bp.id=$2 AND e.id=$3 AND bp.active AND e.active FOR SHARE OF bp,e
  ), source AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS r(row int,first_name text,last_name text,email text,person_identification text,starts_on date,department text,cost_center text,allocation_amount numeric,status text,person_id text,card_number text,account_id text)),
  valid AS (SELECT r.* FROM source r WHERE
    (r.status='new' AND NOT EXISTS(SELECT 1 FROM revale.persons p WHERE ${identityMatch})) OR
    (r.status='existing' AND EXISTS(SELECT 1 FROM revale.persons p JOIN revale.employee_enrollments ee ON ee.person_id=p.id WHERE ee.program_id=$2 AND lower(p.email)=r.email AND regexp_replace(upper(p.person_identification),'[[:space:]-]','','g')=r.person_identification))
  ), gate AS (SELECT 1 FROM program WHERE (SELECT COUNT(*) FROM valid)=(SELECT COUNT(*) FROM source)
    AND NOT EXISTS(SELECT 1 FROM revale.employee_imports WHERE id=$1)),
  people AS (
    INSERT INTO revale.persons(id,person_identification,first_name,last_name,email,company_identification,active,activation_required)
    SELECT r.person_id,r.person_identification,r.first_name,r.last_name,r.email,p.tax_id,true,true FROM valid r CROSS JOIN program p CROSS JOIN gate WHERE r.status='new' RETURNING id
  ), cards AS (
    INSERT INTO revale.cards(card_number,person_id,active) SELECT r.card_number,p.id,true FROM people p JOIN valid r ON r.person_id=p.id RETURNING card_number
  ), accounts AS (
    INSERT INTO revale.benefit_accounts(id,card_number,balance) SELECT r.account_id,c.card_number,0 FROM cards c JOIN valid r ON r.card_number=c.card_number RETURNING id
  ), enrolled AS (
    INSERT INTO revale.employee_enrollments(program_id,person_id,starts_on,metadata)
    SELECT $2,p.id,r.starts_on,jsonb_build_object('department',r.department,'cost_center',r.cost_center,'allocation_amount',r.allocation_amount,'source','employer_onboarding','import_id',$1::text)
    FROM people p JOIN valid r ON r.person_id=p.id JOIN accounts a ON a.id=r.account_id RETURNING id,person_id
  ), saved AS (
    INSERT INTO revale.employee_imports(id,employer_id,request_hash,result)
    SELECT $1,$3,$5,jsonb_build_object('created',(SELECT COUNT(*) FROM enrolled),'existing',(SELECT COUNT(*) FROM valid WHERE status='existing'),'enrollment_ids',COALESCE((SELECT jsonb_agg(id::text) FROM enrolled),'[]'::jsonb)) FROM gate
    RETURNING result
  ), audited AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    SELECT $3,'employer_user',$6,'employees.imported','employee_import',$1,result FROM saved RETURNING id
  ) SELECT result FROM saved`;
  const [result]=await sql.transaction([sql.query(query,[id,programId,principal.employerId,JSON.stringify(input),hash,principal.employerUserId])],{isolationLevel:'Serializable'});
  if(!result[0])throw problem(409,'El equipo cambió durante la revisión. Vuelve a revisar la carga.');
  return {...result[0].result,idempotent:false};
}

export async function issueEmployeeInvite(sql, principal, body) {
  const enrollmentId=String(body.enrollment_id||'');if(!/^\d+$/.test(enrollmentId))throw problem(400,'Selecciona un colaborador.');
  const token=randomBytes(32).toString('base64url');
  const [row]=await sql.query(`WITH target AS (
    SELECT p.id,ee.id AS enrollment_id,p.first_name,p.email FROM revale.persons p
    JOIN revale.employee_enrollments ee ON ee.person_id=p.id JOIN revale.benefit_programs bp ON bp.id=ee.program_id
    WHERE ee.id=$1::bigint AND bp.employer_id=$2 AND ee.status='active' AND bp.active AND p.active AND p.auth_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM revale.employee_enrollments other JOIN revale.benefit_programs ob ON ob.id=other.program_id WHERE other.person_id=p.id AND ob.employer_id<>$2)
    FOR UPDATE OF p
  ), issued AS (
    INSERT INTO revale.employee_access_invites(person_id,enrollment_id,employer_id,token_hash,created_by,expires_at)
    SELECT id,enrollment_id,$2,$3,$4,now()+interval '72 hours' FROM target
    ON CONFLICT(person_id) DO UPDATE SET enrollment_id=EXCLUDED.enrollment_id,employer_id=EXCLUDED.employer_id,token_hash=EXCLUDED.token_hash,created_by=EXCLUDED.created_by,created_at=now(),expires_at=EXCLUDED.expires_at,accepted_at=NULL,attempts=0,attempt_window=NULL,claim_id=NULL,claim_until=NULL
    RETURNING person_id,expires_at
  ), guarded AS (
    UPDATE revale.persons p SET activation_required=true WHERE id IN(SELECT person_id FROM issued) RETURNING id
  ), audited AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id)
    SELECT $2,'employer_user',$4,'employee.invitation_created','employee_enrollment',$1 FROM issued RETURNING id
  ) SELECT i.expires_at,t.first_name,t.email FROM issued i JOIN target t ON t.id=i.person_id`,[enrollmentId,principal.employerId,digest(token),principal.employerUserId]);
  if(!row)throw problem(409,'Este acceso ya está activado o la vinculación no permite una invitación.');
  return {...row,url:'https://mi.revale.app/activar/#'+token};
}

function tokenHash(token){if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||'')))throw problem(404,'Esta invitación no está disponible. Solicita un nuevo enlace a tu empresa.');return digest(token);}
export async function invitationInfo(sql, token) {
  const [row]=await sql.query(`SELECT p.first_name,p.email,e.name AS employer_name,bp.name AS program_name,i.expires_at
    FROM revale.employee_access_invites i JOIN revale.persons p ON p.id=i.person_id
    JOIN revale.employee_enrollments ee ON ee.id=i.enrollment_id JOIN revale.benefit_programs bp ON bp.id=ee.program_id
    JOIN revale.employers e ON e.id=i.employer_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at>now() AND p.active AND p.auth_user_id IS NULL
      AND ee.status='active' AND bp.active AND e.active AND (ee.ends_on IS NULL OR ee.ends_on>=(now() AT TIME ZONE 'America/Guayaquil')::date)`,[tokenHash(token)]);
  if(!row)throw problem(404,'Esta invitación venció o ya se utilizó. Pide un nuevo enlace a tu empresa o ingresa a tu cuenta.');
  return row;
}
export async function claimInvitation(sql, token) {
  await invitationInfo(sql,token);const claimId=randomUUID();
  const [row]=await sql.query(`UPDATE revale.employee_access_invites SET claim_id=$2,claim_until=now()+interval '90 seconds',
    attempts=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempts+1 ELSE 1 END,
    attempt_window=CASE WHEN attempt_window>now()-interval '15 minutes' THEN attempt_window ELSE now() END
    WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() AND (claim_until IS NULL OR claim_until<now())
      AND (attempts<5 OR attempt_window IS NULL OR attempt_window<=now()-interval '15 minutes')
    RETURNING person_id,employer_id,enrollment_id,claim_id`,[tokenHash(token),claimId]);
  if(!row)throw problem(429,'Espera unos minutos antes de volver a intentar la activación.');
  return row;
}
export async function releaseInvitation(sql, claimId) {await sql.query('UPDATE revale.employee_access_invites SET claim_id=NULL,claim_until=NULL WHERE claim_id=$1 AND accepted_at IS NULL',[claimId]);}
export async function completeInvitation(sql, token, claimId, user) {
  if(!/^[0-9a-f-]{36}$/i.test(String(user?.id||''))||!user?.email)throw problem(401,'No pudimos validar tu cuenta. Intenta ingresar nuevamente.');
  const [row]=await sql.query(`WITH target AS (
    SELECT i.person_id,i.employer_id,i.enrollment_id FROM revale.employee_access_invites i
    JOIN revale.persons p ON p.id=i.person_id JOIN revale.employee_enrollments ee ON ee.id=i.enrollment_id
    JOIN revale.benefit_programs bp ON bp.id=ee.program_id JOIN revale.employers e ON e.id=i.employer_id
    WHERE i.token_hash=$1 AND i.claim_id=$2 AND i.claim_until>now() AND i.expires_at>now() AND i.accepted_at IS NULL
      AND p.auth_user_id IS NULL AND p.active AND lower(p.email)=$4 AND ee.status='active' AND bp.active AND e.active
      AND (ee.ends_on IS NULL OR ee.ends_on>=(now() AT TIME ZONE 'America/Guayaquil')::date)
      AND NOT EXISTS(SELECT 1 FROM revale.persons other WHERE other.auth_user_id=$3::uuid)
    FOR UPDATE OF i,p
  ), linked AS (
    UPDATE revale.persons p SET auth_user_id=$3::uuid,activation_required=false,activated_at=now(),updated_at=now()
    FROM target t WHERE p.id=t.person_id RETURNING p.id,t.employer_id,t.enrollment_id
  ), accepted AS (
    UPDATE revale.employee_access_invites i SET accepted_at=now(),claim_id=NULL,claim_until=NULL FROM linked p WHERE i.person_id=p.id RETURNING i.person_id
  ), audited AS (
    INSERT INTO revale.audit_events(employer_id,actor_type,actor_id,action,resource_type,resource_id)
    SELECT p.employer_id,'employee',$3,'employee.activated','employee_enrollment',p.enrollment_id::text FROM linked p JOIN accepted i ON i.person_id=p.id RETURNING id
  ) SELECT id FROM linked`,[tokenHash(token),claimId,user.id,String(user.email).trim().toLowerCase()]);
  if(!row)throw problem(409,'La invitación cambió o ya se utilizó. Solicita un nuevo enlace.');
  return row;
}
