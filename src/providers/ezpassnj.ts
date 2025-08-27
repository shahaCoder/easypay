import { chromium, Browser, Page, Locator, ElementHandle } from "playwright";

export type NjItem = { noticeNumber?: string; amountDue: number; dueDate?: string; status?: string };
export type NjCheckResult = { items: NjItem[]; total: number; screenshots?: string[]; debug?: string[] };

const HOME = "https://www.ezpassnj.com/en/home/index.shtml";

export async function checkEzpassNJ(opts: { invoiceNumber: string; plate: string }): Promise<NjCheckResult> {
  let browser: Browser | null = null;

  const headful = !!process.env.DEBUG_PLAYWRIGHT;
  const slowMo = headful ? 150 : 0;

  try {
    browser = await chromium.launch({ headless: !headful, slowMo });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    const page = await context.newPage();
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });

    // открыть панель ввода
    const tileBtn = page.locator('button, a').filter({
      hasText: /Click Here To Pay Invoice.*Violation.*Toll Bill/i,
    }).first();
    await tileBtn.click({ force: true });

    // контейнер: системная модалка или встроенная панель
    const sysModal = page.locator('div[role="dialog"], .ui-dialog, .modal, .mfp-content').first();
    const inlinePanel = page.locator(
      'xpath=//*[contains(normalize-space(.),"To access your Invoice/Violation/Toll Bill")]/ancestor-or-self::div[.//input][1]'
    ).first();

    let container: Locator | null = null;
    for (let i = 0; i < 24; i++) {
      if (await sysModal.isVisible().catch(() => false)) { container = sysModal; break; }
      if (await inlinePanel.isVisible().catch(() => false)) { container = inlinePanel; break; }
      await page.waitForTimeout(250);
    }
    if (!container) throw new Error("Input panel not found");

    // radio (если есть)
    const radio = container.locator('input[type="radio"]').first();
    if (await radio.isVisible().catch(() => false)) await radio.check().catch(() => {});

    // найти 2 РАЗНЫХ инпута
    const invInput = await findInvoiceInput(container);
    if (!invInput) throw new Error("Invoice input not found");
    const plateInput = await findPlateInput(container, invInput);
    if (!plateInput) throw new Error("Plate input not found");

    // заполнить
    await forceFill(invInput, opts.invoiceNumber, page);
    await forceFill(plateInput, opts.plate, page);

    // клик по сабмиту (<input type="submit"> ИЛИ button/a)
    const viewBtn = container.locator([
      'input[type="submit"][name="btnLookupViolation"]',
      'input[type="submit"][value*="View" i]',
      'button:has-text("View Invoice")',
      'button:has-text("View Violation")',
      'button:has-text("View Toll Bill")',
      'a:has-text("View Invoice")',
      'a:has-text("View Violation")',
      'a:has-text("View Toll Bill")',
    ].join(',')).first();
    await viewBtn.click({ force: true });

    // ждём: popup / навигация / ajax-таблица
    const popupPromise  = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
    const navPromise    = page.waitForURL(/\/vector\/.*\.do/i, { timeout: 15000 }).catch(() => null);
    const tablePromise  = page.locator('table:has-text("Violation No"), table:has-text("Amt Due")').first()
                              .waitFor({ state: "visible", timeout: 15000 }).then(()=>"table").catch(()=>null);

    const winner: any = await Promise.race([popupPromise, navPromise, tablePromise]);

    let resultsPage: Page = page;
    if (winner && typeof winner.url === "function") {
      resultsPage = winner as Page; // popup
      await resultsPage.waitForLoadState("domcontentloaded").catch(() => {});
    }

    return await parseResults(resultsPage);
  } finally {
    await browser?.close();
  }
}

/* ---------- helpers ---------- */

async function findInvoiceInput(scope: Locator): Promise<Locator | null> {
  const byAttrs = scope.locator([
    'input[placeholder*="Invoice" i]','input[placeholder*="Violation" i]','input[placeholder*="Toll Bill" i]',
    'input[aria-label*="Invoice" i]','input[aria-label*="Violation" i]','input[aria-label*="Toll Bill" i]',
    'input[name*="invoice" i]','input[id*="invoice" i]',
  ].join(",")).first();
  if (await byAttrs.isVisible().catch(()=>false)) return byAttrs;

  const byLabel = scope.getByLabel(/Invoice|Violation|Toll Bill Number/i, { exact: false });
  if (await byLabel.isVisible().catch(()=>false)) return byLabel;

  return await nthVisibleInput(scope, 0);
}

