import { Router } from "express";
import { z } from "zod";
import { requireUser, userOf } from "./auth";
import { prisma } from "./db";
import { publish } from "./events";
import { Payment, Settlement } from "./generated/prisma/client";
import { callService, HttpError, notFound, round2 } from "./http";
import { acceptanceTokens, awaitFinalStatus, createCardTransaction, wompiConfig, wompiEnabled } from "./wompi";

const ORDER_URL = process.env.ORDER_SERVICE_URL;
const PRODUCER_URL = process.env.PRODUCER_SERVICE_URL;

export const COMMISSION_RATE = Number(process.env.COMMISSION_RATE ?? 0.1);
export const MAX_AUTHORIZED_AMOUNT = Number(process.env.MAX_AUTHORIZED_AMOUNT ?? 2_000_000);

interface Order {
  id: string;
  buyerId: string;
  status: string;
  total: number;
  deliveryZone: string;
  deliveryAddress: string;
  requiresColdChain: boolean;
  items: { productId: string; producerId: string; productName: string; quantity: number; unitPrice: number }[];
}

const paySchema = z
  .object({
    orderId: z.string().min(1, "El campo orderId es obligatorio"),
    method: z.enum(["CARD", "PSE", "CASH_ON_DELIVERY"], "Método de pago inválido"),
    cardLast4: z.string().optional(),
    cardToken: z.string().min(1).optional(),
    customerEmail: z.string().email("Correo inválido").optional(),
    acceptTerms: z.boolean().optional(),
  })
  .refine((p) => p.method !== "CARD" || /^\d{4}$/.test(p.cardLast4 ?? ""), "Tarjeta inválida")
  .refine((p) => !(wompiEnabled() && p.method === "CARD") || Boolean(p.cardToken), "Falta el token de la tarjeta")
  .refine((p) => !(wompiEnabled() && p.method === "CARD") || Boolean(p.customerEmail), "Falta el correo del comprador")
  .refine((p) => !(wompiEnabled() && p.method === "CARD") || p.acceptTerms === true, "Debes aceptar los términos de la pasarela");

export const paymentJson = (p: Payment) => ({
  id: p.id,
  orderId: p.orderId,
  buyerId: p.buyerId,
  amount: p.amount,
  method: p.method,
  status: p.status,
  reason: p.reason ?? undefined,
  cardLast4: p.cardLast4 ?? undefined,
  provider: p.provider ?? undefined,
  createdAt: p.createdAt,
});

const settlementJson = (s: Settlement, farmName?: string) => ({
  id: s.id,
  producerId: s.producerId,
  farmName,
  orderId: s.orderId,
  gross: s.gross,
  commission: s.commission,
  net: s.net,
  status: s.status,
  createdAt: s.createdAt,
  paidAt: s.paidAt ?? undefined,
});

export function decide(order: Pick<Order, "total">, method: string, cardLast4?: string) {
  if (order.total > MAX_AUTHORIZED_AMOUNT) return "El monto supera el límite autorizado por la pasarela";
  if (method === "CARD" && cardLast4 === "0002") return "Fondos insuficientes (tarjeta de prueba rechazada)";
  return undefined;
}

export function settlementsFor(items: Pick<Order["items"][number], "producerId" | "quantity" | "unitPrice">[], rate = COMMISSION_RATE) {
  const byProducer = new Map<string, number>();
  for (const i of items) byProducer.set(i.producerId, (byProducer.get(i.producerId) ?? 0) + i.quantity * i.unitPrice);
  return [...byProducer].map(([producerId, grossRaw]) => {
    const gross = Math.round(grossRaw);
    const commission = Math.round(gross * rate);
    return { producerId, gross, commission, net: gross - commission };
  });
}

