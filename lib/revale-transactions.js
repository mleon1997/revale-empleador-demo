// Rebuild the statement on each attempt so all balance/rule reads share a fresh
// Serializable snapshot. Only serialization/deadlock failures are safe to retry.
export async function serializableQuery(sql, buildQuery) {
  if(sql.inTransaction)return await buildQuery();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [rows] = await sql.transaction([buildQuery()], { isolationLevel: 'Serializable' });
      return rows;
    } catch (error) {
      if (!['40001', '40P01'].includes(error.code)) throw error;
      if (attempt === 4) throw Object.assign(new Error('El movimiento se está procesando. Consulta su estado e intenta nuevamente.'), { status: 409, code: 'TRANSACTION_BUSY' });
    }
  }
}
