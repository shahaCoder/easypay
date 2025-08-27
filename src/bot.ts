// src/bot.ts
import { Telegraf, Markup } from "telegraf";
import { checkEzpassNJ } from "./providers/ezpassnj";
import { calcPlan1, calcPlan2, createTotalCheckout } from "./payments";
import {
  ensureSchema,
  insertCreatingOrGetExisting,
  setPending,
  listByChat,
  findActive,
  PlanLabel,
} from "./db";

/* ================== i18n ================== */
type Lang = "ru" | "uz";

const t = {
  ru: {
    choose_lang_title: "Выберите язык чтобы продолжить!",
    choose_lang_sub: "Botdan foydalanish uchun tilni tanlang!",
    start_prompt:
      "Введи данные — проверю все инвойсы и выведу итог.\nНажми кнопку ниже 👇",
    ask_plate: "Введи *Plate number* (как на номере авто):",
    ask_invoice:
      "Теперь введи *Invoice/Violation number* (с письма):",
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
    history: "История заявок",
    hist_none: "У вас пока нет заявок.",
    plan1_btn: "1) Прямая оплата",
    plan2_btn: "2) Со скидкой",
    ask_ezpass_acc:
      "Введите *E-ZPass account number* (например, *99999999*). Обязательно для варианта со скидкой.",
    ezpass_acc_invalid:
      "Номер аккаунта E-ZPass выглядит странно. Введите от *6* до *12* цифр. Пример: *99999999*.",

    dup_creating_title: "Заявка по этим данным уже создаётся… ⏳",
    dup_creating_hint:
      "Подождите несколько секунд. Если ссылка уже была — используйте её, не создавая новую.",
    dup_pending_title: "Заявка уже создана по этим данным ✅",
    dup_pending_hint:
      "Если вы ещё не оплатили, откройте ссылку ниже и завершите платёж:",
    dup_done_title: "Заявка по этим данным уже оплачена ✅",
    dup_done_hint:
      "Если нужно повторить — измените данные (например, другой инвойс) или напишите в поддержку.",
    lang_btn: "🌐 Сменить язык",
  },
  uz: {
    choose_lang_title: "Tilni tanlang va davom eting!",
    choose_lang_sub: "Botdan foydalanish uchun tilni tanlang!",
    start_prompt:
      "Ma’lumotlarni yuboring — hisoblarni tekshiraman va umumiy summani chiqaraman.\nQuyidagi tugmani bosing 👇",
    ask_plate: "*Plate number* (avto raqami) ni kiriting:",
    ask_invoice:
      "Endi xatdagi *Invoice/Violation number* ni kiriting:",
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
    history: "Buyurtmalar tarixi",
    hist_none: "Hali buyurtmalar yo‘q.",
    plan1_btn: "1) To‘g‘ridan-to‘g‘ri to‘lov",
    plan2_btn: "2) Chegirma bilan",
    ask_ezpass_acc:
      "*E-ZPass account number* ni kiriting (masalan, *99999999*). Chegirma varianti uchun majburiy.",
    ezpass_acc_invalid:
      "E-ZPass hisob raqami noto‘g‘ri. Iltimos, *6–12* raqam kiriting. Masalan: *99999999*.",

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
    lang_btn: "🌐 Tilni almashtirish",
  },
};

type Step =
  | "lang"
  | "idle"
  | "await_plate"
  | "await_invoice"
  | "await_ezpass_account";

type Session = {
  step: Step;
  plate?: string;
  invoice?: string;
  ezpassAccount?: string;
  lastTotal?: number;
  lang: Lang;
};
const sessions = new Map<number, Session>();
const ses = (id: number): Session => {
  if (!sessions.has(id)) sessions.set(id, { step: "lang", lang: "ru" });
  return sessions.get(id)!;
};

const kbLang = Markup.inlineKeyboard([
  [
    Markup.button.callback("Русский 🇷🇺", "lang_ru"),
    Markup.button.callback("O‘zbekcha 🇺🇿", "lang_uz"),
  ],
]);

const kbStart = (lang: Lang) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(lang === "ru" ? t.ru.start_main : t.uz.start_main, "start_flow")],
    [Markup.button.callback(lang === "ru" ? t.ru.history : t.uz.history, "history")],
    [Markup.button.callback(lang === "ru" ? t.ru.help : t.uz.help, "help")],
    [Markup.button.callback(lang === "ru" ? t.ru.lang_btn : t.uz.lang_btn, "choose_lang")],
  ]);

