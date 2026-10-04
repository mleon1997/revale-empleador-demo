import { createHash } from "node:crypto";

function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}
function safeId(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,100);
}
function normalizeText(value){
  return String(value??"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function normalizeRef(value){
  return normalizeText(value).replace(/\s+/g,"");
}
function displayValue(value){
  if(value instanceof Date)return value.toISOString();
  if(value===null||value===undefined)return "";
  if(typeof value==="object"){
    if("result" in value)return displayValue(value.result);
    if("text" in value)return String(value.text||"");
    if("richText" in value)return (value.richText||[]).map(x=>x.text||"").join("");
    if("hyperlink" in value)return String(value.text||value.hyperlink||"");
    return JSON.stringify(value);
  }
  return String(value);
}
function parseMoney(value){
  if(typeof value==="number"&&Number.isFinite(value))return round2(value);
  let s=String(value??"").trim();
  if(!s)return null;
  let negative=false;
  if(/^\(.*\)$/.test(s)){negative=true;s=s.slice(1,-1)}
  s=s.replace(/[^0-9,.-]/g,"");
  if(!s)return null;
  const lastComma=s.lastIndexOf(","),lastDot=s.lastIndexOf(".");
  if(lastComma>=0&&lastDot>=0){
    if(lastComma>lastDot)s=s.replace(/\./g,"").replace(",",".");
    else s=s.replace(/,/g,"");
  }else if(lastComma>=0){
    const decimals=s.length-lastComma-1;
    s=decimals>0&&decimals<=2?s.replace(/\./g,"").replace(",","."):s.replace(/,/g,"");
  }else{
    const parts=s.split(".");
    if(parts.length>2)s=parts.slice(0,-1).join("")+"."+parts.at(-1);
  }
  const n=Number(s);
  if(!Number.isFinite(n))return null;
  return round2(negative?-Math.abs(n):n);
}
function excelSerialToDate(serial){
  const utc=Math.round((Number(serial)-25569)*86400*1000);
  const d=new Date(utc);
  return Number.isNaN(d.getTime())?null:d;
}
function parseDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value==="number"&&value>25000&&value<80000){
    return excelSerialToDate(value)?.toISOString().slice(0,10)||null;
  }
  const s=String(value??"").trim();
  if(!s)return null;
  let m=s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if(m)return [m[1],m[2].padStart(2,"0"),m[3].padStart(2,"0")].join("-");
  m=s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if(m){
    let y=m[3];if(y.length===2)y=(Number(y)>=70?"19":"20")+y;
    return [y,m[2].padStart(2,"0"),m[1].padStart(2,"0")].join("-");
  }
  const d=new Date(s);
  return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
function daysBetween(a,b){
  if(!a||!b)return 99;
  return Math.abs((new Date(a+"T12:00:00Z")-new Date(b+"T12:00:00Z"))/86400000);
}

let bankReconSchemaPromise=null;

async function bootstrapBankReconSchema(sql){
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.bank_statement_imports (
      id text PRIMARY KEY,
      treasury_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
      filename text NOT NULL,
      file_format text NOT NULL CHECK (file_format IN ('csv','xlsx')),
      file_hash text NOT NULL,
      status text NOT NULL DEFAULT 'imported'
        CHECK (status IN ('imported','reviewed','completed','failed')),
      row_count integer NOT NULL DEFAULT 0,
      duplicate_count integer NOT NULL DEFAULT 0,
      matched_count integer NOT NULL DEFAULT 0,
      unmatched_count integer NOT NULL DEFAULT 0,
      imported_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(treasury_account_id,file_hash)
    )
  `);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.bank_statement_entries (
      id text PRIMARY KEY,
      import_id text NOT NULL REFERENCES revale.bank_statement_imports(id),
      treasury_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
      booking_date date NOT NULL,
      value_date date,
      description text,
      bank_reference text,
      amount numeric(16,2) NOT NULL CHECK (amount <> 0),
      balance_after numeric(16,2),
      currency char(3) NOT NULL DEFAULT 'USD',
      fingerprint text NOT NULL,
      match_status text NOT NULL DEFAULT 'unmatched'
        CHECK (match_status IN ('unmatched','suggested','matched','ignored')),
      suggested_type text,
      suggested_id text,
      suggested_score integer,
      suggested_reason text,
      matched_type text,
      matched_id text,
      matched_by text,
      matched_at timestamptz,
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(treasury_account_id,fingerprint)
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS bank_statement_entries_review_idx
      ON revale.bank_statement_entries(treasury_account_id,match_status,booking_date DESC)
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS bank_statement_entries_import_idx
      ON revale.bank_statement_entries(import_id,booking_date,id)
  `);
}

