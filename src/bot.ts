import { Telegraf, Markup } from "telegraf";
import crypto from "node:crypto";
import { checkEzpassNJ } from "./providers/ezpassnj";
import { calcPlan1, calcPlan2, createTotalCheckout } from "./payments";
import type { RequestRow } from "./db";
import { listByChat } from "./db";

/* ───────── helpers ───────── */

const n = (x: any) => (typeof x === "number" ? x : Number(x ?? 0));

function formatDate(d: any) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString("en-US", { timeZone: "America/New_York" });
  } catch {
    return String(d ?? "");
  }
}
function mapStatusRu(s: string) {
  if (s === "creating") return "создаётся";
  if (s === "pending") return "ожидает оплаты";
  if (s === "completed") return "оплачено";
  if (s === "declined") return "отклонено";
  return s;
}
function mapStatusUz(s: string) {
  if (s === "creating") return "yaratilmoqda";
  if (s === "pending") return "to‘lov kutilyapti";
  if (s === "completed") return "to‘landi";
  if (s === "declined") return "rad etildi";
  return s;
}

/* ================== i18n ================== */
type Lang = "ru" | "uz";

const t = {
  ru: {
    choose_lang_title: "Выберите язык чтобы продолжить!",
    choose_lang_sub: "Botdan foydalanish uchun tilni tanlang!",
    start_prompt:
      "Введи данные — проверю все инвойсы и выведу итог.\nНажми кнопку ниже 👇",
    ask_plate: "Введи *Plate number* (как на номере авто):",
    ask_invoice: "Теперь введи *Invoice/Violation number* (с письма):",
    plate_invalid:
      "Кажется, это не похоже на Plate. Пример: *RLRYY99* или *ABC-1234*.",
    invoice_invalid:
      "Номер инвойса/нарушения выглядит странно. Пример: *T062549136462*.",
    checking: "Проверяю по базе NJ E-ZPass… ⏳",
    not_found: "Начисления не найдены.\n\n",
    found_items_title: "Найдено начислений:",
    start_hint: "Нажми «Оплатить E-ZPass», чтобы ввести данные.",
    start_main: "Оплатить E-ZPass",
    help: "Техподдержка",
    plan1_btn: "1) Прямая оплата",
    plan2_btn: "2) Со скидкой",
    ask_ezpass_acc:
      "Введите *E-ZPass account number* (например, *99999999*). Обязательно для варианта со скидкой.",
    ezpass_acc_invalid:
      "Номер аккаунта E-ZPass выглядит странно. Введите от *6* до *12* цифр. Пример: *99999999*.",
    // история
    hist_btn: "📄 История заявок",
    hist_title: "📄 История ваших заявок:",
    hist_none: "История пуста.",
    hist_item: (r: RequestRow) =>
      `• ${r.invoice} — $${n(r.total_usd).toFixed(
        2
      )} | План: ${r.plan_label === "plan1_direct" ? "Прямая" : "Со скидкой"} | Статус: ${mapStatusRu(
        r.status
      )} | ${formatDate(r.created_at)}`,
    // дубликаты
    dup_creating_title: "Заявка по этим данным уже создаётся… ⏳",
    dup_creating_hint:
      "Подождите несколько секунд. Если ссылка уже была — используйте её, не создавая новую.",
    dup_pending_title: "Заявка уже создана по этим данным ✅",
    dup_pending_hint:
      "Если вы ещё не оплатили, откройте ссылку ниже и завершите платёж:",
    dup_done_title: "Заявка по этим данным уже оплачена ✅",
    dup_done_hint:
      "Если нужно повторить — измените данные (например, другой инвойс) или напишите в поддержку.",
  },
  uz: {
    choose_lang_title: "Tilni tanlang va davom eting!",
    choose_lang_sub: "Botdan foydalanish uchun tilni tanlang!",
    start_prompt:
      "Ma’lumotlarni yuboring — hisoblarni tekshiraman va umumiy summani chiqaraman.\nQuyidagi tugmani bosing 👇",
    ask_plate: "*Plate number* (avto raqami) ni kiriting:",
    ask_invoice: "Endi xatdagi *Invoice/Violation number* ni kiriting:",
    plate_invalid:
      "Plate noto‘g‘ri ko‘rinadi. Namuna: *RLRYY99* yoki *ABC-1234*.",
    invoice_invalid:
      "Invoice/Violation raqami noto‘g‘ri. Namuna: *T062549136462*.",
    checking: "NJ E-ZPass bazasida tekshiryapman… ⏳",
    not_found: "Hisoblar topilmadi.\n\n",
    found_items_title: "Topilgan hisoblar:",
    start_hint:
      "Ma’lumot kiritish uchun «E-ZPass to‘lash» tugmasini bosing.",
    start_main: "E-ZPass to‘lash",
    help: "Yordam",
    plan1_btn: "1) To‘g‘ridan-to‘g‘ri to‘lov",
    plan2_btn: "2) Chegirma bilan",
    ask_ezpass_acc:
      "*E-ZPass account number* ni kiriting (masalan, *99999999*). Chegirma varianti uchun majburiy.",
    ezpass_acc_invalid:
      "E-ZPass hisob raqami noto‘g‘ri. Iltimos, *6–12* raqam kiriting. Masalan: *99999999*.",
    // история
    hist_btn: "📄 Buyurtmalar tarixi",
    hist_title: "📄 Buyurtmalar tarixi:",
    hist_none: "Tarix bo‘sh.",
    hist_item: (r: RequestRow) =>
      `• ${r.invoice} — $${n(r.total_usd).toFixed(
        2
      )} | Reja: ${
        r.plan_label === "plan1_direct" ? "To‘g‘ridan-to‘g‘ri" : "Chegirma bilan"
      } | Holat: ${mapStatusUz(r.status)} | ${formatDate(r.created_at)}`,
    // дубликаты
    dup_creating_title:
      "Ushbu ma’lumotlar bo‘yicha ariza yaratilmoqda… ⏳",
    dup_creating_hint:
      "Bir necha soniya kuting. Agar havola allaqachon bo‘lsa — yangisini yaratmasdan undan foydalaning.",
    dup_pending_title:
      "Ushbu ma’lumotlar bo‘yicha ariza allaqachon yaratilgan ✅",
    dup_pending_hint:
      "Hali to‘lovni yakunlamagan bo‘lsangiz, quyidagi havola orqali davom eting:",
    dup_done_title:
      "Ushbu ma’lumotlar bo‘yicha to‘lov allaqachon bajarilgan ✅",
    dup_done_hint:
      "Qayta to‘lash uchun ma’lumotlarni o‘zgartiring (masalan, boshqa invoice) yoki yordamga yozing.",
  },
};

