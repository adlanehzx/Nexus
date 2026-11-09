import { resolve } from "node:path";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TradingLab, tradingConfigSchema, tradingOrderSchema } from "../../services/trading/lab.js";
import { ok } from "../../lib/response.js";

export const tradingRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const lab = new TradingLab(
    resolve(
      app.services.acpWorkspaceRoot ?? resolve(process.cwd(), ".nexus-workspaces"),
      "trading-lab/state.json",
    ),
    app.services.vault,
  );
  const access = { preHandler: app.requireAdmin };
  app.get("/mission-control/trading", access, async (request) =>
    ok(await lab.status(), request.id),
  );
  app.post("/mission-control/trading/refresh", access, async (request) =>
    ok(await lab.refresh(), request.id),
  );
  app.post("/mission-control/trading/kill", access, async (request) =>
    ok(await lab.killSwitch(), request.id),
  );
  app.put(
    "/mission-control/trading/config",
    {
      ...access,
      schema: {
        body: z.object({
          config: tradingConfigSchema,
          confirmProduction: z.boolean().default(false),
        }),
      },
    },
    async (request) =>
      ok(await lab.configure(request.body.config, request.body.confirmProduction), request.id),
  );
  app.put(
    "/mission-control/trading/credentials",
    {
      ...access,
      schema: {
        body: z.object({
          venue: z.enum(["binance", "kraken", "ibkr"]),
          environment: z.enum(["testnet", "production"]),
          apiKey: z.string().min(1).max(4096),
          apiSecret: z.string().min(1).max(4096),
        }),
      },
    },
    async (request) =>
      ok(
        await lab.credentials(
          request.body.venue,
          request.body.environment,
          request.body.apiKey,
          request.body.apiSecret,
        ),
        request.id,
      ),
  );
  app.post(
    "/mission-control/trading/orders",
    { ...access, schema: { body: tradingOrderSchema } },
    async (request) => ok(await lab.order(request.body), request.id),
  );
  // Loss guards run without requiring an open browser. Failures are persisted visibly.
  const timer = setInterval(() => {
    void lab.refresh().catch(() => app.log.error("Trading risk monitor failed"));
  }, 15000);
  timer.unref();
  app.addHook("onClose", () => {
    clearInterval(timer);
    return Promise.resolve();
  });
  done();
};
