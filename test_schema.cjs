const { z } = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema");

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  platform: z.string(),
  role: z.string(),
  status: z.string(),
  trust: z.string(),
  capabilities: z.array(z.string()),
  grantedPermissions: z.array(z.string()),
  health: z
    .object({
      activeTasks: z.number(),
      maxConcurrentTasks: z.number(),
      batteryPercent: z.number().optional(),
      onBattery: z.boolean().optional(),
    })
    .passthrough(),
  lastSeenAt: z.date().nullable(),
  authenticated: z.boolean(),
});

console.log(JSON.stringify(zodToJsonSchema(deviceSchema), null, 2));
