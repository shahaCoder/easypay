// src/bot.ts
import { Telegraf, Markup } from "telegraf";
import { checkEzpassNJ, NjItem } from "./providers/ezpassnj";
import { calcPlan1, calcPlan2, createTotalCheckout } from "./payments";
import { ensureSchema, listByChat } from "./db";

/* ================== типы ================== */
type Lang = "ru" | "uz";
type Step = "lang" | "idle" | "await_plate" | "await_invoice" | "await_ezpass_account";
type PayScope = "total" | "single";
type PlanLabel = "plan1_direct" | "plan2_discount";

/* ================== i18n ================== */
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
    not_found: "Начисления не найдены. 🤷‍♂️\n\n",
    found_items_title: "🥳 Найдено начислений:",
    start_hint: "Нажми «Оплатить E-ZPass», чтобы ввести данные.",
    start_main: "Оплатить E-ZPass 💳",
    help: "Техподдержка 👨‍💻",
    history: "История заявок 📚",
    hist_none: "У вас пока нет заявок.",

    plan1_btn: "1) Прямая оплата",
    plan2_btn: "2) Со скидкой",
    pay_one_btn: "3) Оплатить один инвойс",

    ask_ezpass_acc:
      "Введите *E-ZPass account number* (например, *01900300545*). Обязательно для варианта со скидкой.",
    ezpass_acc_invalid:
      "Номер аккаунта E-ZPass выглядит странно. Введите *11* цифр. Пример: *01900300545*.",
    p2_min70: "Минимальная сумма для второго варианта — $70.",
    no_charges: "По базе нет начислений.",

    choose_one_title: "Выберите инвойс для оплаты:",
    pay_one_p1_btn: "Прямая оплата (за этот инвойс)",
    pay_one_p2_btn: "Со скидкой (за этот инвойс)",
    back_btn: "⬅️ Назад",
    lang_btn: "🌐 Сменить язык",

    pay_now: (amount: number) =>
      `Откройте Stripe и завершите оплату на *$${amount.toFixed(2)}*`,
  },
  uz: {
    start_prompt:
      "Ma’lumotlarni yuboring — hisoblarni tekshiraman va umumiy summani chiqaraman.\nQuyidagi tugmani bosing 👇",
    ask_plate: "*Plate number* (avto raqami) ni kiriting:",
    ask_invoice: "Endi xatdagi *Invoice/Violation number* ni kiriting:",
    plate_invalid:
      "Plate noto‘g‘ri ko‘rinadi. Namuna: *RLRYY99* yoki *ABC-1234*.",
    invoice_invalid:
      "Invoice/Violation raqami noto‘g‘ri. Namuna: *T062549136462*.",
    checking: "NJ E-ZPass bazasida tekshiryapman… ⏳",
    not_found: "Hisoblar topilmadi. 🤷‍♂️\n\n",
    found_items_title: "🥳 Topilgan hisoblar:",
    start_hint:
      "Ma’lumot kiritish uchun «E-ZPass to‘lash» tugmasini bosing.",
    start_main: "E-ZPass to‘lash 💳",
    help: "Yordam 👨‍💻",
    history: "Buyurtmalar tarixi 📚",
    hist_none: "Hali buyurtmalar yo‘q.",
    plan1_btn: "1) To‘g‘ridan-to‘g‘ri to‘lov",
    plan2_btn: "2) Chegirma bilan",
    pay_one_btn: "3) Bitta invoysni to‘lash",
    ask_ezpass_acc:
      "*E-ZPass account number* ni kiriting (masalan, *01900300545*). Chegirma varianti uchun majburiy.",
    ezpass_acc_invalid:
      "E-ZPass hisob raqami noto‘g‘ri. Iltimos, *11* raqam kiriting. Masalan: *01900300545*.",
    p2_min70: "Ikkinchi variant uchun minimal summa — $70.",
    no_charges: "Bazaga ko‘ra to‘lov yo‘q.",

    choose_one_title: "To‘lov uchun invoysni tanlang:",
    pay_one_p1_btn: "To‘g‘ridan-to‘g‘ri (shu invoys)",
    pay_one_p2_btn: "Chegirma bilan (shu invoys)",
    back_btn: "⬅️ Orqaga",
    lang_btn: "🌐 Tilni almashtirish",

    pay_now: (amount: number) =>
      `Stripe’ni oching va *$${amount.toFixed(2)}* miqdorni to‘lovini yakunlang`,
  },
};

