import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, request, Running, startApp, startStub } from "./helpers";

let api: Running;
let orders: Awaited<ReturnType<typeof startStub>>;

const order = (id: string, status: string) => ({
  id,
  buyerId: "buyer-1",
  status,
  total: 20_000,
  deliveryZone: "Norte",
  deliveryAddress: "Calle 1",
  requiresColdChain: false,
  items: [],
});

before(async () => {
  orders = await startStub({
    "GET /orders/o-pendiente": () => ({ body: order("o-pendiente", "PENDING_INVENTORY") }),
    "GET /orders/o-ajeno": () => ({ body: { ...order("o-ajeno", "CONFIRMED"), buyerId: "otro" } }),
  });
  process.env.ORDER_SERVICE_URL = orders.url;
  const { createApp } = await import("../src/app");
  api = await startApp(createApp());
});

after(async () => {
  await api.close();
  await orders.close();
});

test("POST /payments consulta el pedido como el comprador y solo cobra pedidos confirmados y propios", async () => {
  const pending = await request(api.url, "/payments", {
    method: "POST",
    headers: as("buyer-1", "BUYER"),
    body: { orderId: "o-pendiente", method: "PSE" },
  });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.error, "Solo se pueden pagar pedidos confirmados");
  assert.equal(orders.calls[0].url, "/orders/o-pendiente");
  assert.equal(orders.calls[0].headers["x-user-id"], "buyer-1");
  assert.equal(orders.calls[0].headers["x-user-role"], "BUYER");

  const foreign = await request(api.url, "/payments", {
    method: "POST",
    headers: as("buyer-1", "BUYER"),
    body: { orderId: "o-ajeno", method: "PSE" },
  });
  assert.equal(foreign.status, 404);
});

test("POST /payments valida el método y la tarjeta antes de llamar a order-service", async () => {
  const calls = orders.calls.length;

  const badCard = await request(api.url, "/payments", {
    method: "POST",
    headers: as("buyer-1", "BUYER"),
    body: { orderId: "o-1", method: "CARD", cardLast4: "12" },
  });
  assert.equal(badCard.status, 400);
  assert.match(badCard.body.error, /Tarjeta inválida/);

  const badMethod = await request(api.url, "/payments", {
    method: "POST",
    headers: as("buyer-1", "BUYER"),
    body: { orderId: "o-1", method: "BITCOIN" },
  });
  assert.equal(badMethod.status, 400);
  assert.match(badMethod.body.error, /Método de pago inválido/);
  assert.equal(orders.calls.length, calls);
});
