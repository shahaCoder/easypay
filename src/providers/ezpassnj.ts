// src/providers/ezpassnj.ts
import { chromium, Browser, Page, Locator, ElementHandle, BrowserContext } from "playwright";
import fs from "fs/promises";
import path from "path";

export type NjItem = { noticeNumber?: string; amountDue: number; dueDate?: string; status?: string };
export type NjCheckResult = { items: NjItem[]; total: number; screenshots?: string[]; debug?: string[] };

const HOME = "https://www.ezpassnj.com/en/home/index.shtml";

type Opts = { invoiceNumber: string; plate: string };

const HEADFUL = !!process.env.DEBUG_PLAYWRIGHT;
const SLOWMO = HEADFUL ? 150 : 0;
const CAPTURE = !!process.env.PLAYWRIGHT_CAPTURE; // включи, чтобы сохранять скриншоты/HTML

export async function checkEzpassNJ(opts: Opts): Promise<NjCheckResult> {
  let browser: Browser | null = null;
  const debug: string[] = [];
  const screenshots: string[] = [];

  const capture = async (page: Page, name: string) => {
    if (!CAPTURE) return;
    try {
      const dir = "/tmp/ezpass-bot";
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      screenshots.push(file);
    } catch (e) {
      debug.push(`capture(${name}) failed: ${(e as any)?.message}`);
    }
  };

  try {
    browser = await chromium.launch({ headless: !HEADFUL, slowMo: SLOWMO });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    // ускоряем: блокируем лишнее
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });

    context.setDefaultTimeout(20000);
    const page = await context.newPage();

    debug.push("goto HOME");
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await capture(page, "home");

    // Клик по тайлу «Pay Invoice/Violation/Toll Bill»
    const tileBtn = page
      .locator('button, a')
      .filter({ hasText: /Pay Invoice|View Invoice|Violation|Toll Bill/i })
      .first();
    await safeClick(tileBtn, debug, "tileBtn");

    // Находим контейнер ввода (модалка или инлайн)
    const sysModal = page.locator('div[role="dialog"], .ui-dialog, .modal, .mfp-content').first();
    const inlinePanel = page
      .locator('xpath=//*[contains(normalize-space(.),"Invoice/Violation/Toll Bill")]/ancestor-or-self::div[.//input][1]')
      .first();

    const container = await waitFirstVisible([sysModal, inlinePanel], 6000);
    if (!container) throw new Error("Input panel not found");
    await capture(page, "panel");

    // иногда просят принять cookies/условия
    await clickIfVisible(
      page.locator('button:has-text("Accept"), button:has-text("Continue"), a:has-text("Continue")'),
      debug,
      "consent"
    );

    // радиокнопка (если есть)
    const radio = container.locator('input[type="radio"]').first();
    if (await radio.isVisible().catch(() => false)) await radio.check().catch(() => {});

    // Ищем 2 разных инпута
    const invInput = await findInvoiceInput(container);
    if (!invInput) throw new Error("Invoice input not found");
    const plateInput = await findPlateInput(container, invInput);
    if (!plateInput) throw new Error("Plate input not found");

    // Заполняем
    await forceFill(invInput, opts.invoiceNumber, page);
    await forceFill(plateInput, opts.plate, page);

    // Сабмит
    const viewBtn = container
      .locator(
        [
          'input[type="submit"][name="btnLookupViolation"]',
          'input[type="submit"][value*="View" i]',
          'button:has-text("View Invoice")',
          'button:has-text("View Violation")',
          'button:has-text("View Toll Bill")',
          'a:has-text("View Invoice")',
          'a:has-text("View Violation")',
          'a:has-text("View Toll Bill")',
          'button:has-text("Submit")',
        ].join(",")
      )
      .first();
    await safeClick(viewBtn, debug, "viewBtn");

    // Ждём один из исходов
    const popupPromise = page.waitForEvent("popup", { timeout: 12000 }).catch(() => null);
    const navPromise = page.waitForURL(/\/vector\/.*\.do/i, { timeout: 15000 }).catch(() => null);
    const tablePromise = page
      .locator('table:has-text("Violation No"), table:has-text("Amt Due"), table:has-text("Amount Due")')
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
      .then(() => "table")
      .catch(() => null);

    const winner: any = await Promise.race([popupPromise, navPromise, tablePromise]);

    let resultsPage: Page = page;
    if (winner && typeof winner.url === "function") {
      resultsPage = winner as Page; // popup
      await resultsPage.waitForLoadState("domcontentloaded").catch(() => {});
    } else {
      // если было навигирование в том же окне — просто дожидаемся таблицы/контента
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    await capture(resultsPage, "results");

    // Иногда показывают явный «No records found»
    const noRec = await resultsPage
      .locator(':text("No records") , :text("No record") , :text("not found")')
      .first()
      .isVisible()
      .catch(() => false);
    if (noRec) {
      debug.push("no records banner");
      return { items: [], total: 0, screenshots, debug };
    }

    const parsed = await parseResults(resultsPage);
    return { ...parsed, screenshots: screenshots.length ? screenshots : undefined, debug: debug.length ? debug : undefined };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/* ---------- helpers ---------- */

async function safeClick(loc: Locator, debug: string[], name: string) {
  try {
    await loc.waitFor({ state: "visible", timeout: 8000 });
    await loc.click({ force: true });
  } catch (e: any) {
    debug.push(`click(${name}) failed: ${e?.message || e}`);
    // пробуем ещё раз скроллом/фокусом
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true });
    } catch (e2: any) {
      debug.push(`click(${name}) retry failed: ${e2?.message || e2}`);
      throw e2;
    }
  }
}

