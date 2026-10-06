import { getSql } from '../lib/revale-db.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  try { const sql=await getSql(); await sql.query('SELECT 1'); return res.status(200).json({ok:true}); }
  catch { return res.status(503).json({ok:false}); }
}
