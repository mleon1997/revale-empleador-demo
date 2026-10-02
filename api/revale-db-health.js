export default async function handler(req, res) {
  try {
    const { neon } = await import("@neondatabase/serverless");
    const url =
      process.env.REVALE_DB_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.REVALE_DB_URL ||
      process.env.STORAGE_URL;

    if (!url) {
      return res.status(500).json({
        ok: false,
        error: "database_url_not_found",
        checked: [
          "REVALE_DB_DATABASE_URL",
          "DATABASE_URL",
          "REVALE_DB_URL",
          "STORAGE_URL"
        ]
      });
    }

    const sql = neon(url);
    const [row] = await sql`
      SELECT current_database() AS database_name, now() AS server_time
    `;

    return res.status(200).json({
      ok: true,
      storage: "neon-postgres",
      database: row?.database_name,
      serverTime: row?.server_time
    });
  } catch (error) {
    console.error("ReVale DB health error", error);
    return res.status(500).json({
      ok: false,
      error: "database_connection_failed"
    });
  }
}
