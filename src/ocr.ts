
import Tesseract from "tesseract.js";

export type OCRFields = {
  invoiceNumber?: string;
  licensePlate?: string;
  amount?: number;
  state?: string;
};

const INVOICE_KEYS = ["violation","invoice","notice","citation","ref","reference","ticket","number","no","id","case"];
const PLATE_KEYS   = ["license plate","plate","tag","lp","veh plate","vehicle plate"];
const AMOUNT_HINTS = ["balance due","amount due","total due","payment due","amount","total","pay this amount"];

// helpers
function fixDigits(s: string) {
  return s
    .replace(/\u00A0/g, " ")
    .replace(/O/g, "0")
    .replace(/[Il]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2");
}
function likeInvoice(tok: string) {
  const t = tok.replace(/[^A-Za-z0-9-]/g,"");
  return /^[A-Z0-9-]{6,20}$/.test(t) && /[A-Z]/.test(t) && /\d/.test(t);
}
function likePlate(tok: string) {
  const t = tok.replace(/[^A-Z0-9]/g,"");
  return /^[A-Z0-9]{2,8}$/.test(t);
}
function normalizeLine(s: string) {
  return s
    .replace(/\$\s*([0-9]{1,4})\s*\.\s*([0-9]{2})/g, "$1.$2")
    .replace(/\$\s*([0-9]{1,4})\s+([0-9]{2})\b/g, "$1.$2")
    .replace(/\b([0-9]{1,4})\s*\.\s*([0-9]{2})\b/g, "$1.$2")
    .replace(/\b([0-9]{1,4})\s+([0-9]{2})\b/g, "$1.$2");
}
function findAll(re: RegExp, s: string) {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(s)) !== null) out.push(m);
  return out;
}

// amount
function extractAmount(lines: string[]): number | undefined {
  const hasYear = (s: string) => /\b(19|20)\d{2}\b/.test(s);
  const moneyRe = /\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:\.[0-9]{2})|[0-9]{1,4}\.[0-9]{2})/;

  // 1) приоритетные строки (BALANCE/AMOUNT/TOTAL/PAYMENT DUE)
  for (let i = 0; i < lines.length; i++) {
    const L = normalizeLine(lines[i]);
    const lower = L.toLowerCase();
    if (AMOUNT_HINTS.some(h => lower.includes(h))) {
      const m1 = L.match(moneyRe);
      if (m1 && !hasYear(L)) return Number(m1[1].replace(/,/g, ""));
      const next = lines[i + 1] ? normalizeLine(lines[i + 1]) : "";
      const m2 = next.match(moneyRe);
      if (m2 && !hasYear(next)) return Number(m2[1].replace(/,/g, ""));
    }
  }

  // 2) строки с $
  for (const raw of lines) {
    const L = normalizeLine(raw);
    if (!L.includes("$")) continue;
    if (hasYear(L)) continue;
    const m = L.match(moneyRe);
    if (m) return Number(m[1].replace(/,/g, ""));
  }

  // 3) десятичные в любом месте (игнорим года)
  const decRe = /\b([0-9]{1,4}\.[0-9]{2})\b/;
  for (const raw of lines) {
    const L = normalizeLine(raw);
    if (hasYear(L)) continue;
    const m = L.match(decRe);
    if (m) return Number(m[1]);
  }

  return undefined;
}

function extractInvoice(lines: string[], text: string) {
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].toLowerCase();
    if (INVOICE_KEYS.some(k => L.includes(k))) {
      const win = [
        ...(lines[i - 1]?.split(/\s+/) || []),
        ...(lines[i]?.split(/\s+/) || []),
        ...(lines[i + 1]?.split(/\s+/) || []),
      ];
      const c = win
        .map(t => fixDigits(t.toUpperCase()))
        .map(t => t.replace(/[^A-Z0-9-]/g, ""))
        .filter(likeInvoice)
        .sort((a, b) => b.length - a.length);
      if (c[0]) return c[0];
    }
  }
  const tokens = text.split(/[\s,;:]+/).map(t => fixDigits(t.toUpperCase()));
  const any = tokens.filter(likeInvoice).sort((a, b) => b.length - a.length)[0];
  return any || undefined;
}

function extractPlate(lines: string[], text: string) {
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].toLowerCase();
    if (PLATE_KEYS.some(k => L.includes(k))) {
      const win = [
        ...(lines[i - 1]?.split(/\s+/) || []),
        ...(lines[i]?.split(/\s+/) || []),
        ...(lines[i + 1]?.split(/\s+/) || []),
      ];
      const c = win
        .map(t => fixDigits(t.toUpperCase()))
        .map(t => t.replace(/[^A-Z0-9]/g, ""))
        .filter(likePlate)
        .sort((a, b) => b.length - a.length);
      if (c[0]) return c[0];
    }
  }
  const all = text
    .split(/[\s,;:]+/)
    .map(t => fixDigits(t.toUpperCase()))
    .map(t => t.replace(/[^A-Z0-9]/g, ""));
  const any = all.filter(likePlate).sort((a, b) => b.length - a.length)[0];
  return any || undefined;
}

export async function runTesseractOCR(imagePath: string): Promise<{ fields: OCRFields; rawText: string }> {
  const { data } = await Tesseract.recognize(
    imagePath,
    "eng",
    {
      // @ts-ignore — передаём параметры одной строкой
      config:
        "tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.$:/- " +
        "--psm 6"
    }
  );

  const raw = (data.text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const fields: OCRFields = {};
  fields.amount        = extractAmount(lines);
  fields.invoiceNumber = extractInvoice(lines, raw);
  fields.licensePlate  = extractPlate(lines, raw);

  return { fields, rawText: raw };
}
