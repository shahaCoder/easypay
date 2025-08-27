// src/db.ts
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.PGSSLMODE === "require"
            ? { rejectUnauthorized: false }
            : undefined,
      }
    : {
        host: process.env.PGHOST || "localhost",
        port: +(process.env.PGPORT || 5432),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "",
        database: process.env.PGDATABASE || "easypay",
      }
);

export type PlanLabel = "plan1_direct" | "plan2_discount";
export type ReqStatus = "creating" | "pending" | "completed" | "declined";

export type RequestRow = {
  id: string;
  chat_id: string;
  plan_label: PlanLabel;
  plate: string;
  invoice: string;
  ezpass_account: string | null;
  status: ReqStatus;
  total_usd: number | null;
  pay_url: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
};

const norm = (s: string) =>
  (s || "")
    .trim()
    .replace(/[\u00A0\u202F\s]+/g, "")
    .replace(/[–—−]/g, "-")
    .toUpperCase();
const normAcc = (s?: string) => (s ? s.replace(/[^\d]/g, "") : "");

/** создаёт таблицу и индексы, если их ещё нет */
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      plan_label      TEXT NOT NULL,
      plate           TEXT NOT NULL,
      invoice         TEXT NOT NULL,
      ezpass_account  TEXT,
      status          TEXT NOT NULL,
      total_usd       NUMERIC,
      pay_url         TEXT,
      session_id      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- один «активный» (не completed) запрос на уникальную четвёрку
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_req_active
      ON requests (chat_id, plan_label, plate, invoice)
      WHERE status <> 'completed';
    CREATE INDEX IF NOT EXISTS idx_requests_chat_created
      ON requests (chat_id, created_at DESC);
  `);
}

/** История заявок по чату */
export async function listByChat(chatId: string, limit = 15): Promise<RequestRow[]> {
  const q = await pool.query(
    `SELECT * FROM requests WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [String(chatId), limit]
  );
  return q.rows as RequestRow[];
}

/** Найти любую «активную» (не completed) по ключу */
export async function findActive(chatId: string, plan: PlanLabel, plate: string, invoice: string) {
  const q = await pool.query(
    `SELECT * FROM requests
     WHERE chat_id=$1 AND plan_label=$2 AND plate=$3 AND invoice=$4
       AND status <> 'completed'
     ORDER BY created_at DESC LIMIT 1`,
    [String(chatId), plan, norm(plate), norm(invoice)]
  );
  return (q.rows[0] as RequestRow) || null;
}

/** Вставить creating либо получить уже существующую (без дублей) */
export async function insertCreatingOrGetExisting(opts: {
  chatId: string | number;
  plan: PlanLabel;
  plate: string;
  invoice: string;
  ezpassAccount?: string;
  totalUsd?: number;
}) {
  const id = randomUUID();
  const vals = [
    id,
    String(opts.chatId),
    opts.plan,
    norm(opts.plate),
    norm(opts.invoice),
    normAcc(opts.ezpassAccount || ""),
    "creating",
    opts.totalUsd ?? null,
  ];
  const ins = await pool.query(
    `INSERT INTO requests
       (id, chat_id, plan_label, plate, invoice, ezpass_account, status, total_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (chat_id, plan_label, plate, invoice) DO NOTHING
     RETURNING *`,
    vals
  );

  if (ins.rows[0]) {
    return { created: true as const, row: ins.rows[0] as RequestRow };
  }

  // уже есть активная — вернём её
  const existing = await findActive(String(opts.chatId), opts.plan, opts.plate, opts.invoice);
  if (existing) return { created: false as const, row: existing };

  // редкий случай гонки — берём самую свежую вообще
  const q = await pool.query(
    `SELECT * FROM requests
     WHERE chat_id=$1 AND plan_label=$2 AND plate=$3 AND invoice=$4
     ORDER BY created_at DESC LIMIT 1`,
    [String(opts.chatId), opts.plan, norm(opts.plate), norm(opts.invoice)]
  );
  return { created: false as const, row: (q.rows[0] as RequestRow) || (ins.rows[0] as RequestRow) };
}

/** Обновить запись в pending после успешного создания сессии */
export async function setPending(id: string, sessionId: string, payUrl: string, totalUsd?: number) {
  await pool.query(
    `UPDATE requests
     SET status='pending',
         session_id=$2,
         pay_url=$3,
         total_usd=COALESCE($4,total_usd),
         updated_at=now()
     WHERE id=$1`,
    [id, sessionId, payUrl, totalUsd ?? null]
  );
}

/** Пометить как completed по sessionId (основной путь) */
export async function setCompletedBySession(sessionId: string) {
  await pool.query(
    `UPDATE requests
     SET status='completed', updated_at=now()
     WHERE session_id=$1`,
    [sessionId]
  );
}

/** Резервный путь — завершить самую свежую «активную» по ключу */
export async function setCompletedFallback(opts: {
  chatId: string | number;
  plan: PlanLabel;
  plate: string;
  invoice: string;
}) {
  await pool.query(
    `UPDATE requests
     SET status='completed', updated_at=now()
     WHERE id IN (
       SELECT id FROM requests
       WHERE chat_id=$1 AND plan_label=$2 AND plate=$3 AND invoice=$4
         AND status <> 'completed'
       ORDER BY created_at DESC
       LIMIT 1
     )`,
    [String(opts.chatId), opts.plan, norm(opts.plate), norm(opts.invoice)]
  );
}
