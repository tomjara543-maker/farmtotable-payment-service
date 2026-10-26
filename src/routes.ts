import { Router } from "express";
import { z } from "zod";
import { requireUser, userOf } from "./auth";
import { prisma } from "./db";
import { publish } from "./events";
import { Payment, Settlement } from "./generated/prisma/client";
import { callService, HttpError, notFound, round2 } from "./http";

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
  })
  .refine((p) => p.method !== "CARD" || /^\d{4}$/.test(p.cardLast4 ?? ""), "Tarjeta inválida");

export const paymentJson = (p: Payment) => ({
  id: p.id,
  orderId: p.orderId,
  buyerId: p.buyerId,
  amount: p.amount,
  method: p.method,
  status: p.status,
  reason: p.reason ?? undefined,
  cardLast4: p.cardLast4 ?? undefined,
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

function decide(order: Order, method: string, cardLast4?: string) {
  if (order.total > MAX_AUTHORIZED_AMOUNT) return "El monto supera el límite autorizado por la pasarela";
  if (method === "CARD" && cardLast4 === "0002") return "Fondos insuficientes (tarjeta de prueba rechazada)";
  return undefined;
}

export function paymentRoutes() {
  const router = Router();

  router.post("/", requireUser("BUYER"), async (req, res) => {
    const { orderId, method, cardLast4 } = paySchema.parse(req.body);
    const user = userOf(res);
    const order = await callService<Order>(ORDER_URL, `/orders/${encodeURIComponent(orderId)}`, { user });
    if (order.buyerId !== user.id) throw notFound("Pedido");
    if (order.status !== "CONFIRMED") throw new HttpError(409, "Solo se pueden pagar pedidos confirmados");
    if (await prisma.payment.findFirst({ where: { orderId, status: "AUTHORIZED" } })) {
      throw new HttpError(409, "Este pedido ya fue pagado");
    }

    const reason = decide(order, method, cardLast4);
    const last4 = method === "CARD" ? cardLast4 : undefined;

    if (reason) {
      const payment = await prisma.payment.create({
        data: { orderId, buyerId: user.id, amount: order.total, method, status: "DECLINED", reason, cardLast4: last4 },
      });
      publish("payment.declined", { paymentId: payment.id, orderId, buyerId: user.id, reason });
      return res.status(402).json({ error: reason, payment: paymentJson(payment) });
    }

    const byProducer = new Map<string, number>();
    for (const i of order.items) byProducer.set(i.producerId, (byProducer.get(i.producerId) ?? 0) + i.quantity * i.unitPrice);

    const [payment] = await prisma.$transaction([
      prisma.payment.create({
        data: { orderId, buyerId: user.id, amount: order.total, method, status: "AUTHORIZED", cardLast4: last4 },
      }),
      ...[...byProducer].map(([producerId, grossRaw]) => {
        const gross = Math.round(grossRaw);
        const commission = Math.round(gross * COMMISSION_RATE);
        return prisma.settlement.create({ data: { producerId, orderId, gross, commission, net: gross - commission } });
      }),
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
