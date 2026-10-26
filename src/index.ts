import cors from "cors";
import express from "express";
import { registerConsumers } from "./consumers";
import { connectEvents } from "./events";
import { errorHandler } from "./http";
import { paymentRoutes } from "./routes";

const PORT = Number(process.env.PORT ?? 4006);

async function main() {
  await registerConsumers();
  await connectEvents();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ service: "payment-service", status: "ok" }));
  app.use("/payments", paymentRoutes());
  app.use(errorHandler);

  app.listen(PORT, () => console.log(`payment-service escuchando en http://localhost:${PORT}`));
}

main();