export async function ensureBankReconciliationSchema(sql){
  if(!bankReconSchemaPromise)bankReconSchemaPromise=bootstrapBankReconSchema(sql);
  try{await bankReconSchemaPromise}
  catch(error){bankReconSchemaPromise=null;throw error}
}

function parseCsv(text){
  const input=String(text||"").replace(/^\uFEFF/,"");
  const firstLines=input.split(/\r?\n/).slice(0,8).join("\n");
  const delimiters=[",",";","\t","|"];
  const scores=delimiters.map(d=>({d,count:Math.max(firstLines.split(d).length-1,0)}));
  scores.sort((a,b)=>b.count-a.count);
  const delimiter=scores[0].count?scores[0].d:",";
  const rows=[];let row=[],field="",quoted=false;
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    if(ch==='"'){
      if(quoted&&input[i+1]==='"'){field+='"';i++}
      else quoted=!quoted;
    }else if(ch===delimiter&&!quoted){
      row.push(field);field="";
    }else if((ch==="\n"||ch==="\r")&&!quoted){
      if(ch==="\r"&&input[i+1]==="\n")i++;
      row.push(field);field="";
      if(row.some(x=>String(x).trim()!==""))rows.push(row);
      row=[];
    }else field+=ch;
  }
  row.push(field);
  if(row.some(x=>String(x).trim()!==""))rows.push(row);
  return rows;
}

async function parseWorkbook(buffer){
  const mod=await import("exceljs");
  const ExcelJS=mod.default||mod;
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet=workbook.worksheets[0];
  if(!sheet)throw new Error("XLSX_NO_SHEET");
  const rows=[];
  sheet.eachRow({includeEmpty:false},row=>{
    const values=[];
    for(let i=1;i<=row.cellCount;i++)values.push(row.getCell(i).value);
    rows.push(values);
  });
  return rows;
}