async function waitFirstVisible(candidates: Locator[], timeoutMs = 5000): Promise<Locator | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const c of candidates) {
      if (await c.isVisible().catch(() => false)) return c;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function findInvoiceInput(scope: Locator): Promise<Locator | null> {
  const byAttrs = scope
    .locator(
      [
        'input[placeholder*="Invoice" i]',
        'input[placeholder*="Violation" i]',
        'input[placeholder*="Toll Bill" i]',
        'input[aria-label*="Invoice" i]',
        'input[aria-label*="Violation" i]',
        'input[aria-label*="Toll Bill" i]',
        'input[name*="invoice" i]',
        'input[id*="invoice" i]',
      ].join(",")
    )
    .first();
  if (await byAttrs.isVisible().catch(() => false)) return byAttrs;

  const byLabel = scope.getByLabel(/Invoice|Violation|Toll Bill Number/i, { exact: false });
  if (await byLabel.isVisible().catch(() => false)) return byLabel;

  return await nthVisibleInput(scope, 0);
}

async function findPlateInput(scope: Locator, invInput: Locator): Promise<Locator | null> {
  const byAttrs = scope
    .locator(
      [
        'input[placeholder*="Plate" i]',
        'input[placeholder*="License" i]',
        'input[aria-label*="Plate" i]',
        'input[aria-label*="License" i]',
        'input[name*="plate" i]',
        'input[id*="plate" i]',
      ].join(",")
    )
    .first();
  if (await isVisibleAndDifferent(byAttrs, invInput)) return byAttrs;

  const xp = scope
    .locator(
      'xpath=.//label[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"LICENSE PLATE")]/following::input[1] | .//*[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"LICENSE PLATE")]/following::input[1]'
    )
    .first();
  if (await isVisibleAndDifferent(xp, invInput)) return xp;

  const byLabel = scope.getByLabel(/License Plate Number|Plate/i, { exact: false });
  if (await isVisibleAndDifferent(byLabel, invInput)) return byLabel;

  const second = await nthVisibleInput(scope, 1);
  if (second && !(await sameElement(invInput, second))) return second;

  return null;
}

async function nthVisibleInput(scope: Locator, n: number): Promise<Locator | null> {
  const inputs = scope.locator('input[type="text"], input:not([type])').filter({ hasNot: scope.locator('[type="hidden"]') });
  const cnt = await inputs.count().catch(() => 0);
  const visible: Locator[] = [];
  for (let i = 0; i < cnt; i++) {
    const el = inputs.nth(i);
    if (await el.isVisible().catch(() => false)) visible.push(el);
  }
  return visible[n] ?? null;
}

async function sameElement(a: Locator, b: Locator): Promise<boolean> {
  try {
    const ha = await a.elementHandle();
    const hb = await b.elementHandle();
    if (!ha || !hb) return false;
    return await ha.evaluate((el, other) => el === (other as any), hb as unknown as ElementHandle);
  } catch {
    return false;
  }
}

async function isVisibleAndDifferent(a: Locator, b: Locator): Promise<boolean> {
  if (!(await a.isVisible().catch(() => false))) return false;
  return !(await sameElement(a, b));
}

async function forceFill(input: Locator, value: string, page: Page) {
  try {
    await input.click({ force: true });
  } catch {}
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    await page.keyboard.down(mod);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(mod);
  } catch {}
  try {
    await page.keyboard.press("Backspace");
  } catch {}
  try {
    await input.type(value, { delay: 15 });
  } catch {
    await input.fill(value).catch(() => {});
  }
}

