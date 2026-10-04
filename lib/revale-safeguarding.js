function round2(value){
  return Math.round((Number(value||0)+Number.EPSILON)*100)/100;
}
function safeIdPart(value){
  return String(value||"").replace(/[^a-z0-9_]/gi,"_").slice(0,100);
}

let safeguardingSchemaPromise=null;

async function bootstrapSafeguardingSchema(sql){
  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.treasury_bank_accounts (
      id text PRIMARY KEY,
      bank_name text NOT NULL,
      account_name text NOT NULL,
      account_number_last4 text,
      purpose text NOT NULL
        CHECK (purpose IN ('client_funds','operating','tax')),
      currency char(3) NOT NULL DEFAULT 'USD',
      is_primary boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      external_account_ref text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_bank_accounts_primary_unique
      ON revale.treasury_bank_accounts(purpose,currency)
      WHERE active=true AND is_primary=true
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS treasury_bank_accounts_purpose_idx
      ON revale.treasury_bank_accounts(purpose,active)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.treasury_bank_balance_snapshots (
      id text PRIMARY KEY,
      bank_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
      balance numeric(16,2) NOT NULL,
      available_balance numeric(16,2),
      currency char(3) NOT NULL DEFAULT 'USD',
      as_of timestamptz NOT NULL,
      source text NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual','bank_import','api')),
      statement_reference text,
      recorded_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS treasury_bank_balance_snapshots_latest_idx
      ON revale.treasury_bank_balance_snapshots(bank_account_id,as_of DESC)
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.treasury_internal_transfers (
      id text PRIMARY KEY,
      from_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
      to_account_id text NOT NULL REFERENCES revale.treasury_bank_accounts(id),
      transfer_type text NOT NULL CHECK (transfer_type IN ('safeguarding_topup','excess_sweep')),
      amount numeric(16,2) NOT NULL CHECK (amount > 0),
      currency char(3) NOT NULL DEFAULT 'USD',
      bank_reference text NOT NULL,
      bank_posted_on date NOT NULL,
      status text NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed','voided')),
      confirmed_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_internal_transfers_ref_unique
      ON revale.treasury_internal_transfers(bank_reference,bank_posted_on)
      WHERE status='confirmed'
  `);

  await sql.query(`
    CREATE TABLE IF NOT EXISTS revale.safeguarding_settings (
      id text PRIMARY KEY DEFAULT 'default',
      required_coverage_ratio numeric(8,5) NOT NULL DEFAULT 1.00000
        CHECK (required_coverage_ratio >= 1),
      minimum_buffer numeric(16,2) NOT NULL DEFAULT 0 CHECK (minimum_buffer >= 0),
      stale_after_hours integer NOT NULL DEFAULT 24 CHECK (stale_after_hours BETWEEN 1 AND 168),
      enforcement_enabled boolean NOT NULL DEFAULT false,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.query(`
    INSERT INTO revale.safeguarding_settings (
      id,required_coverage_ratio,minimum_buffer,stale_after_hours,enforcement_enabled
    ) VALUES ('default',1.00000,0,24,false)
    ON CONFLICT (id) DO NOTHING
  `);

  await sql.query(`
    ALTER TABLE revale.employer_funding_receipts
      ADD COLUMN IF NOT EXISTS treasury_account_id text
  `);
  await sql.query(`
    ALTER TABLE revale.employer_funding_refunds
      ADD COLUMN IF NOT EXISTS treasury_account_id text
  `);
  await sql.query(`
    ALTER TABLE revale.settlement_payouts
      ADD COLUMN IF NOT EXISTS source_treasury_account_id text
  `);

  try{
    await sql.query(`
      ALTER TABLE revale.employer_funding_receipts
        ADD CONSTRAINT employer_funding_receipts_treasury_account_fk
        FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id)
    `);
  }catch(error){
    if(!String(error?.message||"").toLowerCase().includes("already exists"))throw error;
  }
  try{
    await sql.query(`
      ALTER TABLE revale.employer_funding_refunds
        ADD CONSTRAINT employer_funding_refunds_treasury_account_fk
        FOREIGN KEY (treasury_account_id) REFERENCES revale.treasury_bank_accounts(id)
    `);
  }catch(error){
    if(!String(error?.message||"").toLowerCase().includes("already exists"))throw error;
  }
  try{
    await sql.query(`
      ALTER TABLE revale.settlement_payouts
        ADD CONSTRAINT settlement_payouts_source_treasury_account_fk
        FOREIGN KEY (source_treasury_account_id) REFERENCES revale.treasury_bank_accounts(id)
    `);
  }catch(error){
    if(!String(error?.message||"").toLowerCase().includes("already exists"))throw error;
  }

  try{
    await sql.query(`
      INSERT INTO revale.gl_accounts (
        id,internal_code,local_account_code,name,account_type,normal_balance,
        ifrs_category,ecuador_reporting_line,active
      ) VALUES (
        'gl_cash_operating','1.1.01.02','1.1.01.02',
        'Caja y bancos propios ReVale','asset','debit',
        'cash_and_cash_equivalents','Efectivo propio',true
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }catch(error){
    console.warn("ReVale operating cash GL bootstrap skipped",String(error?.message||error));
  }
}

export async function ensureSafeguardingSchema(sql){
  if(!safeguardingSchemaPromise)safeguardingSchemaPromise=bootstrapSafeguardingSchema(sql);
  try{
    await safeguardingSchemaPromise;
  }catch(error){
    safeguardingSchemaPromise=null;
    throw error;
  }
}

export async function getPrimaryTreasuryAccount(sql,purpose="client_funds",currency="USD"){
  await ensureSafeguardingSchema(sql);
  const [row]=await sql.query(
    `SELECT id,bank_name,account_name,account_number_last4,purpose,currency,is_primary,active
     FROM revale.treasury_bank_accounts
     WHERE purpose=$1 AND currency=$2 AND active=true
     ORDER BY is_primary DESC,created_at
     LIMIT 1`,
    [purpose,String(currency||"USD").toUpperCase()]
  );
  return row||null;
}

export async function upsertTreasuryAccount(sql,{
  id=null,bankName,accountName,accountNumberLast4=null,purpose="client_funds",
  currency="USD",isPrimary=false,actorId=null
}){
  await ensureSafeguardingSchema(sql);
  const bank=String(bankName||"").trim().slice(0,120);
  const name=String(accountName||"").trim().slice(0,120);
  const last4=String(accountNumberLast4||"").replace(/\D/g,"").slice(-4)||null;
  const purp=String(purpose||"client_funds");
  const curr=String(currency||"USD").trim().toUpperCase().slice(0,3);
  if(!bank||!name)return {code:"fields_required"};
  if(!["client_funds","operating","tax"].includes(purp))return {code:"invalid_purpose"};
  const accountId=id?String(id):"tba_"+safeIdPart(purp)+"_"+Date.now().toString(36);

  if(isPrimary){
    await sql.query(
      `UPDATE revale.treasury_bank_accounts
       SET is_primary=false,updated_at=now()
       WHERE purpose=$1 AND currency=$2 AND active=true AND id<>$3`,
      [purp,curr,accountId]
    );
  }

  const [row]=await sql.query(
    `INSERT INTO revale.treasury_bank_accounts (
       id,bank_name,account_name,account_number_last4,purpose,currency,is_primary,active,metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,true,jsonb_build_object('configured_by',$8)
     )
     ON CONFLICT (id) DO UPDATE SET
       bank_name=EXCLUDED.bank_name,
       account_name=EXCLUDED.account_name,
       account_number_last4=EXCLUDED.account_number_last4,
       purpose=EXCLUDED.purpose,
       currency=EXCLUDED.currency,
       is_primary=EXCLUDED.is_primary,
       active=true,
       metadata=revale.treasury_bank_accounts.metadata||EXCLUDED.metadata,
       updated_at=now()
     RETURNING id,bank_name,account_name,account_number_last4,purpose,currency,is_primary,active,created_at,updated_at`,
    [accountId,bank,name,last4,purp,curr,Boolean(isPrimary),actorId]
  );
  return {code:"ok",account:row};
}

export async function recordTreasuryBalance(sql,{
  accountId,balance,availableBalance=null,asOf,source="manual",statementReference=null,actorId=null
}){
  await ensureSafeguardingSchema(sql);
  const [account]=await sql.query(
    `SELECT id,currency,active FROM revale.treasury_bank_accounts WHERE id=$1 LIMIT 1`,
    [accountId]
  );
  if(!account)return {code:"account_not_found"};
  if(!account.active)return {code:"account_inactive"};
  const bal=round2(balance);
  const available=availableBalance===null||availableBalance===undefined||availableBalance===""
    ? null : round2(availableBalance);
  const when=String(asOf||"").trim();
  if(!Number.isFinite(bal)||bal<0)return {code:"invalid_balance"};
  if(available!==null && (!Number.isFinite(available)||available<0))return {code:"invalid_available_balance"};
  if(!when || Number.isNaN(new Date(when).getTime()))return {code:"invalid_as_of"};
  const src=["manual","bank_import","api"].includes(source)?source:"manual";
  const statement=String(statementReference||"").trim().slice(0,160)||null;
  const id="tbs_"+safeIdPart(accountId)+"_"+Date.now().toString(36);
  const [row]=await sql.query(
    `INSERT INTO revale.treasury_bank_balance_snapshots (
       id,bank_account_id,balance,available_balance,currency,as_of,source,statement_reference,recorded_by
     ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9)
     RETURNING id,bank_account_id,balance::float8 AS balance,
       available_balance::float8 AS available_balance,currency,as_of,source,statement_reference,recorded_by,created_at`,
    [id,accountId,bal,available,String(account.currency||"USD").trim(),when,src,statement,actorId]
  );
  return {code:"ok",snapshot:row};
}

async function positiveLiabilityByDimension(sql,accountId,dimension){
  const allowed={employer:"employer_id",merchant:"merchant_id",person:"person_id"};
  const column=allowed[dimension];
  if(!column)throw new Error("INVALID_DIMENSION");
  const [row]=await sql.query(
    `WITH balances AS (
       SELECT l.${column} AS party_id,
              SUM(l.credit-l.debit) AS balance
       FROM revale.gl_journal_lines l
       JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
       WHERE l.account_id=$1
       GROUP BY l.${column}
     )
     SELECT COALESCE(SUM(GREATEST(balance,0)),0)::float8 AS amount FROM balances`,
    [accountId]
  );
  return round2(row?.amount||0);
}

async function accountAdjustedBalance(sql,account){
  const [snap]=await sql.query(
    `SELECT id,balance::float8 AS balance,available_balance::float8 AS available_balance,
            as_of,source,statement_reference,created_at
     FROM revale.treasury_bank_balance_snapshots
     WHERE bank_account_id=$1
     ORDER BY as_of DESC,created_at DESC
     LIMIT 1`,
    [account.id]
  );
  if(!snap){
    return {...account,snapshot:null,reportedBalance:null,adjustedBalance:null,knownMovementsAfterSnapshot:0};
  }

  const base=round2(snap.available_balance===null||snap.available_balance===undefined?snap.balance:snap.available_balance);
  const [movements]=await sql.query(
    `SELECT
       COALESCE((
         SELECT SUM(r.amount)
         FROM revale.employer_funding_receipts r
         WHERE r.treasury_account_id=$1 AND r.status='confirmed'
           AND (
             r.bank_posted_on > (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
             OR (
               r.bank_posted_on = (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
               AND r.created_at > $3::timestamptz
             )
           )
       ),0)::float8 AS funding_in,
       COALESCE((
         SELECT SUM(rf.amount)
         FROM revale.employer_funding_refunds rf
         WHERE rf.treasury_account_id=$1 AND rf.status='confirmed'
           AND (
             rf.bank_posted_on > (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
             OR (
               rf.bank_posted_on = (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
               AND rf.created_at > $3::timestamptz
             )
           )
       ),0)::float8 AS funding_out,
       COALESCE((
         SELECT SUM(p.amount)
         FROM revale.settlement_payouts p
         WHERE p.source_treasury_account_id=$1 AND p.status='paid'
           AND p.completed_at > $2::timestamptz
       ),0)::float8 AS merchant_out,
       COALESCE((
         SELECT SUM(t.amount)
         FROM revale.treasury_internal_transfers t
         WHERE t.to_account_id=$1 AND t.status='confirmed'
           AND (
             t.bank_posted_on > (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
             OR (
               t.bank_posted_on = (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
               AND t.created_at > $3::timestamptz
             )
           )
       ),0)::float8 AS transfer_in,
       COALESCE((
         SELECT SUM(t.amount)
         FROM revale.treasury_internal_transfers t
         WHERE t.from_account_id=$1 AND t.status='confirmed'
           AND (
             t.bank_posted_on > (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
             OR (
               t.bank_posted_on = (($2::timestamptz AT TIME ZONE 'America/Guayaquil')::date)
               AND t.created_at > $3::timestamptz
             )
           )
       ),0)::float8 AS transfer_out`,
    [account.id,snap.as_of,snap.created_at]
  );
  const movement=round2(
    Number(movements?.funding_in||0)
    -Number(movements?.funding_out||0)
    -Number(movements?.merchant_out||0)
    +Number(movements?.transfer_in||0)
    -Number(movements?.transfer_out||0)
  );
  return {
    ...account,
    snapshot:snap,
    reportedBalance:base,
    adjustedBalance:round2(base+movement),
    knownMovementsAfterSnapshot:movement,
    movementDetail:{
      fundingIn:round2(movements?.funding_in||0),
      fundingOut:round2(movements?.funding_out||0),
      merchantOut:round2(movements?.merchant_out||0),
      transferIn:round2(movements?.transfer_in||0),
      transferOut:round2(movements?.transfer_out||0)
    }
  };
}

export async function safeguardingControl(sql){
  await ensureSafeguardingSchema(sql);
  const [settings]=await sql.query(
    `SELECT required_coverage_ratio::float8 AS required_coverage_ratio,
            minimum_buffer::float8 AS minimum_buffer,stale_after_hours,enforcement_enabled,updated_at
     FROM revale.safeguarding_settings WHERE id='default' LIMIT 1`
  );

  const accounts=await sql.query(
    `SELECT id,bank_name,account_name,account_number_last4,purpose,currency,is_primary,active,created_at,updated_at
     FROM revale.treasury_bank_accounts
     WHERE active=true
     ORDER BY CASE purpose WHEN 'client_funds' THEN 1 WHEN 'operating' THEN 2 ELSE 3 END,
              is_primary DESC,bank_name,account_name`
  );
  const accountStates=[];
  for(const account of accounts)accountStates.push(await accountAdjustedBalance(sql,account));

  const clientAccounts=accountStates.filter(x=>x.purpose==="client_funds");
  const physicalClientFunds=round2(clientAccounts.reduce((sum,x)=>sum+Number(x.adjustedBalance||0),0));
  const missingSnapshots=clientAccounts.filter(x=>!x.snapshot).length;
  const now=Date.now();
  const staleAfter=Math.max(1,Number(settings?.stale_after_hours||24));
  const staleAccounts=clientAccounts.filter(x=>{
    if(!x.snapshot)return false;
    return (now-new Date(x.snapshot.as_of).getTime())>(staleAfter*3600000);
  }).length;

  const employerPrefund=await positiveLiabilityByDimension(sql,"gl_employer_prefund_liability","employer");
  const employeeLiability=await positiveLiabilityByDimension(sql,"gl_employee_benefit_liability","employer");
  const merchantPayable=await positiveLiabilityByDimension(sql,"gl_merchant_payable","merchant");
  const thirdPartyObligations=round2(employerPrefund+employeeLiability+merchantPayable);
  const ratio=Math.max(1,Number(settings?.required_coverage_ratio||1));
  const buffer=round2(settings?.minimum_buffer||0);
  const requiredSafeguarded=round2(thirdPartyObligations*ratio+buffer);
  const shortfall=round2(Math.max(requiredSafeguarded-physicalClientFunds,0));

  const [glCash]=await sql.query(
    `SELECT COALESCE(SUM(l.debit-l.credit),0)::float8 AS balance
     FROM revale.gl_journal_lines l
     JOIN revale.gl_journals j ON j.id=l.journal_id AND j.status='posted'
     WHERE l.account_id='gl_cash_client_funds'`
  );
  const ledgerClientCash=round2(glCash?.balance||0);
  const physicalVsLedger=round2(physicalClientFunds-ledgerClientCash);
  const bankExcess=round2(Math.max(physicalClientFunds-requiredSafeguarded,0));
  const ledgerOwnExcess=round2(Math.max(ledgerClientCash-thirdPartyObligations,0));
  const sweepable=round2(Math.min(bankExcess,ledgerOwnExcess));

  let status="healthy";
  if(!clientAccounts.length)status="not_configured";
  else if(missingSnapshots>0)status="missing_balance";
  else if(staleAccounts>0)status="stale";
  else if(shortfall>0.01)status="underfunded";

  const coverageRatio=thirdPartyObligations>0
    ? Math.round((physicalClientFunds/thirdPartyObligations)*10000)/10000
    : 1;

  return {
    settings:{
      requiredCoverageRatio:ratio,
      minimumBuffer:buffer,
      staleAfterHours:staleAfter,
      enforcementEnabled:Boolean(settings?.enforcement_enabled)
    },
    status,
    enforcementBlocked:Boolean(settings?.enforcement_enabled)&&status!=="healthy",
    accounts:accountStates,
    physicalClientFunds,
    ledgerClientCash,
    physicalVsLedger,
    employerPrefund,
    employeeLiability,
    merchantPayable,
    thirdPartyObligations,
    requiredSafeguarded,
    shortfall,
    sweepable,
    coverageRatio,
    coveragePercent:Math.round(coverageRatio*10000)/100,
    missingSnapshots,
    staleAccounts
  };
}

export async function setSafeguardingEnforcement(sql,{enabled,actorId=null}){
  await ensureSafeguardingSchema(sql);
  const control=await safeguardingControl(sql);
  if(enabled && control.status!=="healthy"){
    return {code:"not_ready",control};
  }
  const [row]=await sql.query(
    `UPDATE revale.safeguarding_settings
     SET enforcement_enabled=$1,updated_by=$2,updated_at=now()
     WHERE id='default'
     RETURNING required_coverage_ratio::float8 AS required_coverage_ratio,
       minimum_buffer::float8 AS minimum_buffer,stale_after_hours,enforcement_enabled,updated_by,updated_at`,
    [Boolean(enabled),actorId]
  );
  return {code:"ok",settings:row,control:await safeguardingControl(sql)};
}

export async function registerTreasuryTransfer(sql,{
  transferType,amount,bankReference,bankPostedOn,fromAccountId=null,toAccountId=null,actorId=null
}){
  await ensureSafeguardingSchema(sql);
  const type=String(transferType||"");
  const value=round2(amount);
  const ref=String(bankReference||"").trim().slice(0,160);
  const date=String(bankPostedOn||"").trim();
  if(!["safeguarding_topup","excess_sweep"].includes(type))return {code:"invalid_type"};
  if(!(value>0))return {code:"invalid_amount"};
  if(!ref)return {code:"reference_required"};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return {code:"date_required"};

  let fromId=fromAccountId?String(fromAccountId):null;
  let toId=toAccountId?String(toAccountId):null;
  if(!fromId){
    const from=await getPrimaryTreasuryAccount(sql,type==="safeguarding_topup"?"operating":"client_funds","USD");
    fromId=from?.id||null;
  }
  if(!toId){
    const to=await getPrimaryTreasuryAccount(sql,type==="safeguarding_topup"?"client_funds":"operating","USD");
    toId=to?.id||null;
  }
  if(!fromId||!toId)return {code:"account_missing"};
  if(fromId===toId)return {code:"same_account"};

  const rows=await sql.query(
    `SELECT id,purpose,currency,active
     FROM revale.treasury_bank_accounts
     WHERE id IN ($1,$2)`,
    [fromId,toId]
  );
  const from=rows.find(x=>x.id===fromId),to=rows.find(x=>x.id===toId);
  if(!from||!to)return {code:"account_missing"};
  if(!from.active||!to.active)return {code:"account_inactive"};
  if(String(from.currency).trim()!==String(to.currency).trim())return {code:"currency_mismatch"};
  if(type==="safeguarding_topup" && !(from.purpose==="operating"&&to.purpose==="client_funds"))return {code:"invalid_direction"};
  if(type==="excess_sweep" && !(from.purpose==="client_funds"&&to.purpose==="operating"))return {code:"invalid_direction"};

  const control=await safeguardingControl(sql);
  if(type==="excess_sweep" && value>Number(control.sweepable||0)+0.00001){
    return {code:"sweep_exceeds_excess",available:control.sweepable,control};
  }

  const fromState=control.accounts.find(x=>x.id===fromId);
  if(fromState?.adjustedBalance===null || fromState?.adjustedBalance===undefined){
    return {code:"source_balance_missing"};
  }
  if(value>Number(fromState.adjustedBalance)+0.00001){
    return {code:"insufficient_source_balance",available:fromState.adjustedBalance};
  }

  const [existing]=await sql.query(
    `SELECT id,from_account_id,to_account_id,transfer_type,amount::float8 AS amount,currency,
            bank_reference,bank_posted_on,status,confirmed_by,created_at
     FROM revale.treasury_internal_transfers
     WHERE bank_reference=$1 AND bank_posted_on=$2::date AND status='confirmed'
     LIMIT 1`,
    [ref,date]
  );
  if(existing){
    if(existing.transfer_type!==type || round2(existing.amount)!==value)return {code:"duplicate_reference"};
    return {code:"ok",transfer:existing,control:await safeguardingControl(sql),idempotent:true};
  }

  const id="tit_"+safeIdPart(type)+"_"+Date.now().toString(36);
  const [row]=await sql.query(
    `INSERT INTO revale.treasury_internal_transfers (
       id,from_account_id,to_account_id,transfer_type,amount,currency,
       bank_reference,bank_posted_on,status,confirmed_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'confirmed',$9)
     RETURNING id,from_account_id,to_account_id,transfer_type,amount::float8 AS amount,currency,
       bank_reference,bank_posted_on,status,confirmed_by,created_at`,
    [id,fromId,toId,type,value,String(from.currency||"USD").trim(),ref,date,actorId]
  );
  return {code:"ok",transfer:row,control:await safeguardingControl(sql)};
}
