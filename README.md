# payment-service

Pagos (simulados) y liquidaciones a productores. Parte de **FarmToTable** (marketplace agrícola con microservicios orientados a eventos).

Estado: **Implementado** con PostgreSQL (Prisma) y RabbitMQ. Probado de punta a punta a través del API Gateway.

- Puerto local: `4006` · Ruta pública en el API Gateway: `/api/payments`
- Base de datos propia (`DATABASE_URL`), nunca compartida con otro servicio
- Eventos por RabbitMQ (exchange topic `farmtotable.events`, ver `src/events.ts`)

## Contrato REST

Es lo que ya consume el frontend (y lo que simula su modo demo en `src/lib/mock/server.ts` del repo del frontend).
El API Gateway valida el JWT y reenvía `x-user-id` / `x-user-role`; usa `requireUser()` de `src/auth.ts`.

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| `GET` | `/payments/wompi/config` | BUYER | `{ enabled, baseUrl, publicKey, acceptancePermalink }` para tokenizar la tarjeta en el navegador |
| `POST` | `/payments` | BUYER dueño | `{ orderId, method: CARD / PSE / CASH_ON_DELIVERY, cardLast4? }` → 201 AUTHORIZED o **402** `{ error, payment }` DECLINED. Solo pedidos CONFIRMED. Monto > MAX_AUTHORIZED_AMOUNT o tarjeta terminada en 0002 se rechaza |
| `GET` | `/payments/mine` | BUYER | Pagos del comprador |
| `GET` | `/payments` | ADMIN | Todos |
| `GET` | `/payments/settlements` | PRODUCER (las suyas) / ADMIN | Liquidaciones con `farmName` |
| `POST` | `/payments/settlements/:id/pay` | ADMIN | AVAILABLE → PAID |

Errores: `{ "error": "mensaje" }` con 400 (validación zod), 401, 403, 404, 409 (estado inválido) o 422 (regla de negocio).

## Pasarela de pagos (Wompi, modo sandbox)

Los pagos con tarjeta se procesan con la API de pruebas de [Wompi](https://docs.wompi.co) cuando están definidas `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY` y `WOMPI_INTEGRITY_SECRET` (llaves `pub_test_`, `prv_test_` y `test_integrity_`). Sin ellas, el servicio usa la pasarela simulada (`decide`), que es la que usan las pruebas automáticas. PSE y contra entrega siguen simulados.

Flujo de una tarjeta:

1. El navegador pide `GET /payments/wompi/config` y muestra los términos de Wompi.
2. El navegador envía los datos de la tarjeta **directo a Wompi** (`POST /tokens/cards` con la llave pública) y recibe un token de un solo uso. La tarjeta nunca pasa por nuestros servidores.
3. El navegador llama a `POST /payments` con `orderId`, `method: "CARD"`, `cardToken`, `cardLast4`, `customerEmail` y `acceptTerms: true`.
4. El servicio obtiene los tokens de aceptación (`GET /merchants/info`), crea la transacción (`POST /transactions`, llave privada, firma de integridad SHA-256 de `referencia + centavos + moneda + secreto`) y consulta `GET /transactions/:id` hasta que deja de estar `PENDING`.
5. `APPROVED` crea el pago `AUTHORIZED`, las liquidaciones y publica `payment.authorized`. `DECLINED`, `VOIDED` o `ERROR` responde 402 y publica `payment.declined`. Si sigue `PENDING` tras unos 30 s responde 504 sin registrar el pago.

Tarjetas de prueba: `4242 4242 4242 4242` (aprobada) y `4111 1111 1111 1111` (rechazada), con cualquier fecha futura y un CVC de 3 dígitos. Cada pago guarda `provider` y `providerRef` (el id de la transacción en Wompi).

Limitaciones conocidas: el reembolso por cancelación se registra solo en este servicio (no anula la transacción en Wompi) y la confirmación no usa el webhook `transaction.updated`.

## Eventos

Publica:
- `payment.authorized`
- `payment.declined`
- `payment.refunded`
- `settlement.available`
- `settlement.paid`

Consume:
- `delivery.completed` → liquidaciones AVAILABLE
- `order.cancelled` → reembolso + liquidaciones CANCELLED

Todo consumidor debe envolverse en `idempotent()` (`src/db.ts`).

## Modelo de datos (Prisma)

- `Payment` (id, orderId, buyerId, amount, method, status AUTHORIZED|DECLINED|REFUNDED, reason, cardLast4, createdAt) — nunca guardar el número completo
- `Settlement` (id, producerId, orderId, gross, commission, net, status PENDING|AVAILABLE|PAID|CANCELLED, paidAt)
- Al aprobar el pago lee el pedido en order-service (REST) y crea en la misma transacción una liquidación por productor (bruto − 10 % = neto, PENDING). `payment.authorized` lleva zona, dirección, kg e ítems para logística y analítica

## Desarrollo

```bash
cp .env.example .env    # ajusta DATABASE_URL
npm install
npm run db:migrate      # crea/aplica migraciones
npm run dev
```

## Despliegue

`Dockerfile` + `render.yaml` (Render) y `.github/workflows/ci.yml`: compila en cada push/PR y, en `main`,
publica la imagen en GHCR y dispara el deploy hook de Render si existe el secreto `RENDER_DEPLOY_HOOK_URL`.