function headerScore(row){
  const known=[
    "fecha","date","movimiento","contable","booking","valor","value",
    "descripcion","description","detalle","concepto","glosa","memo",
    "referencia","reference","documento","comprobante",
    "debito","debit","cargo","credito","credit","abono","monto","importe","amount","saldo","balance"
  ];
  return row.reduce((score,v)=>{
    const n=normalizeText(displayValue(v));
    return score+known.reduce((s,k)=>s+(n.includes(k)?1:0),0);
  },0);
}
function detectHeaderRow(rows){
  let bestIndex=0,best=-1;
  for(let i=0;i<Math.min(rows.length,20);i++){
    const score=headerScore(rows[i]||[]);
    if(score>best){best=score;bestIndex=i}
  }
  if(best<=0){
    let maxCells=-1;
    for(let i=0;i<Math.min(rows.length,20);i++){
      const cells=(rows[i]||[]).filter(x=>displayValue(x).trim()!=="").length;
      if(cells>maxCells){maxCells=cells;bestIndex=i}
    }
  }
  return bestIndex;
}
function uniqueHeaders(row){
  const seen=new Map();
  return (row||[]).map((v,i)=>{
    let name=displayValue(v).trim()||("Columna "+(i+1));
    const count=seen.get(name)||0;seen.set(name,count+1);
    if(count)name+=" ("+(count+1)+")";
    return name;
  });
}
function autoMapping(headers){
  const normalized=headers.map(h=>normalizeText(h));
  const find=(terms)=>{
    let best=-1,bestScore=0;
    normalized.forEach((h,i)=>{
      let score=0;
      for(const term of terms)if(h===term)score+=4;else if(h.includes(term))score+=2;
      if(score>bestScore){bestScore=score;best=i}
    });
    return best>=0?headers[best]:null;
  };
  return {
    booking_date:find(["fecha movimiento","fecha contable","fecha","booking date","transaction date","date"]),
    value_date:find(["fecha valor","value date"]),
    description:find(["descripcion","detalle","concepto","glosa","memo","description"]),
    reference:find(["referencia","nro documento","documento","comprobante","reference","ref"]),
    amount:find(["monto","importe","valor movimiento","amount","importe total"]),
    debit:find(["debito","debit","cargo","retiro"]),
    credit:find(["credito","credit","abono","deposito"]),
    balance:find(["saldo disponible","saldo","balance"])
  };
}
async function parseInputFile({filename,text=null,dataBase64=null}){
  const name=String(filename||"extracto").toLowerCase();
  if(name.endsWith(".xlsx")){
    if(!dataBase64)throw new Error("XLSX_DATA_REQUIRED");
    const buffer=Buffer.from(String(dataBase64),"base64");
    if(buffer.length>3_000_000)throw new Error("FILE_TOO_LARGE");
    return {format:"xlsx",rows:await parseWorkbook(buffer),bytes:buffer};
  }
  const csv=String(text||"");
  const bytes=Buffer.from(csv,"utf8");
  if(bytes.length>3_000_000)throw new Error("FILE_TOO_LARGE");
  return {format:"csv",rows:parseCsv(csv),bytes};
}

function rowObjects(rows,headerIndex,headers){
  return rows.slice(headerIndex+1).map((row,rowOffset)=>{
    const obj={};
    headers.forEach((h,i)=>{obj[h]=row[i]});
    return {rowNumber:headerIndex+2+rowOffset,obj};
  });
}
function cell(obj,key){
  return key&&Object.prototype.hasOwnProperty.call(obj,key)?obj[key]:null;
}
function normalizeStatementRows(rows,headerIndex,headers,mapping,currency){
  const normalized=[];
  for(const {rowNumber,obj} of rowObjects(rows,headerIndex,headers)){
    const booking=parseDate(cell(obj,mapping.booking_date));
    if(!booking)continue;
    let amount=null;
    if(mapping.debit||mapping.credit){
      const debit=Math.abs(parseMoney(cell(obj,mapping.debit))||0);
      const credit=Math.abs(parseMoney(cell(obj,mapping.credit))||0);
      amount=round2(credit-debit);
    }else{
      amount=parseMoney(cell(obj,mapping.amount));
    }
    if(!amount)continue;
    const reference=displayValue(cell(obj,mapping.reference)).trim().slice(0,200)||null;
    const description=displayValue(cell(obj,mapping.description)).trim().slice(0,500)||null;
    const valueDate=parseDate(cell(obj,mapping.value_date));
    const balance=parseMoney(cell(obj,mapping.balance));
    normalized.push({
      rowNumber,bookingDate:booking,valueDate,description,reference,amount,
      balanceAfter:balance,currency:String(currency||"USD").trim().toUpperCase().slice(0,3),
      raw:{source_row:rowNumber}
    });
  }
  return normalized;
}
function fingerprint(accountId,row){
  const source=[
    accountId,row.bookingDate,round2(row.amount).toFixed(2),
    normalizeRef(row.reference||""),normalizeText(row.description||""),
    Number(row.occurrence||1)
  ].join("|");
  return createHash("sha256").update(source).digest("hex");
}

