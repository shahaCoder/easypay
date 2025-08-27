// src/db.ts
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined }
    : {
        host: process.env.PGHOST || "localhost",
        port: +(process.env.PGPORT || 5432),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE || "ezpassbot",
      }
);

export type PlanLabel = "plan1_direct" | "plan2_discount";
export type ReqStatus = "creating" | "pending" | "completed" | "declined";

export type RequestRow = {
  id: string;
  chat_id: string;
  plan_label: PlanLabel;
  plate: string;
  plate_norm: string;
  invoice: string;
  invoice_norm: string;
  ezpass_account: string | null;
  ezpass_account_norm: string | null;
  status: ReqStatus;
  session_id: string | null;
  checkout_url: string | null;
  total_usd: number;
  toll_usd: number;
  service_usd: number;
  fees_usd: number;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
};

export function normPlateOrInvoice(x: string) {
  return x.trim().replace(/[\u00A0\u202F\s]+/g, "").replace(/[–—−]/g, "-").toUpperCase();
}
export function normAcc(x: string) {
  return x.replace(/[^\d]/g, "");
}

export async function findByChatInvoice(chatId: number | string, invoice: string) {
  const res = await pool.query<RequestRow>(
    `SELECT * FROM requests WHERE chat_id = $1 AND invoice_norm = $2 LIMIT 1`,
    [String(chatId), normPlateOrInvoice(invoice)]
  );
  return res.rows[0];
}

export async function findById(id: string) {
  const res = await pool.query<RequestRow>(`SELECT * FROM requests WHERE id = $1`, [id]);
  return res.rows[0];
}

export async function listByChat(chatId: string | number, limit = 10) {
  const sql = `
    SELECT id, plan_label, status, plate, invoice, checkout_url,
           total_usd::float   AS total_usd,
           toll_usd::float    AS toll_usd,
           service_usd::float AS service_usd,
           fees_usd::float    AS fees_usd,
           created_at
    FROM requests
    WHERE chat_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(sql, [String(chatId), limit]);
  return rows;
}



export async function createRequestCreating(args: {
  chatId: number | string;
  plan: PlanLabel;
  plate: string;
  invoice: string;
  ezpassAccount?: string;
  totals: { total: number; toll: number; service: number; fees: number };
}) {
  const id = randomUUID();
  const plate_norm = normPlateOrInvoice(args.plate || "");
  const invoice_norm = normPlateOrInvoice(args.invoice || "");
  const ezpass_account_norm = args.ezpassAccount ? normAcc(args.ezpassAccount) : null;

  try {
    const res = await pool.query<RequestRow>(
      `INSERT INTO requests
        (id, chat_id, plan_label, plate, plate_norm, invoice, invoice_norm,
         ezpass_account, ezpass_account_norm, status,
         total_usd, toll_usd, service_usd, fees_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'creating',$10,$11,$12,$13)
       RETURNING *`,
      [
        id, String(args.chatId), args.plan,
        args.plate, plate_norm, args.invoice, invoice_norm,
        args.ezpassAccount || null, ezpass_account_norm,
        args.totals.total, args.totals.toll, args.totals.service, args.totals.fees
      ]
    );
    return res.rows[0];
  } catch (e: any) {
    if (e?.code === "23505") {
      const existing = await findByChatInvoice(args.chatId, args.invoice);
      return existing!;
    }
    throw e;
  }
}

export async function setPending(id: string, sessionId: string, url: string) {
  const res = await pool.query<RequestRow>(
    `UPDATE requests
       SET status='pending', session_id=$2, checkout_url=$3, updated_at=now()
     WHERE id=$1
     RETURNING *`,
    [id, sessionId, url]
  );
  return res.rows[0];
}

export async function setCompletedById(id: string) {
  const res = await pool.query<RequestRow>(
    `UPDATE requests
       SET status='completed', updated_at=now()
     WHERE id=$1
     RETURNING *`,
    [id]
  );
  return res.rows[0];
}

export async function setDeclinedById(id: string, reason?: string) {
  const res = await pool.query<RequestRow>(
    `UPDATE requests
       SET status='declined', decline_reason=$2, updated_at=now()
     WHERE id=$1
     RETURNING *`,
    [id, reason || null]
  );
  return res.rows[0];
}

export { pool };
