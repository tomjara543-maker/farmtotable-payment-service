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

test("con Wompi activo, POST /payments exige el token de la tarjeta, el correo y la aceptación de los términos", async () => {
  process.env.WOMPI_PUBLIC_KEY = "pub_test_abc";
  process.env.WOMPI_PRIVATE_KEY = "prv_test_xyz";
  process.env.WOMPI_INTEGRITY_SECRET = "test_integrity_secret";
  try {
    const base = { orderId: "o-1", method: "CARD", cardLast4: "4242" };
    const headers = as("buyer-1", "BUYER");

    const noToken = await request(api.url, "/payments", { method: "POST", headers, body: base });
    assert.equal(noToken.status, 400);
    assert.match(noToken.body.error, /Falta el token de la tarjeta/);

    const noTerms = await request(api.url, "/payments", {
      method: "POST",
      headers,
      body: { ...base, cardToken: "tok_test_1", customerEmail: "comprador@demo.com" },
    });
    assert.equal(noTerms.status, 400);
    assert.match(noTerms.body.error, /Debes aceptar los términos/);

    const pse = await request(api.url, "/payments", { method: "POST", headers, body: { orderId: "o-pendiente", method: "PSE" } });
    assert.equal(pse.status, 409);
  } finally {
    delete process.env.WOMPI_PUBLIC_KEY;
    delete process.env.WOMPI_PRIVATE_KEY;
    delete process.env.WOMPI_INTEGRITY_SECRET;
  }
});