/* ================== session ================== */
type Step = "lang" | "idle" | "await_plate" | "await_invoice" | "await_ezpass_account";
type Session = {
  step: Step;
  plate?: string;
  invoice?: string;
  ezpassAccount?: string;
  lastTotal?: number;
  lang: Lang;
};
const sessions = new Map<number, Session>();
function s(chatId: number): Session {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: "lang", lang: "ru" });
  return sessions.get(chatId)!;
}

/* ================== in-memory dedup ================== */
type PlanLabel = "plan1_direct" | "plan2_discount";
type ReqEntry = {
  status: "creating" | "pending" | "completed";
  sessionId?: string;
  url?: string;
  totalUsd: number;
  createdAt: number;
  planLabel: PlanLabel;
  plate: string;
  invoice: string;
  ezpassAccount?: string;
  chatId: string;
};
const REQS: { pending: Map<string, ReqEntry>; done: Map<string, ReqEntry> } =
  (globalThis as any).__REQS__ || ((globalThis as any).__REQS__ = { pending: new Map(), done: new Map() });
const CREATING: Set<string> =
  (globalThis as any).__CREATING__ || ((globalThis as any).__CREATING__ = new Set<string>());
const GROUP_LOCK: Set<string> =
  (globalThis as any).__GROUPLOCK__ || ((globalThis as any).__GROUPLOCK__ = new Set<string>());

