import { z } from "zod";

export type NotificationPriority = "min" | "low" | "default" | "high" | "urgent";

export const PRIORITY_LEVELS: Record<NotificationPriority, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
};

export interface NotificationMessage {
  id: string;
  title: string;
  body: string;
  priority?: NotificationPriority | undefined;
  tags?: string[] | undefined;
  url?: string | undefined;
  actionTitle?: string | undefined;
  groupKey?: string | undefined;
  createdAt?: Date | undefined;
  userId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export const desktopChannelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  urgency: z.enum(["low", "normal", "critical"]).default("normal"),
});

export type DesktopChannelConfig = z.infer<typeof desktopChannelConfigSchema>;

export const ntfyChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().url().default("https://ntfy.sh"),
  topic: z.string().min(1).default("nexus-alerts"),
  tokenRef: z.string().optional(),
});

export type NtfyChannelConfig = z.infer<typeof ntfyChannelConfigSchema>;

export const webhookChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().optional(),
  format: z.enum(["discord", "telegram", "apprise", "generic"]).default("generic"),
  tokenRef: z.string().optional(),
});

export type WebhookChannelConfig = z.infer<typeof webhookChannelConfigSchema>;

export const quietHoursConfigSchema = z.object({
  enabled: z.boolean().default(false),
  start: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format d'heure invalide (HH:MM attendu)")
    .default("22:00"),
  end: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format d'heure invalide (HH:MM attendu)")
    .default("08:00"),
  timezone: z.string().default("Europe/Paris"),
  allowUrgent: z.boolean().default(true),
});

export type QuietHoursConfig = z.infer<typeof quietHoursConfigSchema>;

export const groupingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  windowSeconds: z.number().int().min(5).max(3600).default(30),
});

export type GroupingConfig = z.infer<typeof groupingConfigSchema>;

export const notificationsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  desktop: desktopChannelConfigSchema.default({ enabled: true, urgency: "normal" }),
  ntfy: ntfyChannelConfigSchema.default({
    enabled: false,
    serverUrl: "https://ntfy.sh",
    topic: "nexus-alerts",
  }),
  webhook: webhookChannelConfigSchema.optional(),
  quietHours: quietHoursConfigSchema.default({
    enabled: false,
    start: "22:00",
    end: "08:00",
    timezone: "Europe/Paris",
    allowUrgent: true,
  }),
  grouping: groupingConfigSchema.default({
    enabled: true,
    windowSeconds: 30,
  }),
  dashboardBaseUrl: z.string().url().default("http://localhost:3000"),
});

export type NotificationsConfig = z.infer<typeof notificationsConfigSchema>;

export interface ChannelDeliveryResult {
  channel: string;
  success: boolean;
  error?: string | undefined;
  skippedReason?: string | undefined;
}

export interface DeliveryReport {
  messageId: string;
  timestamp: string;
  channels: ChannelDeliveryResult[];
}
