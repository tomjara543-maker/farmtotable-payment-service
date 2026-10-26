import { idempotent, prisma } from "./db";
import { publish, subscribe } from "./events";

export async function registerConsumers() {
  await subscribe(
    "payment-service",
    ["delivery.completed", "order.cancelled"],
    idempotent(async ({ eventType, data }) => {
      const orderId: string = data.orderId;

      if (eventType === "delivery.completed") {
        const pending = await prisma.settlement.findMany({ where: { orderId, status: "PENDING" } });
        await prisma.settlement.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "AVAILABLE" } });
        for (const s of pending) {
          publish("settlement.available", { settlementId: s.id, producerId: s.producerId, orderId, net: s.net });
        }
      }

      if (eventType === "order.cancelled") {
        const payment = await prisma.payment.findFirst({ where: { orderId, status: "AUTHORIZED" } });
        await prisma.$transaction([
          prisma.payment.updateMany({ where: { orderId, status: "AUTHORIZED" }, data: { status: "REFUNDED" } }),
          prisma.settlement.updateMany({ where: { orderId, status: { in: ["PENDING", "AVAILABLE"] } }, data: { status: "CANCELLED" } }),
        ]);
        if (payment) {
          publish("payment.refunded", { paymentId: payment.id, orderId, buyerId: payment.buyerId, amount: payment.amount });
        }
      }
    }),
  );
}
