import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, MAX_AUTHORIZED_AMOUNT, settlementsFor } from "../src/routes";

test("decide simula la pasarela: rechaza montos altos y la tarjeta de prueba 0002", () => {
  assert.equal(decide({ total: 50_000 }, "CARD", "4242"), undefined);
  assert.equal(decide({ total: 50_000 }, "PSE"), undefined);
  assert.match(decide({ total: MAX_AUTHORIZED_AMOUNT + 1 }, "PSE")!, /supera el límite/);
  assert.match(decide({ total: 50_000 }, "CARD", "0002")!, /Fondos insuficientes/);
});

test("settlementsFor agrupa por productor y descuenta la comisión de la plataforma", () => {
  const result = settlementsFor(
    [
      { producerId: "pr-1", quantity: 2, unitPrice: 4_500 },
      { producerId: "pr-2", quantity: 1.5, unitPrice: 3_333 },
      { producerId: "pr-1", quantity: 1, unitPrice: 1_000 },
    ],
    0.1,
  );

  assert.deepEqual(result, [
    { producerId: "pr-1", gross: 10_000, commission: 1_000, net: 9_000 },
    { producerId: "pr-2", gross: 5_000, commission: 500, net: 4_500 },
  ]);
});
