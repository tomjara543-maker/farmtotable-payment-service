import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { acceptanceTokens, awaitFinalStatus, createCardTransaction, integritySignature, wompiEnabled } from "../src/wompi";

const realFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  calls.length = 0;
  process.env.WOMPI_BASE_URL = "https://sandbox.wompi.test/v1";
  process.env.WOMPI_PUBLIC_KEY = "pub_test_abc";
  process.env.WOMPI_PRIVATE_KEY = "prv_test_xyz";
  process.env.WOMPI_INTEGRITY_SECRET = "test_integrity_secret";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["WOMPI_BASE_URL", "WOMPI_PUBLIC_KEY", "WOMPI_PRIVATE_KEY", "WOMPI_INTEGRITY_SECRET"]) delete process.env[k];
});

const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

test("integritySignature concatena referencia, monto en centavos, moneda y secreto, y wompiEnabled exige las tres claves", () => {
  const expected = createHash("sha256").update("ftt-123-1700000000" + "2000000" + "COP" + "test_integrity_secret").digest("hex");
  assert.equal(integritySignature("ftt-123-1700000000", 2_000_000, "COP", "test_integrity_secret"), expected);
  assert.notEqual(integritySignature("ftt-124-1700000000", 2_000_000, "COP", "test_integrity_secret"), expected);

  assert.equal(wompiEnabled(), true);
  delete process.env.WOMPI_PRIVATE_KEY;
  assert.equal(wompiEnabled(), false);
});

test("crea una transacción con tarjeta en Wompi con la llave privada, el token de aceptación y la firma de integridad", async () => {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).endsWith("/merchants/info")) {
      return reply({
        presigned_acceptance: { acceptance_token: "acc_1", permalink: "https://wompi.test/terminos" },
        presigned_personal_data_auth: { acceptance_token: "pers_1", permalink: "https://wompi.test/datos" },
      });
    }
    return reply({ id: "tx-1", status: "PENDING", reference: "ref-1", amount_in_cents: 5_000_000 }, 201);
  }) as typeof fetch;

  const tokens = await acceptanceTokens();
  assert.equal(tokens.acceptanceToken, "acc_1");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-merchant-public-key"], "pub_test_abc");

  const tx = await createCardTransaction({ cardToken: "tok_test_1", amountInCents: 5_000_000, customerEmail: "comprador@demo.com", reference: "ref-1", tokens });
  assert.equal(tx.id, "tx-1");

  const post = calls[1];
  assert.equal(post.url, "https://sandbox.wompi.test/v1/transactions");
  assert.equal((post.init.headers as Record<string, string>).authorization, "Bearer prv_test_xyz");
  const body = JSON.parse(String(post.init.body));
  assert.equal(body.acceptance_token, "acc_1");
  assert.equal(body.accept_personal_auth, "pers_1");
  assert.equal(body.amount_in_cents, 5_000_000);
  assert.equal(body.currency, "COP");
  assert.equal(body.customer_email, "comprador@demo.com");
  assert.deepEqual(body.payment_method, { type: "CARD", token: "tok_test_1", installments: 1 });
  assert.equal(body.signature, integritySignature("ref-1", 5_000_000, "COP", "test_integrity_secret"));
});

test("awaitFinalStatus consulta la transacción hasta que deja de estar pendiente y traduce los errores de Wompi", async () => {
  const statuses = ["PENDING", "PENDING", "APPROVED"];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    calls.push({ url: String(input), init: {} });
    return reply({ id: "tx-1", status: statuses[calls.length - 1], reference: "ref-1", amount_in_cents: 1 });
  }) as typeof fetch;

  const final = await awaitFinalStatus("tx-1", { attempts: 5, delayMs: 1 });
  assert.equal(final.status, "APPROVED");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url === "https://sandbox.wompi.test/v1/transactions/tx-1"));

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { type: "INPUT_VALIDATION_ERROR", messages: { reference: ["La referencia ya existe"] } } }), { status: 422 })) as typeof fetch;
  await assert.rejects(() => awaitFinalStatus("tx-2", { attempts: 1 }), /La referencia ya existe/);
});
