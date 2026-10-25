import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODELS: z.string().default("gpt-5-mini"),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODELS: z.string().default("qwen3:8b"),
  AUTO_ANALYZE_MODEL: z.string().optional(),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEAM_ID: z.string().uuid(),
  ALLOWED_SLACK_CHANNEL_IDS: z.string().default(""),
  PROPOSAL_STORE_PATH: z.string().default(".data/proposals.json"),
  DEADLINE_MONITOR_ENABLED: z.enum(["true", "false"]).default("false"),
  DEADLINE_MONITOR_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(1440),
  DEADLINE_WARNING_DAYS: z.string().default("7,3,1,0"),
  DEADLINE_NOTIFICATION_STORE_PATH: z.string().default(".data/deadline-notifications.json"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${fields}`);
  }
  return {
    slackBotToken: parsed.data.SLACK_BOT_TOKEN,
    slackAppToken: parsed.data.SLACK_APP_TOKEN,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    openaiModels: splitModels(parsed.data.OPENAI_MODELS),
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL.replace(/\/$/, ""),
    ollamaModels: splitModels(parsed.data.OLLAMA_MODELS),
    autoAnalyzeModel: parseAutoModel(parsed.data.AUTO_ANALYZE_MODEL),
    linearApiKey: parsed.data.LINEAR_API_KEY,
    linearTeamId: parsed.data.LINEAR_TEAM_ID,
    allowedSlackChannelIds: new Set(
      parsed.data.ALLOWED_SLACK_CHANNEL_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    ),
    proposalStorePath: parsed.data.PROPOSAL_STORE_PATH,
    deadlineMonitorEnabled: parsed.data.DEADLINE_MONITOR_ENABLED === "true",
    deadlineMonitorIntervalMinutes: parsed.data.DEADLINE_MONITOR_INTERVAL_MINUTES,
    deadlineWarningDays: parsed.data.DEADLINE_WARNING_DAYS.split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0),
    deadlineNotificationStorePath: parsed.data.DEADLINE_NOTIFICATION_STORE_PATH,
  };
}

function parseAutoModel(value?: string): { provider: "openai" | "ollama"; model: string } | null {
  if (!value) return null;
  const separator = value.indexOf("/");
  if (separator < 1) throw new Error("AUTO_ANALYZE_MODEL must use provider/model, for example ollama/qwen3:8b");
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if ((provider !== "openai" && provider !== "ollama") || !model) throw new Error("AUTO_ANALYZE_MODEL must use openai/model or ollama/model");
  return { provider, model };
}

function splitModels(value: string): string[] {
  return value.split(",").map((model) => model.trim()).filter(Boolean);
}