/* ================== хранение сессии ================== */
type Session = {
  step: Step;
  plate?: string;
  invoice?: string;
  ezpassAccount?: string;
  lastTotal?: number;
  items?: NjItem[];
  singleIndex?: number | null;
  scope?: PayScope;
  lang: Lang;
};

const sessions = new Map<number, Session>();
const ses = (id: number): Session => {
  if (!sessions.has(id)) sessions.set(id, { step: "lang", lang: "ru" });
  return sessions.get(id)!;
};

/* ================== утилиты UI ================== */
const kbLang = Markup.inlineKeyboard([
  [Markup.button.callback("Русский 🇷🇺", "lang_ru"), Markup.button.callback("O‘zbekcha 🇺🇿", "lang_uz")],
]);

const kbStart = (lang: Lang) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(lang === "ru" ? t.ru.start_main : t.uz.start_main, "start_flow")],
    [Markup.button.callback(lang === "ru" ? t.ru.history : t.uz.history, "history")],
    [Markup.button.callback(lang === "ru" ? t.ru.help : t.uz.help, "help")],
    [Markup.button.callback(lang === "ru" ? t.ru.lang_btn : t.uz.lang_btn, "choose_lang")],
  ]);

const planTitle = (lang: Lang, plan: PlanLabel) =>
  lang === "ru"
    ? plan === "plan2_discount"
      ? "2 (со скидкой)"
      : "1 (прямая)"
    : plan === "plan2_discount"
    ? "2 (chegirma bilan)"
    : "1 (to‘g‘ridan-to‘g‘ri)";

const money = (x: number) => `$${Number(x || 0).toFixed(2)}`;
const middleEllipsis = (s: string, left = 6, right = 4) =>
  s.length <= left + right + 1 ? s : `${s.slice(0, left)}…${s.slice(-right)}`;
const invBtnLabel = (it: NjItem) =>
  `💵 ${money(it.amountDue)} — #${middleEllipsis(it.noticeNumber || "—")}`; // сумма слева

/* ================== анти-дабл-клик (in-memory) ================== */
const locks = new Map<string, number>(); // key -> expiresAt (ms)
const LOCK_TTL_MS = 20_000;
function acquireLock(key: string): boolean {
  const now = Date.now();
  const exp = locks.get(key);
  if (exp && exp > now) return false;
  locks.set(key, now + LOCK_TTL_MS);
  return true;
}
function releaseLock(key: string) {
  locks.delete(key);
}