function normPlateOrInvoice(x: string) {
  return x.trim().replace(/[\u00A0\u202F\s]+/g, "").replace(/[–—−]/g, "-").toUpperCase();
}
function normAcc(x: string) { return x.replace(/[^\d]/g, ""); }
function makeKey(parts: { plan: PlanLabel; chatId: number | string; plate: string; invoice: string; acc?: string }) {
  const payload = JSON.stringify({
    p: parts.plan, c: String(parts.chatId),
    pl: normPlateOrInvoice(parts.plate),
    in: normPlateOrInvoice(parts.invoice),
    ac: parts.acc ? normAcc(parts.acc) : "",
  });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return `EZP:${hash}`;
}
function makeGroupKey(plan: PlanLabel, chatId: number | string, plate: string, invoice: string) {
  const payload = JSON.stringify({
    p: plan, c: String(chatId), pl: normPlateOrInvoice(plate), in: normPlateOrInvoice(invoice),
  });
  return `GRP:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}
function getDup(key: string): ReqEntry | undefined {
  return REQS.pending.get(key) || REQS.done.get(key);
}
function findExistingByGroup(groupKey: string): ReqEntry | undefined {
  for (const [, v] of REQS.pending) {
    const g2 = makeGroupKey(v.planLabel, v.chatId, v.plate, v.invoice);
    if (g2 === groupKey) return v;
  }
  for (const [, v] of REQS.done) {
    const g2 = makeGroupKey(v.planLabel, v.chatId, v.plate, v.invoice);
    if (g2 === groupKey) return v;
  }
  return undefined;
}

/* ================== keyboards & helpers ================== */
const kbLang = Markup.inlineKeyboard([
  [Markup.button.callback("Русский 🇷🇺", "lang_ru"), Markup.button.callback("O‘zbekcha 🇺🇿", "lang_uz")],
]);

const kbStart = (lang: Lang) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(lang === "ru" ? t.ru.start_main : t.uz.start_main, "start_flow")],
    [Markup.button.callback(lang === "ru" ? t.ru.help : t.uz.help, "help")],
    [Markup.button.callback(lang === "ru" ? t.ru.hist_btn : t.uz.hist_btn, "history")],
    [
      Markup.button.callback("🌐 " + (lang === "ru" ? "Сменить язык" : "Tilni o‘zgartirish"), "lang_menu"),
      Markup.button.callback("🔄 " + (lang === "ru" ? "Перезапустить" : "Qayta boshlash"), "soft_restart"),
    ],
  ]);

async function safeEdit(ctx: any, text: string, extra?: any) {
  try {
    if (ctx.update?.callback_query?.message) {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (e: any) {
    const msg = e?.description || e?.message || "";
    if (/message is not modified/i.test(msg)) await ctx.answerCbQuery().catch(() => {});
    else throw e;
  }
}

async function showLangMenu(ctx: any) {
  const text =
    `${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n` +
    `${t.uz.choose_lang_title}\n${t.uz.choose_lang_sub}`;
  return safeEdit(ctx, text, kbLang);
}
function reaskSameStep(ctx: any, ses: Session) {
  const lang = ses.lang;
  if (ses.step === "await_plate") {
    return safeEdit(ctx, lang === "ru" ? t.ru.ask_plate : t.uz.ask_plate, { parse_mode: "Markdown" });
  }
  if (ses.step === "await_invoice") {
    return safeEdit(ctx, lang === "ru" ? t.ru.ask_invoice : t.uz.ask_invoice, { parse_mode: "Markdown" });
  }
  if (ses.step === "await_ezpass_account") {
    return safeEdit(ctx, lang === "ru" ? t.ru.ask_ezpass_acc : t.uz.ask_ezpass_acc, { parse_mode: "Markdown" });
  }
  return safeEdit(ctx, lang === "ru" ? t.ru.start_prompt : t.uz.start_prompt, kbStart(lang));
}

function buildPlansText(
  lang: Lang,
  T: number,
  p1: { service: number; fees: number; total: number },
  p2: { allowed: boolean; discounted: number; service: number; serviceReduced?: boolean; fees: number; total: number }
) {
  if (lang === "uz") {
    let s = "";
    s += `Bazadagi jami: *$${T.toFixed(2)}*\n\n`;
    s += `Bizda 2 xil xizmat mavjud.\n\n`;
    s += `*1-variant — chegirmasiz, to‘g‘ridan-to‘g‘ri to‘lov!*\n`;
    s += `Toll to‘lovi — *$${T.toFixed(2)}*\n`;
    s += `Xizmat haqi — *$${p1.service.toFixed(2)}*\n`;
    s += `Boshqa xarajatlar — *$${p1.fees.toFixed(2)}*\n`;
    s += `Jami — *$${p1.total.toFixed(2)}*\n\n`;
    s += `❗️❗️❗️ *MUHIM:* 1-variantda bajarilish muddati *6 ish soatigacha*. ❗️❗️❗️\n\n`;
    if (p2.allowed) {
      s += `*2-variant — minimal 10% chegirma beriladi.* (Chegirma kattaroq bo‘lishi mumkin; farq kartangizga qaytariladi.)\n`;
      s += `Toll to‘lovi — *$${p2.discounted.toFixed(2)}*\n`;
      s += `Xizmat haqi — *$${p2.service.toFixed(2)}*${p2.serviceReduced ? " _(minusga chiqib ketmasligingiz uchun kamaytirildi)_" : ""}\n`;
      s += `Boshqa xarajatlar — *$${p2.fees.toFixed(2)}*\n`;
      s += `Jami — *$${p2.total.toFixed(2)}* (summa yanada kam bo‘lishi mumkin ☺️)\n\n`;
      s += `❗️❗️❗️ *MUHIM:* 2-variantda bajarilish muddati *2 ish kunigacha*. ❗️❗️❗️\n\n`;
    } else {
      s += `*2-variant* hozircha mavjud emas: tanlash uchun minimal summa — *$70*.\n\n`;
    }
    s += `Quyida xizmatni tanlang 👇🏻`;
    return s;
  }

  let s = "";
  s += `Итого по базе найдено: *$${T.toFixed(2)}*\n\n`;
  s += `У нас имеются 2 вида услуг.\n\n`;
  s += `*1-й вид - без скидок, оплата на прямую!*\n`;
  s += `Плата за толл - *$${T.toFixed(2)}*\n`;
  s += `Плата за сервис - *$${p1.service.toFixed(2)}*\n`;
  s += `Остальные расходы - *$${p1.fees.toFixed(2)}*\n`;
  s += `Тотал - *$${p1.total.toFixed(2)}*\n\n`;
  s += `❗️❗️❗️ ВАЖНО ПРИ ВЫБОРЕ 1-ГО ВАРИАНТА СРОК ДОСТАВКИ ДО *6 РАБОЧИХ ЧАСОВ* ❗️❗️❗️\n\n`;
  if (p2.allowed) {
    s += `*2-ой вид - выдается минимальная скидка в размере 10%.* (скидка может быть выше, остаток мы вернём на вашу карту.)\n`;
    s += `Плата за толл - *$${p2.discounted.toFixed(2)}*\n`;
    s += `Плата за сервис - *$${p2.service.toFixed(2)}*${p2.serviceReduced ? " _(снижено, чтобы вы не ушли в минус)_" : ""}\n`;
    s += `Остальные расходы - *$${p2.fees.toFixed(2)}*\n`;
    s += `Тотал - *$${p2.total.toFixed(2)}* (сумма может быть ниже ☺️)\n\n`;
    s += `❗️❗️❗️ ВАЖНО ПРИ ВЫБОРЕ 2-ГО ВАРИАНТА СРОК ДОСТАВКИ ДО *2-Х РАБОЧИХ ДНЕЙ* ❗️❗️❗️\n\n`;
  } else {
    s += `*2-ой вид* временно недоступен: минимальная сумма для выбора второго пункта — *$70*.\n\n`;
  }
  s += `Выберите услугу ниже 👇🏻`;
  return s;
}

/* ================== bot ================== */
export function createBot(token: string) {
  const bot = new Telegraf(token);

  // показать команды в меню клиента
  bot.telegram.setMyCommands([
    { command: "start", description: "Start / Старт" },
    { command: "lang", description: "Change language / Сменить язык" },
    { command: "restart", description: "Restart / Перезапустить" },
    { command: "history", description: "Request history / История заявок" },
  ]).catch(() => {});

  // /restart — мягкий рестарт для пользователя
  bot.command("restart", async (ctx) => {
    sessions.delete(ctx.chat!.id);
    return showLangMenu(ctx);
  });
  // кнопка-псевдорестарт
  bot.action("soft_restart", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    sessions.delete(ctx.chat!.id);
    return showLangMenu(ctx);
  });

  // /lang и быстрые команды
  bot.command(["lang", "language"], async (ctx) => showLangMenu(ctx));
  bot.command(["ru", "russian", "rus"], async (ctx) => {
    const ses = s(ctx.chat!.id);
    ses.lang = "ru";
    return reaskSameStep(ctx, ses);
  });
  bot.command(["uz", "uzb", "ozbek", "o‘zbek", "o-zbek"], async (ctx) => {
    const ses = s(ctx.chat!.id);
    ses.lang = "uz";
    return reaskSameStep(ctx, ses);
  });

  // /history как команда (в дополнение к кнопке)
  bot.command("history", async (ctx) => {
    const ses = s(ctx.chat!.id);
    const lang = ses.lang;
    const rows = await listByChat(String(ctx.chat!.id), 15);
    if (!rows.length) {
      return ctx.reply(lang === "ru" ? t.ru.hist_none : t.uz.hist_none, {
        reply_markup: kbStart(lang).reply_markup,
      });
    }
    const items =
      lang === "ru"
        ? rows.map((r) => t.ru.hist_item(r)).join("\n")
        : rows.map((r) => t.uz.hist_item(r)).join("\n");
    const title = lang === "ru" ? t.ru.hist_title : t.uz.hist_title;
    return ctx.reply(`${title}\n\n${items}`, {
      reply_markup: kbStart(lang).reply_markup,
    });
  });

  // /start — выбор языка
  bot.start(async (ctx) => showLangMenu(ctx));

  // язык из меню
  bot.action("lang_menu", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return showLangMenu(ctx);
  });
  bot.action("lang_ru", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    ses.lang = "ru";
    if (ses.step === "lang") ses.step = "idle";
    return reaskSameStep(ctx, ses);
  });
  bot.action("lang_uz", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    ses.lang = "uz";
    if (ses.step === "lang") ses.step = "idle";
    return reaskSameStep(ctx, ses);
  });

  // help
  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    const lang = ses.lang;
    const name = ctx.from?.first_name || "";
    const text =
      lang === "ru"
        ? `Привет, ${name}!\n\n☎️ +1 999 999 99 99\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nНажми «Оплатить E-ZPass», чтобы начать.\n\nКоманды: /lang, /history, /restart`
        : `Salom, ${name}!\n\n☎️ +1 999 999 99 99\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nBoshlash uchun «E-ZPass to‘lash» tugmasini bosing.\n\nBuyruqlar: /lang, /history, /restart`;
    return safeEdit(ctx, text, kbStart(lang));
  });

  // >>> старт потока
  bot.action("start_flow", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    ses.step = "await_plate";
    ses.plate = undefined;
    ses.invoice = undefined;
    ses.ezpassAccount = undefined;
    ses.lastTotal = undefined;
    return safeEdit(ctx, ses.lang === "ru" ? t.ru.ask_plate : t.uz.ask_plate, {
      parse_mode: "Markdown",
    });
  });

  // === История заявок (кнопка)
  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    const lang = ses.lang;
    const rows = await listByChat(String(ctx.chat!.id), 15);
    if (!rows.length) {
      return safeEdit(ctx, lang === "ru" ? t.ru.hist_none : t.uz.hist_none, {
        reply_markup: kbStart(lang).reply_markup,
      });
    }
    const items =
      lang === "ru"
        ? rows.map((r) => t.ru.hist_item(r)).join("\n")
        : rows.map((r) => t.uz.hist_item(r)).join("\n");
    const title = lang === "ru" ? t.ru.hist_title : t.uz.hist_title;
    return safeEdit(ctx, `${title}\n\n${items}`, {
      reply_markup: kbStart(lang).reply_markup,
    });
  });

  // === Вводы (plate/invoice/account)
  bot.on("text", async (ctx) => {
    const ses = s(ctx.chat!.id);
    const lang: Lang = ses.lang;
    const msg = (ctx.message.text || "").trim();

    if (ses.step === "await_plate") {
      if (!/^[A-Z0-9\-]{2,10}$/i.test(msg)) {
        return ctx.reply(
          lang === "ru" ? t.ru.plate_invalid : t.uz.plate_invalid,
          { parse_mode: "Markdown" }
        );
      }
      ses.plate = msg.toUpperCase();
      ses.step = "await_invoice";
      return ctx.reply(
        lang === "ru" ? t.ru.ask_invoice : t.uz.ask_invoice,
        { parse_mode: "Markdown" }
      );
    }

    if (ses.step === "await_invoice") {
      if (!/^[A-Z0-9\-]{6,20}$/i.test(msg)) {
        return ctx.reply(
          lang === "ru" ? t.ru.invoice_invalid : t.uz.invoice_invalid,
          { parse_mode: "Markdown" }
        );
      }
      ses.invoice = msg.toUpperCase();
      ses.step = "idle";

      await ctx.reply(lang === "ru" ? t.ru.checking : t.uz.checking);

      try {
        const res = await checkEzpassNJ({
          invoiceNumber: ses.invoice!,
          plate: ses.plate!,
        });

        const lines: string[] = [];
        if (res.items?.length) {
          lines.push(
            lang === "ru" ? t.ru.found_items_title : t.uz.found_items_title
          );
          for (const it of res.items) {
            const nnn = it.noticeNumber ? `#${it.noticeNumber}` : "—";
            lines.push(`• ${nnn} — $${it.amountDue.toFixed(2)}`);
          }
        }

        const T = +(res.total || 0).toFixed(2);
        ses.lastTotal = T;

        const header =
          (lines.length
            ? lines.join("\n") + "\n\n"
            : lang === "ru"
            ? t.ru.not_found
            : t.uz.not_found);

        // Если ничего не найдено — не предлагать оплату
        if (T <= 0) {
          return ctx.reply(header + (lang === "ru" ? t.ru.start_hint : t.uz.start_hint), {
            parse_mode: "Markdown",
            reply_markup: kbStart(lang).reply_markup,
          });
        }

        const p1 = calcPlan1(T);
        const p2 = calcPlan2(T, 15);
        const body = buildPlansText(lang, T, p1, p2);

        const kb = Markup.inlineKeyboard([
          [Markup.button.callback(lang === "ru" ? t.ru.plan1_btn : t.uz.plan1_btn, "pay_plan1")],
          ...(p2.allowed
            ? [[Markup.button.callback(lang === "ru" ? t.ru.plan2_btn : t.uz.plan2_btn, "pay_plan2")]]
            : []),
          [
            Markup.button.callback("🌐 " + (lang === "ru" ? "Сменить язык" : "Tilni o‘zgartirish"), "lang_menu"),
            Markup.button.callback("🔄 " + (lang === "ru" ? "Перезапустить" : "Qayta boshlash"), "soft_restart"),
          ],
        ]);

        return ctx.reply(header + body, {
          parse_mode: "Markdown",
          reply_markup: kb.reply_markup,
        });
      } catch {
        return ctx.reply(
          lang === "ru"
            ? "Не удалось получить данные. Проверь номера или попробуй позже."
            : "Ma’lumotlarni olish muvaffaqiyatsiz. Raqamlarni tekshirib, yana urinib ko‘ring.",
          kbStart(lang)
        );
      }
    }

    if (ses.step === "await_ezpass_account") {
      const cleaned = normAcc(msg);
      if (!/^\d{6,12}$/.test(cleaned)) {
        return ctx.reply(
          lang === "ru" ? t.ru.ezpass_acc_invalid : t.uz.ezpass_acc_invalid,
          { parse_mode: "Markdown" }
        );
      }
      ses.ezpassAccount = cleaned;
      ses.step = "idle";

      const key = makeKey({
        plan: "plan2_discount",
        chatId: ctx.chat!.id,
        plate: ses.plate || "",
        invoice: ses.invoice || "",
        acc: ses.ezpassAccount || "",
      });
      const groupKey = makeGroupKey(
        "plan2_discount",
        ctx.chat!.id,
        ses.plate || "",
        ses.invoice || ""
      );

      if (GROUP_LOCK.has(groupKey)) {
        const ex = findExistingByGroup(groupKey);
        if (ex && ex.status !== "completed" && ex.url) {
          const txt =
            `${lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title}\n\n` +
            `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
            `Plan: *2 (со скидкой)*  |  Сумма: *$${ex.totalUsd.toFixed(2)}*\n\n` +
            (lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
          return ctx.reply(txt, {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url("Оплатить (Stripe)", ex.url)],
            ]).reply_markup,
          });
        }
        if (ex && ex.status === "completed") {
          const txt =
            `${lang === "ru" ? t.ru.dup_done_title : t.uz.dup_done_title}\n\n` +
            `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
            `Plan: *2 (со скидкой)*\n\n` +
            (lang === "ru" ? t.ru.dup_done_hint : t.uz.dup_done_hint);
          return ctx.reply(txt, { parse_mode: "Markdown" });
        }
        const txt =
          `${lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title}\n\n` +
          (lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
        return ctx.reply(txt, { parse_mode: "Markdown" });
      }

      if (CREATING.has(key)) {
        const txt =
          `${lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title}\n\n` +
          (lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
        return ctx.reply(txt, { parse_mode: "Markdown" });
      }
      const dup = getDup(key);
      if (dup) {
        if (dup.status !== "completed" && dup.url) {
          const txt =
            `${lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title}\n\n` +
            `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
            `Plan: *2 (со скидкой)*  |  Сумма: *$${dup.totalUsd.toFixed(2)}*\n\n` +
            (lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
          return ctx.reply(txt, {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url("Оплатить (Stripe)", dup.url)],
            ]).reply_markup,
          });
        }
        const txt =
          `${lang === "ru" ? t.ru.dup_done_title : t.uz.dup_done_title}\n\n` +
          `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
          `Plan: *2 (со скидкой)*\n\n` +
          (lang === "ru" ? t.ru.dup_done_hint : t.uz.dup_done_hint);
        return ctx.reply(txt, { parse_mode: "Markdown" });
      }

      GROUP_LOCK.add(groupKey);
      CREATING.add(key);
      const T = +(ses.lastTotal || 0).toFixed(2);
      const p2 = calcPlan2(T, 15);
      REQS.pending.set(key, {
        status: "creating",
        totalUsd: p2.total,
        createdAt: Date.now(),
        planLabel: "plan2_discount",
        plate: ses.plate || "",
        invoice: ses.invoice || "",
        ezpassAccount: ses.ezpassAccount || "",
        chatId: String(ctx.chat!.id),
      });

      try {
        const { id, url } = await createTotalCheckout(
          {
            totalUsd: p2.total,
            planLabel: "plan2_discount",
            tollUsd: p2.discounted,
            serviceUsd: p2.service,
            feesUsd: p2.fees,
            chatId: ctx.chat!.id,
            username: ctx.from?.username,
            firstName: ctx.from?.first_name,
            plate: ses.plate || "",
            invoice: ses.invoice || "",
            ezpassState: "New Jersey",
            ezpassAccount: ses.ezpassAccount || "",
          },
          { idempotencyKey: key }
        );

        REQS.pending.set(key, {
          status: "pending",
          sessionId: id,
          url,
          totalUsd: p2.total,
          createdAt: Date.now(),
          planLabel: "plan2_discount",
          plate: ses.plate || "",
          invoice: ses.invoice || "",
          ezpassAccount: ses.ezpassAccount || "",
          chatId: String(ctx.chat!.id),
        });

        return ctx.reply(
          `Откройте Stripe и завершите оплату на *$${p2.total.toFixed(2)}*`,
          {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.url("Оплатить (Stripe)", url)],
            ]).reply_markup,
          }
        );
      } catch (e) {
        REQS.pending.delete(key);
        throw e;
      } finally {
        CREATING.delete(key);
      }
    }

    // дефолт
    return ctx.reply(
      ses.lang === "ru" ? t.ru.start_hint : t.uz.start_hint,
      kbStart(ses.lang)
    );
  });

  // === Plan 1 (прямая)
  bot.action("pay_plan1", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    const lang = ses.lang;

    const key = makeKey({
      plan: "plan1_direct",
      chatId: ctx.chat!.id,
      plate: ses.plate || "",
      invoice: ses.invoice || "",
    });
    const groupKey = makeGroupKey(
      "plan1_direct",
      ctx.chat!.id,
      ses.plate || "",
      ses.invoice || ""
    );

    if (GROUP_LOCK.has(groupKey)) {
      const ex = findExistingByGroup(groupKey);
      if (ex && ex.status !== "completed" && ex.url) {
        const txt =
          `${lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title}\n\n` +
          `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
          `Plan: *1 (прямая)*  |  Сумма: *$${ex.totalUsd.toFixed(2)}*\n\n` +
          (lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
        return ctx.reply(txt, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url("Оплатить (Stripe)", ex.url)],
          ]).reply_markup,
        });
      }
    }

    if (CREATING.has(key)) {
      const txt =
        `${lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title}\n\n` +
        (lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
      return ctx.reply(txt, { parse_mode: "Markdown" });
    }
    const dup = getDup(key);
    if (dup) {
      if (dup.status !== "completed" && dup.url) {
        const txt =
          `${lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title}\n\n` +
          `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
          `Plan: *1 (прямая)*  |  Сумма: *$${dup.totalUsd.toFixed(2)}*\n\n` +
          (lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
        return ctx.reply(txt, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url("Оплатить (Stripe)", dup.url)],
          ]).reply_markup,
        });
      }
      const txt =
        `${lang === "ru" ? t.ru.dup_done_title : t.uz.dup_done_title}\n\n` +
        `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
        `Plan: *1 (прямая)*\n\n` +
        (lang === "ru" ? t.ru.dup_done_hint : t.uz.dup_done_hint);
      return ctx.reply(txt, { parse_mode: "Markdown" });
    }

    GROUP_LOCK.add(groupKey);
    CREATING.add(key);

    const T = +(ses.lastTotal || 0).toFixed(2);
    const p1 = calcPlan1(T);

    REQS.pending.set(key, {
      status: "creating",
      totalUsd: p1.total,
      createdAt: Date.now(),
      planLabel: "plan1_direct",
      plate: ses.plate || "",
      invoice: ses.invoice || "",
      chatId: String(ctx.chat!.id),
    });

    try {
      const { id, url } = await createTotalCheckout(
        {
          totalUsd: p1.total,
          planLabel: "plan1_direct",
          tollUsd: T,
          serviceUsd: p1.service,
          feesUsd: p1.fees,
          chatId: ctx.chat!.id,
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          plate: ses.plate || "",
          invoice: ses.invoice || "",
          ezpassState: "New Jersey",
          ezpassAccount: "",
        },
        { idempotencyKey: key }
      );

      REQS.pending.set(key, {
        status: "pending",
        sessionId: id,
        url,
        totalUsd: p1.total,
        createdAt: Date.now(),
        planLabel: "plan1_direct",
        plate: ses.plate || "",
        invoice: ses.invoice || "",
        chatId: String(ctx.chat!.id),
      });

      await ctx.reply(
        `Откройте Stripe и завершите оплату на *$${p1.total.toFixed(2)}*`,
        {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url("Оплатить (Stripe)", url)],
          ]).reply_markup,
        }
      );
    } catch (e) {
      REQS.pending.delete(key);
      throw e;
    } finally {
      CREATING.delete(key);
    }
  });

  // === Plan 2 — запрос аккаунта
  bot.action("pay_plan2", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const ses = s(ctx.chat!.id);
    const T = +(ses.lastTotal || 0).toFixed(2);
    const p2 = calcPlan2(T, 15);
    if (!p2.allowed) {
      return ctx.reply(
        ses.lang === "ru"
          ? "Минимальная сумма для второго варианта — $70."
          : "Ikkinchi variant uchun minimal summa — $70."
      );
    }

    const groupKey = makeGroupKey(
      "plan2_discount",
      ctx.chat!.id,
      ses.plate || "",
      ses.invoice || ""
    );
    if (GROUP_LOCK.has(groupKey)) {
      const ex = findExistingByGroup(groupKey);
      if (ex && ex.status !== "completed" && ex.url) {
        const txt =
          `${ses.lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title}\n\n` +
          `Plate: *${ses.plate}*  |  Invoice: *${ses.invoice}*\n` +
          `Plan: *2 (со скидкой)*  |  Сумма: *$${ex.totalUsd.toFixed(2)}*\n\n` +
          (ses.lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
        return ctx.reply(txt, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url("Оплатить (Stripe)", ex.url)],
          ]).reply_markup,
        });
      }
    }

    ses.step = "await_ezpass_account";
    ses.ezpassAccount = undefined;
    return ctx.reply(
      ses.lang === "ru" ? t.ru.ask_ezpass_acc : t.uz.ask_ezpass_acc,
      { parse_mode: "Markdown" }
    );
  });

  return bot;
}
