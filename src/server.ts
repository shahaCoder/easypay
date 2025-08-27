// src/server.ts
import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { createBot } from "./bot";
import { stripe } from "./payments";

const app = express();

// доступ к общему in-memory store из bot.ts
const REQS: {
  pending: Map<string, any>;
  done: Map<string, any>;
} = (globalThis as any).__REQS__ || ((globalThis as any).__REQS__ = { pending: new Map(), done: new Map() });

// Дедупликация уведомлений телеге по session.id
const notifiedSessions = new Set<string>();

async function notifyOnce(session: Stripe.Checkout.Session) {
  if (!session?.id) return;
  if (notifiedSessions.has(session.id)) return;
  notifiedSessions.add(session.id);

  const m = (session.metadata || {}) as Record<string, string>;
  const cd = (session.customer_details || {}) as Stripe.Checkout.Session.CustomerDetails | undefined;

  const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
  const bot: any = (globalThis as any).__BOT__;
  if (!ADMIN_GROUP_ID || !bot) return;

  const toll   = m.tollUsd       ? Number(m.tollUsd).toFixed(2) : "-";
  const service= m.serviceUsd    ? Number(m.serviceUsd).toFixed(2) : "-";
  const fees   = m.feesUsd       ? Number(m.feesUsd).toFixed(2) : "-";
  const total  = m.totalUsd
    ? Number(m.totalUsd).toFixed(2)
    : (session.amount_total ? (session.amount_total / 100).toFixed(2) : "-");

  const planHuman =
    m.planLabel === "plan1_direct"
      ? "Без скидки, прямая оплата!"
      : "Со скидкой (мин. 10%)";

  const text =
`✅ Оплата сервиса успешно прошла!
Имя: ${cd?.name || m.firstName || "-"} | @${m.username || "-"}
План: ${planHuman}
Сумма: $${total} (${toll} + base $${service} service + fees $${fees})
Ez pass state: ${m.ezpassState || "New Jersey"}
Plate number: ${m.plate || "-"}
Invoice number: ${m.invoice || "-"}
Ezpass account number: ${m.ezpassAccount || "-"}
Имя и Фамилия человека: ${cd?.name || "-"}
Номер телефона: ${cd?.phone || "-"}
Дата: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;

  await bot.telegram.sendMessage(ADMIN_GROUP_ID, text);

  // Сообщение клиенту
  if (m.chatId) {
    await bot.telegram.sendMessage(
      Number(m.chatId),
      `Спасибо! Платёж принят: $${total}. Мы скоро свяжемся.`
    );
  }

  // Пометить заявку как выполненную в in-memory store
  const reqKey = m.reqKey;
  if (reqKey) {
    const ex = REQS.pending.get(reqKey);
    const entry = ex || {
      status: "pending",
      url: session.url || "",
      totalUsd: m.totalUsd ? Number(m.totalUsd) : (session.amount_total ? session.amount_total / 100 : 0),
      createdAt: Date.now(),
      planLabel: m.planLabel,
      plate: m.plate,
      invoice: m.invoice,
      ezpassAccount: m.ezpassAccount,
      chatId: m.chatId,
    };
    entry.status = "completed";
    entry.sessionId = session.id;
    REQS.pending.delete(reqKey);
    REQS.done.set(reqKey, entry);
  }
}

// ─── Webhook (raw body ДО json) ─────────────────────────────
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"] as string | undefined;
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(500).send("Config error");
    if (!sig) return res.status(400).send("No signature");

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, secret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err?.message);
      return res.status(400).send("Webhook Error");
    }

    console.log("[webhook]", event.type, event.id);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      await notifyOnce(session);
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error("Webhook error:", err?.message);
    res.status(400).send("Webhook Error");
  }
});

// ─── Остальные роуты ПОСЛЕ raw ─────────────────────────────
app.use(express.json());

// health
app.get("/", (_req, res) => res.send("EZPass helper bot is running ✅"));

// SUCCESS — fallback
app.get("/stripe/success", async (req, res) => {
  const sid = String(req.query.sid || "");
  try {
    if (sid) {
      const session = await stripe.checkout.sessions.retrieve(sid);
      await notifyOnce(session);
      const amount = session.amount_total ? (session.amount_total / 100).toFixed(2) : "";
      return res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Успешно</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Inter,Arial,sans-serif;padding:32px;max-width:680px;margin:0 auto;line-height:1.5}.card{border:1px solid #e5e7eb;border-radius:14px;padding:24px}h1{margin:0 0 8px;font-size:20px}small{color:#6b7280}.btn{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:10px;background:#111827;color:#fff;text-decoration:none}</style></head><body><div class="card"><h1>✅ Успешно!</h1><p>Оплата прошла. Сумма: <b>$${amount}</b>.</p><small>Можно закрыть вкладку и вернуться в Telegram.</small><br/><a class="btn" href="tg://resolve">Вернуться в Telegram</a></div></body></html>`);
    }
    return res.send("✅ Успешно! Можно закрыть вкладку и вернуться в Telegram.");
  } catch (e) {
    console.error("success route error:", (e as any)?.message);
    return res.send("✅ Успешно! (Если сообщение в Telegram не пришло, мы уже работаем над этим.)");
  }
});

// CANCEL
app.get("/stripe/cancel", (_req, res) => {
  res
    .status(200)
    .set("Content-Type", "text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Платёж отменён</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Inter,Arial,sans-serif;padding:32px;max-width:680px;margin:0 auto;line-height:1.5}.card{border:1px solid #e5e7eb;border-radius:14px;padding:24px}h1{margin:0 0 8px;font-size:20px}a{color:#2563eb}</style></head><body><div class="card"><h1>❌ Платёж отменён</h1><p>Если передумаете — вернитесь в Telegram и попробуйте снова.</p></div></body></html>`);
});

// Telegram bot
const bot = createBot(process.env.TG_BOT_TOKEN!);
(globalThis as any).__BOT__ = bot;

bot.launch().then(() => console.log("Telegram bot started"));

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));

// корректное завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
