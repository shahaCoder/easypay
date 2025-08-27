import fs from "fs/promises";
import OpenAI from "openai";

export type Extracted = {
  invoiceNumber?: string;
  licensePlate?: string;
  state?: string;
  amountDue?: number;   // число в долларах, всегда с двумя знаками
  hints?: { amountSource?: string; confidence?: number };
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function aiExtractFromImage(imagePath: string): Promise<Extracted | null> {
  const b64 = await fs.readFile(imagePath, { encoding: "base64" });

  const prompt =
`You extract fields from US toll violations and E-ZPass invoices.
Return a strict JSON with keys:
- invoiceNumber: string
- licensePlate: string
- state: 2-letter US state (if visible)
- amountDue: number (USD) — choose the final amount the customer must pay TODAY;
  prefer "BALANCE DUE", "AMOUNT DUE", "TOTAL DUE", "PAYMENT DUE".
- hints: { amountSource: string, confidence: 0..1 }

Rules:
- If a dot is visually present or amount looks like "4.00", keep two decimals.
- If OCR looks like "400" but all monetary context around shows cents/decimal prices, interpret as 4.00 (divide by 100).
- Never return currency symbols, only the number.
- If a field is not visible, omit it.`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a precise data extractor for toll invoices." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
        ]
      }
    ],
    temperature: 0.0
  });

  const content = resp.choices[0]?.message?.content;
  if (!content) return null;

  try {
    const j = JSON.parse(content) as Extracted;

    // Санити для суммы: 400 -> 4.00, если очень похоже на потерянную точку
    if (typeof j.amountDue === "number") {
      const n = j.amountDue;
      if (!Number.isNaN(n) && n >= 100 && n <= 9999 && Number.isInteger(n)) {
        j.amountDue = n / 100;
      }
      // округляем до 2 знаков (на всякий)
      j.amountDue = Number(j.amountDue.toFixed(2));
    }
    return j;
  } catch {
    return null;
  }
}