export function paymentRoutes() {
  const router = Router();

  router.get("/wompi/config", requireUser("BUYER"), async (_req, res) => {
    if (!wompiEnabled()) return res.json({ enabled: false });
    const { baseUrl, publicKey } = wompiConfig();
    const tokens = await acceptanceTokens().catch(() => undefined);
    res.json({
      enabled: true,
      baseUrl,
      publicKey,
      acceptancePermalink: tokens?.acceptancePermalink,
      personalAuthPermalink: tokens?.personalAuthPermalink,
    });
  });

  router.post("/", requireUser("BUYER"), async (req, res) => {
    const { orderId, method, cardLast4, cardToken, customerEmail } = paySchema.parse(req.body);
    const user = userOf(res);
    const order = await callService<Order>(ORDER_URL, `/orders/${encodeURIComponent(orderId)}`, { user });
    if (order.buyerId !== user.id) throw notFound("Pedido");
    if (order.status !== "CONFIRMED") throw new HttpError(409, "Solo se pueden pagar pedidos confirmados");
    if (await prisma.payment.findFirst({ where: { orderId, status: "AUTHORIZED" } })) {
      throw new HttpError(409, "Este pedido ya fue pagado");
    }

    const last4 = method === "CARD" ? cardLast4 : undefined;
    const viaWompi = method === "CARD" && wompiEnabled();

    const decline = async (reason: string, provider?: string, providerRef?: string) => {
      const payment = await prisma.payment.create({
        data: { orderId, buyerId: user.id, amount: order.total, method, status: "DECLINED", reason, cardLast4: last4, provider, providerRef },
      });
      publish("payment.declined", { paymentId: payment.id, orderId, buyerId: user.id, reason });
      return res.status(402).json({ error: reason, payment: paymentJson(payment) });
    };

    let provider: string | undefined;
    let providerRef: string | undefined;

    if (viaWompi) {
      if (order.total > MAX_AUTHORIZED_AMOUNT) return decline("El monto supera el límite autorizado por la pasarela");
      const reference = `ftt-${order.id}-${Date.now()}`;
      const tokens = await acceptanceTokens();
      const created = await createCardTransaction({
        cardToken: cardToken!,
        amountInCents: Math.round(order.total * 100),
        customerEmail: customerEmail!,
        reference,
        tokens,
      });
      const final = await awaitFinalStatus(created.id);
      provider = "wompi";
      providerRef = final.id;
      if (final.status === "PENDING") {
        throw new HttpError(504, "La pasarela aún no confirma el pago. Revisa Mis pagos en unos minutos antes de reintentar");
      }
      if (final.status !== "APPROVED") {
        const detail = final.status_message ? ` (${final.status_message})` : "";
        return decline(`Pasarela de pagos: ${final.status}${detail}`, provider, providerRef);
      }
    } else {
      const reason = decide(order, method, cardLast4);
      if (reason) return decline(reason);
    }

    const [payment] = await prisma.$transaction([
      prisma.payment.create({
        data: { orderId, buyerId: user.id, amount: order.total, method, status: "AUTHORIZED", cardLast4: last4, provider, providerRef },
      }),
      ...settlementsFor(order.items).map((data) => prisma.settlement.create({ data: { ...data, orderId } })),
    ]);

    publish("payment.authorized", {
      paymentId: payment.id,
      orderId,
      buyerId: user.id,
      amount: payment.amount,
      method,
      deliveryZone: order.deliveryZone,
      deliveryAddress: order.deliveryAddress,
      requiresColdChain: order.requiresColdChain,
      totalKg: round2(order.items.reduce((s, i) => s + i.quantity, 0)),
      items: order.items,
      commissionRate: COMMISSION_RATE,
    });
    res.status(201).json(paymentJson(payment));
  });

  router.get("/mine", requireUser("BUYER"), async (_req, res) => {
    const list = await prisma.payment.findMany({ where: { buyerId: userOf(res).id }, orderBy: { createdAt: "desc" } });
    res.json(list.map(paymentJson));
  });

  router.get("/", requireUser("ADMIN"), async (_req, res) => {
    const list = await prisma.payment.findMany({ orderBy: { createdAt: "desc" } });
    res.json(list.map(paymentJson));
  });

  router.get("/settlements", requireUser("PRODUCER"), async (_req, res) => {
    const user = userOf(res);
    const producers = await callService<{ id: string; ownerId: string; farmName: string }[]>(PRODUCER_URL, "/producers");
    const names = new Map(producers.map((p) => [p.id, p.farmName]));
    const mine = producers.filter((p) => p.ownerId === user.id).map((p) => p.id);
    const list = await prisma.settlement.findMany({
      where: user.role === "ADMIN" ? {} : { producerId: { in: mine } },
      orderBy: { createdAt: "desc" },
    });
    res.json(list.map((s) => settlementJson(s, names.get(s.producerId))));
  });

  router.post("/settlements/:id/pay", requireUser("ADMIN"), async (req, res) => {
    const id = String(req.params.id);
    const s = await prisma.settlement.findUnique({ where: { id } });
    if (!s) throw notFound("Liquidación");
    if (s.status !== "AVAILABLE") throw new HttpError(409, "Solo se pagan liquidaciones de pedidos entregados");
    const paid = await prisma.settlement.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });
    publish("settlement.paid", { settlementId: id, producerId: s.producerId, orderId: s.orderId, net: s.net });
    res.json(settlementJson(paid));
  });

  return router;
}