async function findPlateInput(scope: Locator, invInput: Locator): Promise<Locator | null> {
  const byAttrs = scope.locator([
    'input[placeholder*="Plate" i]','input[placeholder*="License" i]',
    'input[aria-label*="Plate" i]','input[aria-label*="License" i]',
    'input[name*="plate" i]','input[id*="plate" i]',
  ].join(",")).first();
  if (await isVisibleAndDifferent(byAttrs, invInput)) return byAttrs;

  const xp = scope.locator(
    'xpath=.//label[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"LICENSE PLATE")]/following::input[1] | .//*[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"LICENSE PLATE")]/following::input[1]'
  ).first();
  if (await isVisibleAndDifferent(xp, invInput)) return xp;

  const byLabel = scope.getByLabel(/License Plate Number/i, { exact: false });
  if (await isVisibleAndDifferent(byLabel, invInput)) return byLabel;

  const second = await nthVisibleInput(scope, 1);
  if (second && !(await sameElement(invInput, second))) return second;

  return null;
}

async function nthVisibleInput(scope: Locator, n: number): Promise<Locator | null> {
  const inputs = scope.locator('input[type="text"], input:not([type])').filter({ hasNot: scope.locator('[type="hidden"]') });
  const cnt = await inputs.count().catch(()=>0);
  const visible: Locator[] = [];
  for (let i=0;i<cnt;i++) {
    const el = inputs.nth(i);
    if (await el.isVisible().catch(()=>false)) visible.push(el);
  }
  return visible[n] ?? null;
}
async function sameElement(a: Locator, b: Locator): Promise<boolean> {
  try {
    const ha = await a.elementHandle(); const hb = await b.elementHandle();
    if (!ha || !hb) return false;
    return await ha.evaluate((el, other) => el === other, hb as unknown as ElementHandle);
  } catch { return false; }
}
async function isVisibleAndDifferent(a: Locator, b: Locator): Promise<boolean> {
  if (!(await a.isVisible().catch(()=>false))) return false;
  return !(await sameElement(a,b));
}
async function forceFill(input: Locator, value: string, page: Page) {
  try { await input.click({ force: true }); } catch {}
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try { await page.keyboard.down(mod); await page.keyboard.press("KeyA"); await page.keyboard.up(mod); } catch {}
  try { await page.keyboard.press("Backspace"); } catch {}
  try { await input.type(value, { delay: 20 }); } catch { await input.fill(value).catch(()=>{}); }
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
      const heads = Array.from(tbl.querySelectorAll("thead th, tr th")).map(h =>
        (h.textContent || "").trim().toLowerCase()
      );
      const idxAmt = heads.findIndex(h => /amt\s*due|amount\s*due|due\s*amount/.test(h));
      const idxNo  = heads.findIndex(h => /violation|notice|invoice/.test(h));
      const idxDt  = heads.findIndex(h => /due\s*date|pay\s*by/.test(h));
      const idxSt  = heads.findIndex(h => /status/.test(h));

      const rows = (tbl.querySelector("tbody")
        ? Array.from(tbl.querySelectorAll("tbody tr"))
        : Array.from(tbl.querySelectorAll("tr")).slice(heads.length ? 1 : 0));

      const local: any[] = [];
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (!tds.length) continue;

        const status = idxSt >= 0 && tds[idxSt] ? (tds[idxSt].textContent || "").trim() : "";
        if (status && !/open/i.test(status)) continue;

        let amt: number | null = null;
        if (idxAmt >= 0 && tds[idxAmt]) amt = moneyToNum(tds[idxAmt].textContent || "");
        if (amt == null) {
          for (let i = tds.length - 1; i >= 0; i--) {
            const n = moneyToNum(tds[i].textContent || "");
            if (n != null) { amt = n; break; }
          }
        }
        if (amt == null) continue;

        const notice = idxNo >= 0 && tds[idxNo] ? (tds[idxNo].textContent || "").trim() : "";
        const date   = idxDt >= 0 && tds[idxDt] ? (tds[idxDt].textContent || "").trim() : "";

        local.push({
          noticeNumber: (notice.match(/([A-Z0-9-]{5,})/) || [])[1] || undefined,
          amountDue: amt,
          dueDate: date || undefined,
          status: status || undefined,
        });
      }
      if (local.length) { items = local; break; }
    }
    const total = items.reduce((s, x) => s + (x.amountDue || 0), 0);
    return { items, total };
  });

  if ((!dom.items?.length || !dom.total)) {
    const html = await page.content();
    const amounts = [...html.matchAll(/\$[ \t]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2}))/g)]
      .map(m => Number(m[1].replace(/,/g, "")));
    const total = amounts.reduce((s, v) => s + v, 0);
    return { items: [], total };
  }
  return { items: dom.items as NjItem[], total: dom.total || 0 };
}