export async function previewBankStatement({filename,text=null,dataBase64=null}){
  const parsed=await parseInputFile({filename,text,dataBase64});
  if(!parsed.rows.length)return {code:"empty"};
  const headerIndex=detectHeaderRow(parsed.rows);
  const headers=uniqueHeaders(parsed.rows[headerIndex]||[]);
  const sample=rowObjects(parsed.rows,headerIndex,headers).slice(0,6).map(x=>({
    rowNumber:x.rowNumber,
    values:Object.fromEntries(Object.entries(x.obj).map(([k,v])=>[k,displayValue(v)]))
  }));
  return {
    code:"ok",format:parsed.format,headerRow:headerIndex+1,headers,
    mapping:autoMapping(headers),sample,totalRows:Math.max(parsed.rows.length-headerIndex-1,0)
  };
}

function refSimilarity(entry,candidate){
  const er=normalizeRef(entry.bank_reference||"");
  const cr=normalizeRef(candidate.reference||"");
  if(!er||!cr)return 0;
  if(er===cr)return 35;
  if(er.length>=5&&cr.length>=5&&(er.includes(cr)||cr.includes(er)))return 25;
  return 0;
}
function descriptionSimilarity(entry,candidate){
  const d=normalizeText(entry.description||"");
  if(!d)return 0;
  let score=0;
  for(const token of [candidate.id,candidate.externalRef,candidate.partyName]){
    const n=normalizeText(token||"");
    if(n&&n.length>=4&&d.includes(n))score=Math.max(score,n===normalizeText(candidate.externalRef||"")?25:15);
  }
  return score;
}
function candidateScore(entry,candidate){
  const diff=Math.abs(Number(entry.amount)-Number(candidate.signedAmount));
  let score=0,reasons=[];
  if(diff<=0.01){score+=55;reasons.push("monto exacto")}
  else if(Math.abs(candidate.signedAmount)>0&&diff/Math.abs(candidate.signedAmount)<=0.005){score+=40;reasons.push("monto cercano")}
  else if(candidate.type==="funding_batch" && Number(entry.amount)>0 &&
          Number(entry.amount)<Number(candidate.signedAmount)){
    score+=25;reasons.push("abono parcial")
  }else return {score:0,reason:"monto distinto"};
  const refScore=refSimilarity(entry,candidate);
  if(refScore){score+=refScore;reasons.push(refScore===35?"referencia exacta":"referencia similar")}
  const descScore=descriptionSimilarity(entry,candidate);
  if(descScore){score+=descScore;reasons.push("descripción relacionada")}
  const days=daysBetween(entry.booking_date,candidate.date);
  if(days===0){score+=10;reasons.push("misma fecha")}
  else if(days<=1){score+=8;reasons.push("fecha ±1 día")}
  else if(days<=3){score+=5;reasons.push("fecha ±3 días")}
  else if(days<=7){score+=2;reasons.push("fecha cercana")}
  return {score:Math.min(score,100),reason:reasons.join(" · ")};
}

