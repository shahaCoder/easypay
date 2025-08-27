// src/payments.ts
import Stripe from "stripe";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is required");

export const stripe = new Stripe(STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

/* ================== fees & plans ================== */
// «Прочие расходы» (other fees): 2.5% + $0.50 от суммы списания
function otherFees(amountUsd: number): number {
  const v = amountUsd * 0.025 + 0.5;
  return Math.round(v * 100) / 100;
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

// План 1: прямой платёж (service = $10)
export function calcPlan1(T: number) {
  const service = 10;
  const subtotal = T + service;
  const fees = otherFees(subtotal);
  const total = round2(subtotal + fees);
  return { service, fees, total };
}

// План 2: скидка 10% (service = $15, но не допускаем «минус» для клиента)
export function calcPlan2(T: number, baseService = 15) {
  const allowed = T >= 70;
  const discounted = round2(T * 0.9); // минимальная скидка 10%
  let service = baseService;

  // подберём service так, чтобы total <= T (если иначе клиент «уходит в минус»)
  const totalWith = (svc: number) => {
    const subtotal = discounted + svc;
    const fees = otherFees(subtotal);
    return { fees, total: round2(subtotal + fees) };
  };

  let { fees, total } = totalWith(service);
  let serviceReduced = false;

  if (total > T) {
    // уменьшаем service до тех пор, пока total <= T (шаг 0.01)
    serviceReduced = true;
    let svc = service;
    for (let i = 0; i < 2000 && svc > 0; i++) {
      svc = round2(svc - 0.01);
      const r = totalWith(svc);
      if (r.total <= T) {
        service = svc;
        fees = r.fees;
        total = r.total;
        break;
      }
      // если не нашли — в конце примем нулевой сервис
      if (i === 1999) {
        service = 0;
        const r2 = totalWith(service);
        fees = r2.fees;
        total = r2.total;
      }
    }
  }

  return { allowed, discounted, service, serviceReduced, fees, total };
}

/* ================== checkout ================== */
export type CreateCheckoutArgs = {
  totalUsd: number;
  planLabel: "plan1_direct" | "plan2_discount";
  tollUsd: number;
  serviceUsd: number;
  feesUsd: number;
  chatId: number | string;
  username?: string;
  firstName?: string;
  plate: string;
  invoice: string;
  ezpassState?: string;
  ezpassAccount?: string;
  /** id записи в БД для связывания в webhook */
  reqId?: string;
  reqKey?: string;
};

export type CreateCheckoutOpts = {
  idempotencyKey?: string;
};

export async function createTotalCheckout(
  args: CreateCheckoutArgs,
  opts?: CreateCheckoutOpts
): Promise<{ id: string; url: string }> {
  const amount = Math.round(args.totalUsd * 100);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      success_url: `${BASE_URL}/stripe/success?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/stripe/cancel`,
      phone_number_collection: { enabled: true },
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name:
                args.planLabel === "plan1_direct"
                  ? "Easy Pay — Прямая оплата"
                  : "Easy Pay — Со скидкой (мин. 10%)",
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        // обязательно строки
        planLabel: args.planLabel,
        totalUsd: String(args.totalUsd),
        tollUsd: String(args.tollUsd),
        serviceUsd: String(args.serviceUsd),
        feesUsd: String(args.feesUsd),

        chatId: String(args.chatId),
        username: args.username || "",
        firstName: args.firstName || "",

        plate: args.plate || "",
        invoice: args.invoice || "",
        ezpassState: args.ezpassState || "",
        ezpassAccount: args.ezpassAccount || "",

        // новый ключ для server.ts
        reqKey: args.reqKey || "",
      },
    },
    { idempotencyKey: opts?.idempotencyKey }
  );

  if (!session.url) throw new Error("Stripe session.url is empty");
  return { id: session.id, url: session.url };
}