function buildPlansText(
  lang: Lang,
  T: number,
  p1: { service: number; fees: number; total: number },
  p2: {
    allowed: boolean;
    discounted: number;
    service: number;
    serviceReduced?: boolean;
    fees: number;
    total: number;
  }
) {
  if (T <= 0) {
    return lang === "ru"
      ? "По базе нет начислений — платить нечего."
      : "Bazaga ko‘ra hech qanday to‘lov yo‘q — to‘lash shart emas.";
  }

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

  // на всякий случай: общий catcher, чтобы «не висло»
  bot.catch(async (err, ctx) => {
    console.error("Telegraf error:", err);
    const lang = ses(ctx.chat!.id).lang;
    await ctx.reply(
      lang === "ru"
        ? "Произошла ошибка. Попробуйте ещё раз /start."
        : "Xatolik yuz berdi. Yana /start yuboring."
    );
  });

  // /lang — смена языка в любой момент
  bot.command("lang", async (ctx) => {
    await ctx.reply(
      `${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n${t.uz.choose_lang_title}\n${t.uz.choose_lang_sub}`,
      kbLang
    );
  });
  bot.action("choose_lang", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n${t.uz.choose_lang_title}\n${t.uz.choose_lang_sub}`,
      kbLang
    );
  });

  // /start
  bot.start(async (ctx) => {
    const s = ses(ctx.chat!.id);
    s.step = "lang";
    await ctx.reply(
      `${t.ru.choose_lang_title}\n${t.ru.choose_lang_sub}\n\n${t.uz.choose_lang_title}\n${t.uz.choose_lang_sub}`,
      kbLang
    );
  });

  // выбрать язык (всегда отправляем НОВОЕ сообщение, без редактирования)
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

  // справка
  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    const name = ctx.from?.first_name || "";
    const text =
      s.lang === "ru"
        ? `Привет, ${name}!\n\n☎️ +1 999 999 99 99\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nНажми «Оплатить E-ZPass», чтобы начать.`
        : `Salom, ${name}!\n\n☎️ +1 999 999 99 99\n🔹 @easypayusasupport\n✉️ example@easypayusasupport.com\n\nBoshlash uchun «E-ZPass to‘lash» tugmasini bosing.`;
    await ctx.reply(text, kbStart(s.lang));
  });

  // история
  const n = (x: any) => Number(x ?? 0);
  const histItem = (lang: Lang, r: any) => {
    const header =
      lang === "ru"
        ? `План: ${r.plan_label === "plan1_direct" ? "Прямая" : "Со скидкой"}`
        : `Reja: ${r.plan_label === "plan1_direct" ? "To‘g‘ridan-to‘g‘ri" : "Chegirma bilan"}`;
    const status =
      r.status === "pending"
        ? (lang === "ru" ? "ожидает оплаты" : "to‘lov kutilmoqda")
        : r.status === "completed"
        ? (lang === "ru" ? "оплачено" : "to‘langan")
        : (lang === "ru" ? "создаётся" : "yaratilmoqda");
    return [
      `#${r.id.slice(0, 8)} — ${header}`,
      `Plate: ${r.plate} | Invoice: ${r.invoice}`,
      `Статус: ${status}`,
      `Сумма: $${n(r.total_usd).toFixed(2)}`
    ].join("\n");
  };

  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    const rows = await listByChat(String(ctx.chat!.id), 15);
    if (!rows.length) {
      return ctx.reply(s.lang === "ru" ? t.ru.hist_none : t.uz.hist_none, kbStart(s.lang));
    }
    const text = rows.map((r) => histItem(s.lang, r)).join("\n\n");
    await ctx.reply(text, kbStart(s.lang));
  });

  // начать ввод
  bot.action("start_flow", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const s = ses(ctx.chat!.id);
    s.step = "await_plate";
    s.plate = s.invoice = s.ezpassAccount = undefined;
    s.lastTotal = undefined;
    await ctx.reply(s.lang === "ru" ? t.ru.ask_plate : t.uz.ask_plate, { parse_mode: "Markdown" });
  });

  // вводы
  bot.on("text", async (ctx) => {
    const S = ses(ctx.chat!.id);
    const lang = S.lang;
    const msg = (ctx.message.text || "").trim();

    if (S.step === "await_plate") {
      if (!/^[A-Z0-9\-]{2,10}$/i.test(msg)) {
        return ctx.reply(lang === "ru" ? t.ru.plate_invalid : t.uz.plate_invalid, { parse_mode: "Markdown" });
      }
      S.plate = msg.toUpperCase();
      S.step = "await_invoice";
      return ctx.reply(lang === "ru" ? t.ru.ask_invoice : t.uz.ask_invoice, { parse_mode: "Markdown" });
    }

    if (S.step === "await_invoice") {
      if (!/^[A-Z0-9\-]{6,20}$/i.test(msg)) {
        return ctx.reply(lang === "ru" ? t.ru.invoice_invalid : t.uz.invoice_invalid, { parse_mode: "Markdown" });
      }
      S.invoice = msg.toUpperCase();
      S.step = "idle";

      await ctx.reply(lang === "ru" ? t.ru.checking : t.uz.checking);

      // проверка в NJ
      const res = await checkEzpassNJ({ invoiceNumber: S.invoice!, plate: S.plate! });

      const lines: string[] = [];
      if (res.items?.length) {
        lines.push(lang === "ru" ? t.ru.found_items_title : t.uz.found_items_title);
        for (const it of res.items) {
          const n = it.noticeNumber ? `#${it.noticeNumber}` : "—";
          lines.push(`• ${n} — $${it.amountDue.toFixed(2)}`);
        }
      }

      const T = +(res.total || 0).toFixed(2);
      S.lastTotal = T;

      const p1 = calcPlan1(T);
      const p2 = calcPlan2(T, 15);

      const header = lines.length ? lines.join("\n") + "\n\n" : (lang === "ru" ? t.ru.not_found : t.uz.not_found);
      const body = buildPlansText(lang, T, p1, p2);

      // если T==0 — только стартовые кнопки (без оплаты)
      const buttons: any[] = [[Markup.button.callback(lang === "ru" ? t.ru.lang_btn : t.uz.lang_btn, "choose_lang")]];
      if (T > 0) {
        buttons.unshift([Markup.button.callback(lang === "ru" ? t.ru.plan1_btn : t.uz.plan1_btn, "pay_plan1")]);
        if (p2.allowed) buttons.unshift([Markup.button.callback(lang === "ru" ? t.ru.plan2_btn : t.uz.plan2_btn, "pay_plan2")]);
      }

      return ctx.reply(header + body, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      });
    }

    if (S.step === "await_ezpass_account") {
      const cleaned = msg.replace(/[^\d]/g, "");
      if (!/^\d{6,12}$/.test(cleaned)) {
        return ctx.reply(lang === "ru" ? t.ru.ezpass_acc_invalid : t.uz.ezpass_acc_invalid, { parse_mode: "Markdown" });
      }
      S.ezpassAccount = cleaned;
      S.step = "idle";

      // ПЕРЕД созданием чекаута — пробуем вставить creating, а если уже есть, то вернём существующую
      const { created, row } = await insertCreatingOrGetExisting({
        chatId: ctx.chat!.id,
        plan: "plan2_discount",
        plate: S.plate || "",
        invoice: S.invoice || "",
        ezpassAccount: S.ezpassAccount,
        totalUsd: S.lastTotal || 0,
      });

      if (!created) {
        if (row.status !== "completed" && row.pay_url) {
          const txt =
            (lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title) +
            `\n\nPlate: *${row.plate}*  |  Invoice: *${row.invoice}*\nPlan: *2 (со скидкой)*  |  Сумма: *$${Number(row.total_usd || 0).toFixed(2)}*\n\n` +
            (lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
          return ctx.reply(txt, {
            parse_mode: "Markdown",
            reply_markup: Markup.inlineKeyboard([[Markup.button.url("Оплатить (Stripe)", row.pay_url)]]).reply_markup,
          });
        }
        if (row.status === "completed") {
          const txt =
            (lang === "ru" ? t.ru.dup_done_title : t.uz.dup_done_title) +
            `\n\nPlate: *${row.plate}*  |  Invoice: *${row.invoice}*\nPlan: *2 (со скидкой)*\n\n` +
            (lang === "ru" ? t.ru.dup_done_hint : t.uz.dup_done_hint);
          return ctx.reply(txt, { parse_mode: "Markdown" });
        }
        // creating — мягкое уведомление
        const txt =
          (lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title) +
          `\n\n` +
          (lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
        return ctx.reply(txt, { parse_mode: "Markdown" });
      }

      // создаём checkout
      const T = +(S.lastTotal || 0).toFixed(2);
      const p2 = calcPlan2(T, 15);

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
          plate: S.plate || "",
          invoice: S.invoice || "",
          ezpassState: "New Jersey",
          ezpassAccount: S.ezpassAccount || "",
          // важно: в metadata внутри payments добавь проброс reqId (row.id)
          // либо используй session.id в вебхуке — мы уже поддерживаем оба пути
          // здесь ничего дополнительно передавать не нужно
        },
        { idempotencyKey: `G:${ctx.chat!.id}:p2:${(S.plate || "").toUpperCase()}:${(S.invoice || "").toUpperCase()}` }
      );

      await setPending(row.id, id, url, p2.total);

      return ctx.reply(`Откройте Stripe и завершите оплату на *$${p2.total.toFixed(2)}*`, {
        parse_mode: "Markdown",
        reply_markup: Markup.inlineKeyboard([[Markup.button.url("Оплатить (Stripe)", url)]]).reply_markup,
      });
    }

    return ctx.reply(S.lang === "ru" ? t.ru.start_hint : t.uz.start_hint, kbStart(S.lang));
  });

  // план 2: запрос аккаунта
  bot.action("pay_plan2", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const T = +(S.lastTotal || 0).toFixed(2);
    const p2 = calcPlan2(T, 15);
    if (!p2.allowed) {
      return ctx.reply(S.lang === "ru" ? "Минимальная сумма для второго варианта — $70." : "Ikkinchi variant uchun minimal summa — $70.");
    }

    // перед запросом аккаунта — сразу проверим, нет ли активной записи
    const ex = await findActive(String(ctx.chat!.id), "plan2_discount", S.plate || "", S.invoice || "");
    if (ex) {
      if (ex.status !== "completed" && ex.pay_url) {
        const txt =
          (S.lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title) +
          `\n\nPlate: *${ex.plate}*  |  Invoice: *${ex.invoice}*\nPlan: *2 (со скидкой)*  |  Сумма: *$${Number(ex.total_usd || 0).toFixed(2)}*\n\n` +
          (S.lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
        return ctx.reply(txt, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([[Markup.button.url("Оплатить (Stripe)", ex.pay_url)]]).reply_markup,
        });
      }
      const txt =
        (S.lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title) +
        `\n\n` +
        (S.lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
      return ctx.reply(txt, { parse_mode: "Markdown" });
    }

    S.step = "await_ezpass_account";
    S.ezpassAccount = undefined;
    await ctx.reply(S.lang === "ru" ? t.ru.ask_ezpass_acc : t.uz.ask_ezpass_acc, { parse_mode: "Markdown" });
  });

  // план 1: прямая
  bot.action("pay_plan1", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const S = ses(ctx.chat!.id);
    const T = +(S.lastTotal || 0).toFixed(2);
    if (T <= 0) {
      return ctx.reply(S.lang === "ru" ? "По базе нет начислений." : "Bazaga ko‘ra to‘lov yo‘q.");
    }

    // дубликаты?
    const { created, row } = await insertCreatingOrGetExisting({
      chatId: ctx.chat!.id,
      plan: "plan1_direct",
      plate: S.plate || "",
      invoice: S.invoice || "",
      totalUsd: T,
    });

    if (!created) {
      if (row.status !== "completed" && row.pay_url) {
        const txt =
          (S.lang === "ru" ? t.ru.dup_pending_title : t.uz.dup_pending_title) +
          `\n\nPlate: *${row.plate}*  |  Invoice: *${row.invoice}*\nPlan: *1 (прямая)*  |  Сумма: *$${Number(row.total_usd || 0).toFixed(2)}*\n\n` +
          (S.lang === "ru" ? t.ru.dup_pending_hint : t.uz.dup_pending_hint);
        return ctx.reply(txt, {
          parse_mode: "Markdown",
          reply_markup: Markup.inlineKeyboard([[Markup.button.url("Оплатить (Stripe)", row.pay_url)]]).reply_markup,
        });
      }
      if (row.status === "completed") {
        const txt =
          (S.lang === "ru" ? t.ru.dup_done_title : t.uz.dup_done_title) +
          `\n\nPlate: *${row.plate}*  |  Invoice: *${row.invoice}*\nPlan: *1 (прямая)*\n\n` +
          (S.lang === "ru" ? t.ru.dup_done_hint : t.uz.dup_done_hint);
        return ctx.reply(txt, { parse_mode: "Markdown" });
      }
      const txt =
        (S.lang === "ru" ? t.ru.dup_creating_title : t.uz.dup_creating_title) +
        `\n\n` +
        (S.lang === "ru" ? t.ru.dup_creating_hint : t.uz.dup_creating_hint);
      return ctx.reply(txt, { parse_mode: "Markdown" });
    }

    // создаём checkout
    const p1 = calcPlan1(T);
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
        plate: S.plate || "",
        invoice: S.invoice || "",
        ezpassState: "New Jersey",
        ezpassAccount: "",
      },
      { idempotencyKey: `G:${ctx.chat!.id}:p1:${(S.plate || "").toUpperCase()}:${(S.invoice || "").toUpperCase()}` }
    );

    await setPending(row.id, id, url, p1.total);

    await ctx.reply(`Откройте Stripe и завершите оплату на *$${p1.total.toFixed(2)}*`, {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([[Markup.button.url("Оплатить (Stripe)", url)]]).reply_markup,
    });
  });

  return bot;
}

// Инициализация схемы БД при импортe бота
ensureSchema().catch((e) => {
  console.error("DB init error:", e);
});