async function matchingCandidates(sql,accountId,minDate,maxDate){
  const start=new Date(minDate+"T00:00:00Z");start.setUTCDate(start.getUTCDate()-14);
  const end=new Date(maxDate+"T23:59:59Z");end.setUTCDate(end.getUTCDate()+14);
  const startDate=start.toISOString().slice(0,10),endDate=end.toISOString().slice(0,10);

  const receipts=await sql.query(
    `SELECT r.id,r.amount::float8 AS amount,r.bank_reference,r.bank_posted_on,e.name AS employer_name
     FROM revale.employer_funding_receipts r
     JOIN revale.employers e ON e.id=r.employer_id
     WHERE r.treasury_account_id=$1 AND r.status='confirmed'
       AND r.bank_posted_on BETWEEN $2::date AND $3::date`,
    [accountId,startDate,endDate]
  );
  const refunds=await sql.query(
    `SELECT r.id,r.amount::float8 AS amount,r.bank_reference,r.bank_posted_on,e.name AS employer_name
     FROM revale.employer_funding_refunds r
     JOIN revale.employers e ON e.id=r.employer_id
     WHERE r.treasury_account_id=$1 AND r.status='confirmed'
       AND r.bank_posted_on BETWEEN $2::date AND $3::date`,
    [accountId,startDate,endDate]
  );
  const payouts=await sql.query(
    `SELECT p.id::text AS id,p.amount::float8 AS amount,p.payout_reference,
            COALESCE(p.completed_at,p.scheduled_at) AS movement_at,p.status,
            s.id AS settlement_id,m.name AS merchant_name
     FROM revale.settlement_payouts p
     JOIN revale.settlements s ON s.id=p.settlement_id
     JOIN revale.merchants m ON m.id=s.merchant_id
     WHERE p.source_treasury_account_id=$1
       AND p.status IN ('scheduled','processing','paid')
       AND COALESCE(p.completed_at,p.scheduled_at)::date BETWEEN $2::date AND $3::date`,
    [accountId,startDate,endDate]
  );
  const transfers=await sql.query(
    `SELECT t.id,t.amount::float8 AS amount,t.bank_reference,t.bank_posted_on,t.transfer_type,
            t.from_account_id,t.to_account_id
     FROM revale.treasury_internal_transfers t
     WHERE t.status='confirmed'
       AND (t.from_account_id=$1 OR t.to_account_id=$1)
       AND t.bank_posted_on BETWEEN $2::date AND $3::date`,
    [accountId,startDate,endDate]
  );
  const batches=await sql.query(
    `SELECT
       fb.id,fb.external_reference,fb.created_at::date AS created_on,e.name AS employer_name,
       GREATEST(
         COALESCE((
           SELECT SUM(i.amount)
           FROM revale.funding_batch_items i
           WHERE i.funding_batch_id=fb.id AND i.status IN ('pending','allocated')
         ),0)
         - COALESCE((
           SELECT SUM(r.amount)
           FROM revale.employer_funding_receipts r
           WHERE r.funding_batch_id=fb.id AND r.status='confirmed'
         ),0)
         + COALESCE((
           SELECT SUM(rf.amount)
           FROM revale.employer_funding_refunds rf
           WHERE rf.funding_batch_id=fb.id AND rf.status='confirmed'
         ),0)
       ,0)::float8 AS needed_amount
     FROM revale.funding_batches fb
     JOIN revale.employers e ON e.id=fb.employer_id
     WHERE fb.status IN ('pending','received')
       AND fb.created_at::date BETWEEN $2::date AND $3::date`,
    [accountId,startDate,endDate]
  );

  return [
    ...receipts.map(x=>({type:"funding_receipt",id:x.id,signedAmount:Number(x.amount),reference:x.bank_reference,date:String(x.bank_posted_on).slice(0,10),partyName:x.employer_name})),
    ...refunds.map(x=>({type:"funding_refund",id:x.id,signedAmount:-Number(x.amount),reference:x.bank_reference,date:String(x.bank_posted_on).slice(0,10),partyName:x.employer_name})),
    ...payouts.map(x=>({type:"settlement_payout",id:x.id,signedAmount:-Number(x.amount),reference:x.payout_reference,date:new Date(x.movement_at).toISOString().slice(0,10),partyName:x.merchant_name,externalRef:x.settlement_id,status:x.status})),
    ...transfers.map(x=>({type:"treasury_transfer",id:x.id,signedAmount:(x.to_account_id===accountId?1:-1)*Number(x.amount),reference:x.bank_reference,date:String(x.bank_posted_on).slice(0,10),externalRef:x.transfer_type})),
    ...batches.filter(x=>Number(x.needed_amount)>0).map(x=>({type:"funding_batch",id:x.id,signedAmount:Number(x.needed_amount),reference:x.external_reference,date:String(x.created_on).slice(0,10),partyName:x.employer_name,externalRef:x.external_reference}))
  ];
}

