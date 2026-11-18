import { createHash } from "node:crypto";
import { HttpError } from "./http";

export const wompiConfig = () => ({
  baseUrl: process.env.WOMPI_BASE_URL ?? "https://sandbox.wompi.co/v1",
  publicKey: process.env.WOMPI_PUBLIC_KEY ?? "",
  privateKey: process.env.WOMPI_PRIVATE_KEY ?? "",
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET ?? "",
});

export function wompiEnabled() {
  const c = wompiConfig();
  return Boolean(c.publicKey && c.privateKey && c.integritySecret);
}

export function integritySignature(reference: string, amountInCents: number, currency: string, secret: string) {
  return createHash("sha256").update(`${reference}${amountInCents}${currency}${secret}`).digest("hex");
}

export type WompiStatus = "PENDING" | "APPROVED" | "DECLINED" | "VOIDED" | "ERROR";

export interface WompiTransaction {
  id: string;
  status: WompiStatus;
  status_message?: string | null;
  reference: string;
  amount_in_cents: number;
}

interface WompiEnvelope<T> {
  data?: T;
  error?: { type?: string; reason?: string; messages?: Record<string, string[]> | string[] };
}

function describeError(body: WompiEnvelope<unknown>) {
  const messages = body.error?.messages;
  if (Array.isArray(messages)) return messages.join("; ");
  if (messages && typeof messages === "object") return Object.values(messages).flat().join("; ");
  return body.error?.reason ?? body.error?.type ?? "respuesta inesperada";
}

async function wompi<T>(path: string, init: RequestInit & { key?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const { key, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${wompiConfig().baseUrl}${path}`, {
      ...rest,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "No se pudo conectar con la pasarela de pagos");
  }
  const body = (await res.json().catch(() => ({}))) as WompiEnvelope<T>;
  if (!res.ok || body.data === undefined) {
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : 422, `Pasarela de pagos: ${describeError(body)}`);
  }
  return body.data;
}

export interface AcceptanceTokens {
  acceptanceToken: string;
  acceptancePermalink: string;
  personalAuthToken?: string;
  personalAuthPermalink?: string;
}

export async function acceptanceTokens(): Promise<AcceptanceTokens> {
  const data = await wompi<{
    presigned_acceptance: { acceptance_token: string; permalink: string };
    presigned_personal_data_auth?: { acceptance_token: string; permalink: string };
  }>("/merchants/info", { headers: { "x-merchant-public-key": wompiConfig().publicKey } });
  return {
    acceptanceToken: data.presigned_acceptance.acceptance_token,
    acceptancePermalink: data.presigned_acceptance.permalink,
    personalAuthToken: data.presigned_personal_data_auth?.acceptance_token,
    personalAuthPermalink: data.presigned_personal_data_auth?.permalink,
  };
}

export function createCardTransaction(input: {
  cardToken: string;
  amountInCents: number;
  customerEmail: string;
  reference: string;
  tokens: AcceptanceTokens;
}) {
  const { privateKey, integritySecret } = wompiConfig();
  return wompi<WompiTransaction>("/transactions", {
    method: "POST",
    key: privateKey,
    body: JSON.stringify({
      acceptance_token: input.tokens.acceptanceToken,
      ...(input.tokens.personalAuthToken ? { accept_personal_auth: input.tokens.personalAuthToken } : {}),
      amount_in_cents: input.amountInCents,
      currency: "COP",
      customer_email: input.customerEmail,
      reference: input.reference,
      signature: integritySignature(input.reference, input.amountInCents, "COP", integritySecret),
      payment_method: { type: "CARD", token: input.cardToken, installments: 1 },
    }),
  });
}

export async function awaitFinalStatus(id: string, options: { attempts?: number; delayMs?: number } = {}) {
  const { attempts = 20, delayMs = 1500 } = options;
  let last = await wompi<WompiTransaction>(`/transactions/${encodeURIComponent(id)}`, { key: wompiConfig().privateKey });
  for (let i = 1; i < attempts && last.status === "PENDING"; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await wompi<WompiTransaction>(`/transactions/${encodeURIComponent(id)}`, { key: wompiConfig().privateKey });
  }
  return last;
}
