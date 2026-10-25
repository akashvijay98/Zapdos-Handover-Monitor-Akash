import { loadConfig } from "./config.js";
import { DeadlineMonitor, DeadlineNotificationStore, startDeadlineMonitor } from "./deadline-monitor.js";
import { LinearClient } from "./linear.js";
import { LangChainHandoverOrchestrator } from "./orchestrator.js";
import { HandoverService } from "./service.js";
import { createSlackApp } from "./slack.js";
import { ProposalStore } from "./store.js";

const config = loadConfig();
const tracker = new LinearClient(config.linearApiKey, config.linearTeamId);
const analyzer = new LangChainHandoverOrchestrator(config.openaiApiKey, config.ollamaBaseUrl);
const store = new ProposalStore(config.proposalStorePath);
const service = new HandoverService(tracker, analyzer, store);
const app = createSlackApp(config, service, [
  ...config.openaiModels.map((model) => ({ provider: "openai" as const, model })),
  ...config.ollamaModels.map((model) => ({ provider: "ollama" as const, model })),
]);

await app.start();
app.logger.info("⚡ Approval-first Slack-to-Linear handover bot is running in Socket Mode");

if (config.deadlineMonitorEnabled) {
  const monitor = new DeadlineMonitor(
    tracker,
    app.client,
    new DeadlineNotificationStore(config.deadlineNotificationStorePath),
    config.deadlineWarningDays,
  );
  startDeadlineMonitor(monitor, config.deadlineMonitorIntervalMinutes, (message) => app.logger.info(message));
}
