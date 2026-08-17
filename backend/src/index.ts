import { serve } from "@hono/node-server";
import { app } from "./app";
import { initFileLogging } from "./logger";

initFileLogging();

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[backend] listening on http://localhost:${info.port}`);
});