/* ============== текст расчётов ============== */
function buildPlansText(
  lang: Lang,
  T: number,
  p1: { service: number; fees: number; total: number },
  p2: { allowed: boolean; discounted: number; service: number; serviceReduced?: boolean; fees: number; total: number }
) {
  if (T <= 0)
    return lang === "ru"
      ? "По базе нет начислений — платить нечего."
      : "Bazaga ko‘ra hech qanday to‘lov yo‘q — to‘lash shart emas.";

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

/* ================== экраны/клавиатуры ================== */
async function sendPlansMenu(ctx: any) {
  const S = ses(ctx.chat!.id);
  const lang = S.lang;

  const lines: string[] = [];
  if (S.items?.length) {
    lines.push(lang === "ru" ? t.ru.found_items_title : t.uz.found_items_title);
    for (const it of S.items) {
      const n = it.noticeNumber ? `#${it.noticeNumber}` : "—";
      lines.push(`• ${n} — $${it.amountDue.toFixed(2)}`);
    }
  }

  const T = +(S.lastTotal || 0).toFixed(2);
  const p1 = calcPlan1(T);
  const p2 = calcPlan2(T, 15);

  const header = lines.length ? lines.join("\n") + "\n\n" : lang === "ru" ? t.ru.not_found : t.uz.not_found;
  const body = buildPlansText(lang, T, p1, p2);

  const buttons: any[] = [[Markup.button.callback(lang === "ru" ? t.ru.lang_btn : t.uz.lang_btn, "choose_lang")]];
  if (T > 0) {
    buttons.unshift([Markup.button.callback(lang === "ru" ? t.ru.pay_one_btn : t.uz.pay_one_btn, "pay_one")]);
    if (p2.allowed) buttons.unshift([Markup.button.callback(lang === "ru" ? t.ru.plan2_btn : t.uz.plan2_btn, "pay_plan2")]);
    buttons.unshift([Markup.button.callback(lang === "ru" ? t.ru.plan1_btn : t.uz.plan1_btn, "pay_plan1")]);
  }

  await ctx.reply(header + body, {
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

/* ================== bot ================== */
export function createBot(token: string) {
  const bot = new Telegraf(token);

  // быстрый способ проверить, что крутится новый билд
  bot.command("version", async (ctx) => {
    await ctx.reply(`ezpass-bot build @ ${new Date().toISOString()}`);
  });

  bot.catch(async (err, ctx) => {
    console.error("Telegraf error:", err);
    const lang = ses(ctx.chat!.id).lang;
    await ctx.reply(lang === "ru" ? "Произошла ошибка. Попробуйте ещё раз /start." : "Xatolik yuz berdi. Yana /start yuboring.");
  });

  bot.command("restart", async (ctx) => {
    sessions.delete(ctx.chat!.id);
    await ctx.reply(`${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n`, kbLang);
  });

  bot.command("lang", async (ctx) => {
    await ctx.reply(`${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n`, kbLang);
  });
  bot.action("choose_lang", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(`${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n`, kbLang);
  });

  bot.start(async (ctx) => {
    const s = ses(ctx.chat!.id);
    s.step = "lang";
    await ctx.reply(`${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n`, kbLang);
  });

  bot.action("lang_ru", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    s.lang = "ru";
    s.step = "idle";
    await ctx.reply(t.ru.start_prompt, kbStart("ru"));
  });
  bot.action("lang_uz", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    s.lang = "uz";
    s.step = "idle";
    await ctx.reply(t.uz.start_prompt, kbStart("uz"));
  });

  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    const name = ctx.from?.first_name || "";
    const text =
      s.lang === "ru"
        ? `Привет, ${name}!\n\n☎️ +1 305 744 1538\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nНажми «Оплатить E-ZPass», чтобы начать.`
        : `Salom, ${name}!\n\n☎️ +1 305 744 1538\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nBoshlash uchun «E-ZPass to‘lash» tugmasini bosing.`;
    await ctx.reply(text, kbStart(s.lang));
  });

  // история — показываем то, что уже ОПЛАЧЕНО (вебхук создал записи)
  const num = (x: any) => Number(x ?? 0);
  const histItem = (lang: Lang, r: any) => {
    const header = lang === "ru" ? `План: ${r.plan_label === "plan1_direct" ? "Прямая" : "Со скидкой"}` : `Reja: ${r.plan_label === "plan1_direct" ? "To‘g‘ridan-to‘g‘ri" : "Chegirma bilan"}`;
    const status =
      r.status === "completed"
        ? lang === "ru"
          ? "Оплачено ✅"
          : "To‘langan ✅"
        : lang === "ru"
        ? "В обработке ♻️"
        : "Jarayonda ♻️";
    return [`#${String(r.id).slice(0, 8)} — ${header}`, `Plate: ${r.plate} | Invoice: ${r.invoice}`, `Статус: ${status}`, `Сумма: $${num(r.total_usd).toFixed(2)}`].join("\n");
  };

  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    const rows = await listByChat(String(ctx.chat!.id), 15);
    if (!rows.length) return ctx.reply(s.lang === "ru" ? t.ru.hist_none : t.uz.hist_none, kbStart(s.lang));
    const text = rows.map((r) => histItem(s.lang, r)).join("\n\n");
    await ctx.reply(text, kbStart(s.lang));
  });

  // старт ввода
  bot.action("start_flow", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    s.step = "await_plate";
    s.plate = s.invoice = s.ezpassAccount = undefined;
    s.lastTotal = undefined;
    s.items = [];
    s.singleIndex = null;
    s.scope = "total";
    await ctx.reply(s.lang === "ru" ? t.ru.ask_plate : t.uz.ask_plate, { parse_mode: "Markdown" });
  });

  // назад к меню планов (из любого подэкрана)
  bot.action("back_menu", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendPlansMenu(ctx);
  });

  // вводы
  bot.on("text", async (ctx) => {
    const S = ses(ctx.chat!.id);
    const lang = S.lang;
    const msg = (ctx.message.text || "").trim();

    if (S.step === "await_plate") {
      if (!/^[A-Z0-9\-]{2,10}$/i.test(msg))
        return ctx.reply(lang === "ru" ? t.ru.plate_invalid : t.uz.plate_invalid, { parse_mode: "Markdown" });
      S.plate = msg.toUpperCase();
      S.step = "await_invoice";
      return ctx.reply(lang === "ru" ? t.ru.ask_invoice : t.uz.ask_invoice, { parse_mode: "Markdown" });
    }

    if (S.step === "await_invoice") {
      if (!/^[A-Z0-9\-]{6,20}$/i.test(msg))
        return ctx.reply(lang === "ru" ? t.ru.invoice_invalid : t.uz.invoice_invalid, { parse_mode: "Markdown" });
      S.invoice = msg.toUpperCase();
      S.step = "idle";

      await ctx.reply(lang === "ru" ? t.ru.checking : t.uz.checking);

      // проверка NJ
      let res: any = null;
      try {
        res = await checkEzpassNJ({ invoiceNumber: S.invoice!, plate: S.plate! });
      } catch (e) {
        console.error("checkEzpassNJ error:", e);
        return ctx.reply(
          lang === "ru"
            ? "Сервис проверки временно недоступен. Попробуйте позже или напишите в поддержку."
            : "Tekshiruv xizmati vaqtincha mavjud emas. Birozdan so‘ng urinib ko‘ring yoki yordamga yozing.",
          kbStart(lang)
        );
      }

      S.lastTotal = +(res?.total || 0).toFixed(2);
      S.items = (res?.items || []) as NjItem[];
      S.singleIndex = null;
      S.scope = "total";

      return sendPlansMenu(ctx);
    }

    if (S.step === "await_ezpass_account") {
      const cleaned = msg.replace(/[^\d]/g, "");
      if (!/^\d{11}$/.test(cleaned))
        return ctx.reply(lang === "ru" ? t.ru.ezpass_acc_invalid : t.uz.ezpass_acc_invalid, { parse_mode: "Markdown" });
      S.ezpassAccount = cleaned;
      S.step = "idle";

      // === создать checkout (p2) — без сохранений в БД ===
      try {
        if (S.scope === "single" && S.items && S.singleIndex != null) {
          const item = S.items[S.singleIndex];
          const T = +(item?.amountDue || 0).toFixed(2);
          const p2 = calcPlan2(T, 15);
          const { url } = await createTotalCheckout(
            {
              totalUsd: p2.total,
              planLabel: "plan2_discount",
              tollUsd: p2.discounted,
              serviceUsd: p2.service,
              feesUsd: p2.fees,
              chatId: ctx.chat!.id,
              username: ctx.from?.username,
              firstName: ctx.from?.first_name,
              plate: S.plate || "",
              invoice: item?.noticeNumber || S.invoice || "",
              ezpassState: "New Jersey",
              ezpassAccount: S.ezpassAccount || "",
            },
            { idempotencyKey: `G:${ctx.chat!.id}:p2:one:${(S.plate || "").toUpperCase()}:${(item?.noticeNumber || S.invoice || "").toUpperCase()}:${Date.now()}` }
          );

          return ctx.reply((lang === "ru" ? t.ru.pay_now : t.uz.pay_now)(p2.total), {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([[Markup.button.url(lang === "ru" ? "Оплатить (Stripe)" : "To‘lash (Stripe)", url)]]).reply_markup,
          });
        } else {
          const T = +(S.lastTotal || 0).toFixed(2);
          const p2 = calcPlan2(T, 15);
          const { url } = await createTotalCheckout(
            {
              totalUsd: p2.total,
              planLabel: "plan2_discount",
              tollUsd: p2.discounted,
              serviceUsd: p2.service,
              feesUsd: p2.fees,
              chatId: ctx.chat!.id,
              username: ctx.from?.username,
              firstName: ctx.from?.first_name,
              plate: S.plate || "",
              invoice: S.invoice || "",
              ezpassState: "New Jersey",
              ezpassAccount: S.ezpassAccount || "",
            },
            { idempotencyKey: `G:${ctx.chat!.id}:p2:${(S.plate || "").toUpperCase()}:${(S.invoice || "").toUpperCase()}:${Date.now()}` }
          );

          return ctx.reply((lang === "ru" ? t.ru.pay_now : t.uz.pay_now)(p2.total), {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([[Markup.button.url(lang === "ru" ? "Оплатить (Stripe)" : "To‘lash (Stripe)", url)]]).reply_markup,
          });
        }
      } catch (e) {
        console.error("stripe checkout (p2) error:", (e as any)?.message || e);
        return ctx.reply(lang === "ru" ? "Не удалось создать платёжную ссылку. Попробуйте ещё раз." : "To‘lov havolasini yaratib bo‘lmadi. Qayta urinib ko‘ring.");
      }
    }

    return ctx.reply(S.lang === "ru" ? t.ru.start_hint : t.uz.start_hint, kbStart(S.lang));
  });

  /* ====== список инвойсов для оплаты одного ====== */
  bot.action("pay_one", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      const S = ses(ctx.chat!.id);
      const lang = S.lang;
      if (!S.items?.length) {
        return ctx.reply(lang === "ru" ? "Список инвойсов пуст." : "Invoyslar ro‘yxati bo‘sh.");
      }

      const rows: any[] = [];
      S.items.forEach((it, idx) => rows.push([Markup.button.callback(invBtnLabel(it), `one_${idx}`)]));
      rows.push([Markup.button.callback(lang === "ru" ? t.ru.back_btn : t.uz.back_btn, "back_menu")]);

      await ctx.reply(lang === "ru" ? t.ru.choose_one_title : t.uz.choose_one_title, {
        reply_markup: Markup.inlineKeyboard(rows).reply_markup,
      });
    } catch (e) {
      console.error("pay_one error:", e);
      await ctx.reply("Не удалось отобразить список инвойсов. Попробуйте ещё раз.");
    }
  });

  /* ====== выбор одного инвойса → выбор плана ====== */
  bot.action(/^one_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      const S = ses(ctx.chat!.id);
      const lang = S.lang;

      const data = (ctx.callbackQuery as any)?.data ?? "";
      const m = /^one_(\d+)$/.exec(data);
      const idx = m ? Number(m[1]) : -1;

      if (!Array.isArray(S.items) || idx < 0 || idx >= S.items.length) {
        return ctx.reply(
          lang === "ru"
            ? "Список инвойсов устарел. Нажмите «Оплатить один инвойс» ещё раз."
            : "Invoyslar ro‘yxati eskirgan. «Bitta invoysni to‘lash» tugmasini qayta bosing."
        );
      }
      S.singleIndex = idx;
      S.scope = "single";

      const item = S.items[idx];
      const p2 = calcPlan2(+item.amountDue.toFixed(2), 15);

      const buttons: any[] = [];
      buttons.push([Markup.button.callback(lang === "ru" ? t.ru.pay_one_p1_btn : t.uz.pay_one_p1_btn, `one_p1_${idx}`)]);
      if (p2.allowed) {
        buttons.push([Markup.button.callback(lang === "ru" ? t.ru.pay_one_p2_btn : t.uz.pay_one_p2_btn, `one_p2_${idx}`)]);
      } else {
        buttons.push([Markup.button.callback(lang === "ru" ? `${t.ru.pay_one_p2_btn} (недоступно < $70)` : `${t.uz.pay_one_p2_btn} (>$70)`, "noop")]);
      }
      buttons.push([Markup.button.callback(lang === "ru" ? t.ru.back_btn : t.uz.back_btn, "pay_one")]);

      const title =
        lang === "ru"
          ? `Выбран инвойс: *${item.noticeNumber || "—"}* на сумму *${money(item.amountDue)}*`
          : `Tanlangan invoys: *${item.noticeNumber || "—"}* — *${money(item.amountDue)}*`;

      await ctx.reply(title, { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
    } catch (e) {
      console.error("one_(i) error:", e);
      await ctx.reply("Не удалось открыть выбор плана. Попробуйте ещё раз «Оплатить один инвойс».");
    }
  });

  bot.action("noop", async (ctx) => { await ctx.answerCbQuery().catch(() => {}); });

  /* ====== оплата одного инвойса — прямая ====== */
  bot.action(/^one_p1_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const lang = S.lang;

    const data = (ctx.callbackQuery as any)?.data ?? "";
    const m = /^one_p1_(\d+)$/.exec(data);
    const idx = m ? Number(m[1]) : -1;

    if (!Array.isArray(S.items) || idx < 0 || idx >= S.items.length) {
      return ctx.reply(lang === "ru" ? "Список инвойсов устарел. Откройте его снова." : "Ro‘yxat eskirgan. Qayta oching.");
    }
    const item = S.items[idx];
    const T = +(item.amountDue || 0).toFixed(2);
    if (T <= 0) return ctx.reply(lang === "ru" ? t.ru.no_charges : t.uz.no_charges);

    // in-memory lock от даблкликов
    const lockKey = `${ctx.chat!.id}:p1:one:${(S.plate || "").toUpperCase()}:${(item.noticeNumber || "").toUpperCase()}`;
    if (!acquireLock(lockKey)) {
      return ctx.reply(lang === "ru" ? "Заявка уже формируется, проверьте предыдущие сообщения." : "So‘rov allaqachon yaratilmoqda.");
    }

    try {
      const p1 = calcPlan1(T);
      const { url } = await createTotalCheckout(
        {
          totalUsd: p1.total,
          planLabel: "plan1_direct",
          tollUsd: T,
          serviceUsd: p1.service,
          feesUsd: p1.fees,
          chatId: ctx.chat!.id,
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          plate: S.plate || "",
          invoice: item.noticeNumber || S.invoice || "",
          ezpassState: "New Jersey",
          ezpassAccount: "",
        },
        { idempotencyKey: `${lockKey}:${Date.now()}` }
      );

      await ctx.reply((lang === "ru" ? t.ru.pay_now : t.uz.pay_now)(p1.total), {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([[Markup.button.url(lang === "ru" ? "Оплатить (Stripe)" : "To‘lash (Stripe)", url)]]).reply_markup,
      });
    } catch (e) {
      console.error("stripe checkout (one_p1) error:", (e as any)?.message || e);
      await ctx.reply(lang === "ru" ? "Не удалось создать платёжную ссылку. Попробуйте ещё раз." : "To‘lov havolasini yaratib bo‘lmadi. Qayta urinib ko‘ring.");
    } finally {
      releaseLock(lockKey);
    }
  });

  /* ====== оплата одного инвойса — со скидкой: запрос аккаунта ====== */
  bot.action(/^one_p2_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const lang = S.lang;

    const data = (ctx.callbackQuery as any)?.data ?? "";
    const m = /^one_p2_(\d+)$/.exec(data);
    const idx = m ? Number(m[1]) : -1;

    if (!Array.isArray(S.items) || idx < 0 || idx >= S.items.length) {
      return ctx.reply(lang === "ru" ? "Список инвойсов устарел. Откройте его снова." : "Ro‘yxat eskirgan. Qayta oching.");
    }
    const item = S.items[idx];
    const T = +(item.amountDue || 0).toFixed(2);
    const p2 = calcPlan2(T, 15);
    if (!p2.allowed) return ctx.reply(lang === "ru" ? t.ru.p2_min70 : t.uz.p2_min70);

    S.scope = "single";
    S.singleIndex = idx;
    S.ezpassAccount = undefined;
    S.step = "await_ezpass_account";
    await ctx.reply(lang === "ru" ? t.ru.ask_ezpass_acc : t.uz.ask_ezpass_acc, { parse_mode: "Markdown" });
  });

  /* ====== план 2 (total) → запрос аккаунта ====== */
  bot.action("pay_plan2", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const T = +(S.lastTotal || 0).toFixed(2);
    const p2 = calcPlan2(T, 15);
    if (!p2.allowed) return ctx.reply(S.lang === "ru" ? t.ru.p2_min70 : t.uz.p2_min70);

    S.scope = "total";
    S.ezpassAccount = undefined;
    S.step = "await_ezpass_account";
    await ctx.reply(S.lang === "ru" ? t.ru.ask_ezpass_acc : t.uz.ask_ezpass_acc, { parse_mode: "Markdown" });
  });

  /* ====== план 1 (total) — сразу создаём checkout, БД не трогаем ====== */
  bot.action("pay_plan1", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const lang = S.lang;
    const T = +(S.lastTotal || 0).toFixed(2);
    if (T <= 0) return ctx.reply(lang === "ru" ? t.ru.no_charges : t.uz.no_charges);

    const lockKey = `${ctx.chat!.id}:p1:total:${(S.plate || "").toUpperCase()}:${(S.invoice || "").toUpperCase()}`;
    if (!acquireLock(lockKey)) {
      return ctx.reply(lang === "ru" ? "Заявка уже формируется, проверьте предыдущие сообщения." : "So‘rov allaqachon yaratilmoqda.");
    }

    try {
      const p1 = calcPlan1(T);
      const { url } = await createTotalCheckout(
        {
          totalUsd: p1.total,
          planLabel: "plan1_direct",
          tollUsd: T,
          serviceUsd: p1.service,
          feesUsd: p1.fees,
          chatId: ctx.chat!.id,
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          plate: S.plate || "",
          invoice: S.invoice || "",
          ezpassState: "New Jersey",
          ezpassAccount: "",
        },
        { idempotencyKey: `${lockKey}:${Date.now()}` }
      );

      await ctx.reply((lang === "ru" ? t.ru.pay_now : t.uz.pay_now)(p1.total), {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([[Markup.button.url(lang === "ru" ? "Оплатить (Stripe)" : "To‘lash (Stripe)", url)]]).reply_markup,
      });
    } catch (e) {
      console.error("stripe checkout (p1 total) error:", (e as any)?.message || e);
      await ctx.reply(lang === "ru" ? "Не удалось создать платёжную ссылку. Попробуйте ещё раз." : "To‘lov havolasini yaratib bo‘lmadi. Qayta urinib ko‘ring.");
    } finally {
      releaseLock(lockKey);
    }
  });

  return bot;
}

// Инициализация схемы БД (нужна для истории и вебхука, который создаёт записи ПОСЛЕ оплаты)
ensureSchema().catch((e) => {
  console.error("DB init error:", e);
});
