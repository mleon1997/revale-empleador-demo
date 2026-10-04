export async function confirmFundingBatchAtomic(sql, fundingBatchId) {
  const [batch] = await sql.query(
    `SELECT id,employer_id,program_id,amount::float8 AS amount,currency,status
     FROM revale.funding_batches
     WHERE id=$1
     LIMIT 1`,
    [fundingBatchId]
  );

  if (!batch) return { code:"not_found" };
  if (batch.status === "allocated") return { code:"ok", idempotent:true, batch };
  if (!["pending","received"].includes(batch.status)) return { code:"invalid_status", status:batch.status };

  const [totals] = await sql.query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS total,COUNT(*)::int AS count
     FROM revale.funding_batch_items
     WHERE funding_batch_id=$1 AND status='pending'`,
    [fundingBatchId]
  );

  if (!totals?.count) return { code:"no_items" };
  if (Number(totals.total) > Number(batch.amount) + 0.00001) {
    return { code:"insufficient_funding", required:totals.total, available:batch.amount };
  }

  const rows = await sql.query(
    `WITH batch_guard AS (
       SELECT id,program_id,amount
       FROM revale.funding_batches
       WHERE id=$1 AND status IN ('pending','received')
       FOR UPDATE
     ),
     eligible AS (
       SELECT i.id AS item_id,i.enrollment_id,i.account_id,i.amount,b.program_id
       FROM revale.funding_batch_items i
       JOIN batch_guard b ON b.id=i.funding_batch_id
       WHERE i.funding_batch_id=$1 AND i.status='pending'
         AND (SELECT COALESCE(SUM(amount),0) FROM revale.funding_batch_items WHERE funding_batch_id=$1 AND status='pending') <= b.amount
     ),
     credited AS (
       UPDATE revale.benefit_accounts a
       SET balance=a.balance+e.amount,updated_at=now()
       FROM eligible e
       WHERE a.id=e.account_id
       RETURNING a.id AS account_id,a.balance::float8 AS balance_after
     ),
     rows_to_post AS (
       SELECT e.item_id,e.enrollment_id,e.account_id,e.amount,e.program_id,c.balance_after
       FROM eligible e
       JOIN credited c ON c.account_id=e.account_id
     ),
     allocation_insert AS (
       INSERT INTO revale.benefit_allocations (
         program_id,enrollment_id,account_id,funding_batch_id,amount,effective_at,status,metadata
       )
       SELECT program_id,enrollment_id,account_id,$1,amount,now(),'active',jsonb_build_object('source','funding_batch')
       FROM rows_to_post
       RETURNING id
     ),
     ledger_insert AS (
       INSERT INTO revale.ledger_entries (
         account_id,transaction_id,entry_type,amount,balance_after,description
       )
       SELECT account_id,NULL,'allocation',amount,balance_after,'Asignación de beneficio'
       FROM rows_to_post
       RETURNING id
     ),
     items_done AS (
       UPDATE revale.funding_batch_items i
       SET status='allocated',allocated_at=now()
       FROM rows_to_post r
       WHERE i.id=r.item_id
       RETURNING i.id
     ),
     batch_done AS (
       UPDATE revale.funding_batches f
       SET status='allocated',received_at=COALESCE(received_at,now()),updated_at=now()
       WHERE f.id=$1 AND EXISTS (SELECT 1 FROM items_done)
       RETURNING f.id,f.status,f.amount::float8 AS amount,f.received_at
     )
     SELECT * FROM batch_done`,
    [fundingBatchId]
  );

  if (!rows.length) return { code:"invalid_status", status:batch.status };
  return { code:"ok", batch:rows[0] };
}