export async function generateBankMatchSuggestions(sql,importId){
  await ensureBankReconciliationSchema(sql);
  const entries=await sql.query(
    `SELECT id,treasury_account_id,booking_date::text AS booking_date,description,bank_reference,amount::float8 AS amount
     FROM revale.bank_statement_entries
     WHERE import_id=$1 AND match_status IN ('unmatched','suggested')
     ORDER BY booking_date,id`,
    [importId]
  );
  if(!entries.length)return {suggested:0};
  const dates=entries.map(x=>x.booking_date).sort();
  const candidates=await matchingCandidates(sql,entries[0].treasury_account_id,dates[0],dates.at(-1));
  let suggested=0;
  for(const entry of entries){
    let best=null;
    for(const candidate of candidates){
      if(Math.sign(Number(entry.amount))!==Math.sign(Number(candidate.signedAmount)))continue;
      const scored=candidateScore(entry,candidate);
      if(scored.score<55)continue;
      if(!best||scored.score>best.score)best={...candidate,...scored};
    }
    if(best){
      suggested++;
      await sql.query(
        `UPDATE revale.bank_statement_entries
         SET match_status='suggested',suggested_type=$2,suggested_id=$3,
             suggested_score=$4,suggested_reason=$5,updated_at=now()
         WHERE id=$1 AND match_status<>'matched'`,
        [entry.id,best.type,best.id,best.score,best.reason]
      );
    }else{
      await sql.query(
        `UPDATE revale.bank_statement_entries
         SET match_status='unmatched',suggested_type=NULL,suggested_id=NULL,
             suggested_score=NULL,suggested_reason=NULL,updated_at=now()
         WHERE id=$1 AND match_status<>'matched'`,
        [entry.id]
      );
    }
  }
  await refreshImportCounts(sql,importId);
  return {suggested,total:entries.length};
}

async function refreshImportCounts(sql,importId){
  const [counts]=await sql.query(
    `SELECT
       COUNT(*)::int AS rows,
       COUNT(*) FILTER (WHERE match_status='matched')::int AS matched,
       COUNT(*) FILTER (WHERE match_status IN ('unmatched','suggested'))::int AS unmatched
     FROM revale.bank_statement_entries WHERE import_id=$1`,
    [importId]
  );
  const status=Number(counts?.unmatched||0)===0&&Number(counts?.rows||0)>0?"completed":"reviewed";
  await sql.query(
    `UPDATE revale.bank_statement_imports
     SET row_count=$2,matched_count=$3,unmatched_count=$4,status=$5,updated_at=now()
     WHERE id=$1`,
    [importId,counts?.rows||0,counts?.matched||0,counts?.unmatched||0,status]
  );
}

