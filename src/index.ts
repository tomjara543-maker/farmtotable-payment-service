import { createApp } from "./app";
import { registerConsumers } from "./consumers";
import { connectEvents } from "./events";

const PORT = Number(process.env.PORT ?? 4006);

async function main() {
  await registerConsumers();
  await connectEvents();

  createApp().listen(PORT, () => console.log(`payment-service escuchando en http://localhost:${PORT}`));
}

main();