async function parseResults(page: Page): Promise<NjCheckResult> {
  const dom = await page.evaluate(() => {
    function moneyToNum(s: string): number | null {
      const m = s.replace(/\u00a0/g, " ").match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2}))/);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    }
    const tables = Array.from(document.querySelectorAll("table"));
    let items: any[] = [];

    for (const tbl of tables) {
      const heads = Array.from(tbl.querySelectorAll("thead th, tr th")).map((h) =>
        (h.textContent || "").trim().toLowerCase()
      );

      const idxAmt = heads.findIndex((h) => /amt\s*due|amount\s*due|due\s*amount/.test(h));
      const idxNo = heads.findIndex((h) => /violation|notice|invoice/.test(h));
      const idxDt = heads.findIndex((h) => /due\s*date|pay\s*by/.test(h));
      const idxSt = heads.findIndex((h) => /status/.test(h));

      const rows = tbl.querySelector("tbody")
        ? Array.from(tbl.querySelectorAll("tbody tr"))
        : Array.from(tbl.querySelectorAll("tr")).slice(heads.length ? 1 : 0);

      const local: any[] = [];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) continue;

        const status = idxSt >= 0 && tds[idxSt] ? (tds[idxSt].textContent || "").trim() : "";
        if (status && !/open|due|unpaid/i.test(status)) continue;

        let amt: number | null = null;
        if (idxAmt >= 0 && tds[idxAmt]) amt = moneyToNum(tds[idxAmt].textContent || "");
        if (amt == null) {
          for (let i = tds.length - 1; i >= 0; i--) {
            const n = moneyToNum(tds[i].textContent || "");
            if (n != null) {
              amt = n;
              break;
            }
          }
        }
        if (amt == null) continue;

        const notice = idxNo >= 0 && tds[idxNo] ? (tds[idxNo].textContent || "").trim() : "";
        const date = idxDt >= 0 && tds[idxDt] ? (tds[idxDt].textContent || "").trim() : "";

        local.push({
          noticeNumber: (notice.match(/([A-Z0-9-]{5,})/) || [])[1] || undefined,
          amountDue: amt,
          dueDate: date || undefined,
          status: status || undefined,
        });
      }
      if (local.length) {
        items = local;
        break;
      }
    }
    const total = items.reduce((s, x) => s + (x.amountDue || 0), 0);
    return { items, total };
  });

  if (!dom.items?.length) {
    // Фоллбек: ищем суммы в HTML и считаем total
    const html = await page.content();
    const amounts = [...html.matchAll(/\$[ \t]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2}))/g)].map((m) =>
      Number(m[1].replace(/,/g, ""))
    );
    const total = amounts.reduce((s, v) => s + v, 0);
    return { items: [], total: total || 0 };
  }
  return { items: dom.items as NjItem[], total: dom.total || 0 };
}

async function clickIfVisible(loc: Locator, debug: string[], name: string) {
  try {
    if (await loc.first().isVisible().catch(() => false)) {
      await loc.first().click({ force: true });
      debug.push(`clicked ${name}`);
    }
  } catch (e: any) {
    debug.push(`${name} click failed: ${e?.message || e}`);
  }
}