export async function importBankStatement(sql,{
  treasuryAccountId,filename,text=null,dataBase64=null,mapping={},actorId=null
}){
  await ensureBankReconciliationSchema(sql);
  const [account]=await sql.query(
    `SELECT id,currency,active FROM revale.treasury_bank_accounts WHERE id=$1 LIMIT 1`,
    [treasuryAccountId]
  );
  if(!account)return {code:"account_not_found"};
  if(!account.active)return {code:"account_inactive"};
  const parsed=await parseInputFile({filename,text,dataBase64});
  if(!parsed.rows.length)return {code:"empty"};
  const headerIndex=detectHeaderRow(parsed.rows);
  const headers=uniqueHeaders(parsed.rows[headerIndex]||[]);
  const merged={...autoMapping(headers),...(mapping||{})};
  if(!merged.booking_date)return {code:"date_column_required",headers,mapping:merged};
  if(!merged.amount && !merged.debit && !merged.credit)return {code:"amount_column_required",headers,mapping:merged};
  const rows=normalizeStatementRows(parsed.rows,headerIndex,headers,merged,account.currency);
  if(!rows.length)return {code:"no_valid_rows"};

  const hash=createHash("sha256").update(parsed.bytes).digest("hex");
  const [existing]=await sql.query(
    `SELECT id,status,row_count,duplicate_count,matched_count,unmatched_count,created_at
     FROM revale.bank_statement_imports
     WHERE treasury_account_id=$1 AND file_hash=$2
     LIMIT 1`,
    [treasuryAccountId,hash]
  );
  if(existing){
    return {code:"ok",import:existing,idempotent:true};
  }

  const importId="bsi_"+safeId(treasuryAccountId)+"_"+Date.now().toString(36);
  await sql.query(
    `INSERT INTO revale.bank_statement_imports (
       id,treasury_account_id,filename,file_format,file_hash,status,row_count,imported_by,metadata
     ) VALUES ($1,$2,$3,$4,$5,'imported',$6,$7,$8::jsonb)`,
    [
      importId,treasuryAccountId,String(filename||"extracto").slice(0,240),parsed.format,hash,rows.length,actorId,
      JSON.stringify({header_row:headerIndex+1,mapping:merged})
    ]
  );

  let inserted=0,duplicates=0;
  const occurrenceMap=new Map();
  for(const row of rows){
    const occurrenceKey=[
      row.bookingDate,round2(row.amount).toFixed(2),
      normalizeRef(row.reference||""),normalizeText(row.description||"")
    ].join("|");
    const occurrence=(occurrenceMap.get(occurrenceKey)||0)+1;
    occurrenceMap.set(occurrenceKey,occurrence);
    row.occurrence=occurrence;
    const fp=fingerprint(treasuryAccountId,row);
    const id="bse_"+fp.slice(0,24);
    const result=await sql.query(
      `INSERT INTO revale.bank_statement_entries (
         id,import_id,treasury_account_id,booking_date,value_date,description,bank_reference,
         amount,balance_after,currency,fingerprint,raw_data,metadata
       ) VALUES (
         $1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb
       )
       ON CONFLICT (treasury_account_id,fingerprint) DO NOTHING
       RETURNING id`,
      [
        id,importId,treasuryAccountId,row.bookingDate,row.valueDate,row.description,row.reference,
        row.amount,row.balanceAfter,row.currency,fp,JSON.stringify(row.raw),
        JSON.stringify({source_row:row.rowNumber})
      ]
    );
    if(result.length)inserted++;else duplicates++;
  }

  await sql.query(
    `UPDATE revale.bank_statement_imports
     SET row_count=$2,duplicate_count=$3,unmatched_count=$2,updated_at=now()
     WHERE id=$1`,
    [importId,inserted,duplicates]
  );

  const suggestionResult=await generateBankMatchSuggestions(sql,importId);
  const validBalances=rows
    .filter(x=>x.balanceAfter!==null&&x.balanceAfter!==undefined)
    .sort((a,b)=>a.bookingDate.localeCompare(b.bookingDate)||Number(a.rowNumber)-Number(b.rowNumber));
  const closing=validBalances.at(-1)||null;
  return {
    code:"ok",
    importId,inserted,duplicates,suggested:suggestionResult.suggested||0,
    closingBalance:closing?{
      balance:closing.balanceAfter,
      bookingDate:closing.bookingDate,
      reference:"Extracto "+String(filename||"")
    }:null,
    mapping:merged
  };
}

export async function bankMatchCandidatesForEntry(sql,entryId,limit=20){
  await ensureBankReconciliationSchema(sql);
  const entry=await getBankStatementEntry(sql,entryId);
  if(!entry)return {code:"not_found",items:[]};
  const minDate=entry.booking_date,maxDate=entry.booking_date;
  const candidates=await matchingCandidates(sql,entry.treasury_account_id,minDate,maxDate);
  const items=candidates
    .filter(x=>Math.sign(Number(entry.amount))===Math.sign(Number(x.signedAmount)))
    .map(candidate=>({...candidate,...candidateScore(entry,candidate)}))
    .filter(x=>x.score>0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,Math.max(1,Math.min(Number(limit)||20,50)));
  return {code:"ok",entry,items};
}

export async function listBankStatementImports(sql,limit=30){
  await ensureBankReconciliationSchema(sql);
  return sql.query(
    `SELECT i.id,i.treasury_account_id,a.bank_name,a.account_name,a.account_number_last4,
            i.filename,i.file_format,i.status,i.row_count,i.duplicate_count,
            i.matched_count,i.unmatched_count,i.imported_by,i.metadata,i.created_at,i.updated_at
     FROM revale.bank_statement_imports i
     JOIN revale.treasury_bank_accounts a ON a.id=i.treasury_account_id
     ORDER BY i.created_at DESC
     LIMIT $1`,
    [Math.max(1,Math.min(Number(limit)||30,100))]
  );
}

export async function listBankStatementEntries(sql,{importId=null,status=null,limit=300}={}){
  await ensureBankReconciliationSchema(sql);
  const params=[];let where="WHERE 1=1";
  if(importId){params.push(importId);where+=" AND e.import_id=$"+params.length}
  if(status){params.push(status);where+=" AND e.match_status=$"+params.length}
  params.push(Math.max(1,Math.min(Number(limit)||300,1000)));
  return sql.query(
    `SELECT e.id,e.import_id,e.treasury_account_id,e.booking_date,e.value_date,e.description,e.bank_reference,
            e.amount::float8 AS amount,e.balance_after::float8 AS balance_after,e.currency,
            e.match_status,e.suggested_type,e.suggested_id,e.suggested_score,e.suggested_reason,
            e.matched_type,e.matched_id,e.matched_by,e.matched_at,e.metadata,e.created_at
     FROM revale.bank_statement_entries e
     ${where}
     ORDER BY e.booking_date DESC,e.id DESC
     LIMIT $${params.length}`,
    params
  );
}

export async function getBankStatementEntry(sql,entryId){
  await ensureBankReconciliationSchema(sql);
  const [row]=await sql.query(
    `SELECT id,import_id,treasury_account_id,booking_date::text AS booking_date,value_date::text AS value_date,
            description,bank_reference,amount::float8 AS amount,balance_after::float8 AS balance_after,
            currency,match_status,suggested_type,suggested_id,suggested_score,suggested_reason,
            matched_type,matched_id,raw_data,metadata,created_at
     FROM revale.bank_statement_entries WHERE id=$1 LIMIT 1`,
    [entryId]
  );
  return row||null;
}

export async function markBankStatementEntryMatched(sql,{
  entryId,matchedType,matchedId,actorId=null,metadata={}
}){
  await ensureBankReconciliationSchema(sql);
  const [row]=await sql.query(
    `UPDATE revale.bank_statement_entries
     SET match_status='matched',matched_type=$2,matched_id=$3,matched_by=$4,matched_at=now(),
         metadata=metadata||$5::jsonb,updated_at=now()
     WHERE id=$1 AND match_status<>'matched'
     RETURNING id,import_id,match_status,matched_type,matched_id,matched_by,matched_at`,
    [entryId,matchedType,matchedId,actorId,JSON.stringify(metadata||{})]
  );
  if(!row){
    const [existing]=await sql.query(
      `SELECT id,import_id,match_status,matched_type,matched_id,matched_by,matched_at
       FROM revale.bank_statement_entries WHERE id=$1 LIMIT 1`,
      [entryId]
    );
    if(existing?.match_status==="matched")return {code:"ok",entry:existing,idempotent:true};
    return {code:existing?"invalid_status":"not_found"};
  }
  await refreshImportCounts(sql,row.import_id);
  return {code:"ok",entry:row};
}

export async function ignoreBankStatementEntry(sql,{entryId,actorId=null,reason=null}){
  await ensureBankReconciliationSchema(sql);
  const [row]=await sql.query(
    `UPDATE revale.bank_statement_entries
     SET match_status='ignored',matched_by=$2,matched_at=now(),
         metadata=metadata||jsonb_build_object('ignored_reason',$3),updated_at=now()
     WHERE id=$1 AND match_status<>'matched'
     RETURNING id,import_id,match_status`,
    [entryId,actorId,String(reason||"").trim().slice(0,500)||null]
  );
  if(!row)return {code:"invalid_status"};
  await refreshImportCounts(sql,row.import_id);
  return {code:"ok",entry:row};
}
