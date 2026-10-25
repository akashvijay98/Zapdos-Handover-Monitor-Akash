import { App, type BlockAction } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { proposalBlocks } from "./slack-view.js";
import type { HandoverService } from "./service.js";
import { ModelSelectionSchema, type ModelSelection, type SourceEvent } from "./types.js";

function classify(text: string): SourceEvent["kind"] {
  if (/\b(from|to|subject):/i.test(text)) return "email";
  if (/\b(attendees|call notes|meeting notes|minutes):/i.test(text)) return "call_note";
  return "slack_message";
}

async function fileText(url: string, token: string): Promise<string> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not download Slack file (${response.status})`);
  return response.text();
}

export function createSlackApp(config: Config, service: HandoverService, models: ModelSelection[]): App {
  if (!models.length) throw new Error("Configure at least one model in OPENAI_MODELS or OLLAMA_MODELS");
  const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });
  const pendingSources = new Map<string, SourceEvent>();

  async function ingestSource(source: SourceEvent): Promise<void> {
    if (config.autoAnalyzeModel) {
      const pending = await app.client.chat.postMessage({
        channel: source.slackChannel,
        thread_ts: source.slackThreadTs ?? undefined,
        text: `⏳ ${config.autoAnalyzeModel.provider}/${config.autoAnalyzeModel.model} is automatically checking this source against Linear…`,
      });
      const { proposal, created } = await service.propose(source, config.autoAnalyzeModel);
      await app.client.chat.update({
        channel: source.slackChannel,
        ts: pending.ts!,
        text: created ? `Handover proposal: ${proposal.analysis.summary}` : "This source was already analyzed.",
        blocks: proposalBlocks(proposal),
      });
      return;
    }

    const intakeId = randomUUID();
    pendingSources.set(intakeId, source);
    await app.client.chat.postMessage({
      channel: source.slackChannel,
      thread_ts: source.slackThreadTs ?? undefined,
      text: "Choose a model to analyze this handover source.",
      blocks: [
        {
          type: "section",
          block_id: `intake:${intakeId}`,
          text: { type: "mrkdwn", text: `I found *${source.title}*. Which model should inspect Linear and prepare the proposal?` },
          accessory: {
            type: "static_select",
            action_id: "handover_select_model",
            placeholder: { type: "plain_text", text: "Choose reasoning model" },
            options: models.slice(0, 100).map((choice) => ({
              text: { type: "plain_text", text: `${choice.provider === "ollama" ? "Local" : "OpenAI"} · ${choice.model}`.slice(0, 75) },
              value: JSON.stringify(choice),
            })),
          },
        },
        { type: "context", elements: [{ type: "mrkdwn", text: "No Linear changes will be made during analysis." }] },
      ],
    });
  }

  app.message(async ({ message, client, say, logger }) => {
    const event = message as GenericMessageEvent & { files?: Array<{ id: string; name?: string; mimetype?: string; url_private_download?: string }> };
    if (!event.user || event.subtype || (!event.text && !event.files?.length)) return;
    const isDm = event.channel_type === "im";
    const isAllowed = config.allowedSlackChannelIds.has(event.channel);
    const auth = await client.auth.test();
    const mentioned = auth.user_id ? (event.text ?? "").includes(`<@${auth.user_id}>`) : false;
    if (!isDm && !isAllowed && !mentioned) return;

    try {
      const attachments: string[] = [];
      for (const file of event.files ?? []) {
        if (!file.url_private_download || !/^(text\/|application\/json)/.test(file.mimetype ?? "")) continue;
        attachments.push(`\n\n--- ${file.name ?? file.id} ---\n${await fileText(file.url_private_download, config.slackBotToken)}`);
      }
      const body = `${(event.text ?? "").replace(auth.user_id ? new RegExp(`<@${auth.user_id}>`, "g") : /$^/, "").trim()}${attachments.join("")}`;
      if (!body) return;
      const source: SourceEvent = {
        id: `slack:${event.channel}:${event.ts}`,
        kind: classify(body),
        title: event.files?.[0]?.name ?? body.split("\n")[0]!.slice(0, 100),
        body,
        occurredAt: new Date(Number(event.ts.split(".")[0]) * 1000).toISOString(),
        slackChannel: event.channel,
        slackThreadTs: event.thread_ts ?? event.ts,
        submittedBy: event.user,
      };
      await ingestSource(source);
    } catch (error) {
      logger.error(error);
      await say({ thread_ts: event.thread_ts ?? event.ts, text: `I could not prepare the proposal: ${String(error)}` });
    }
  });

  app.event("file_shared", async ({ event, client, logger }) => {
    try {
      const channel = "channel_id" in event ? event.channel_id : undefined;
      if (!channel || !config.allowedSlackChannelIds.has(channel)) return;
      const result = await client.files.info({ file: event.file_id });
      const file = result.file as unknown as {
        id?: string; title?: string; name?: string; timestamp?: number;
        huddle_date_start?: number; huddle_transcription?: { lines?: Array<{ contents?: unknown; user_id?: string; start_time_ms?: number }> };
      };
      const lines = file.huddle_transcription?.lines;
      if (!lines?.length) return;
      const transcript = lines.map((line) => {
        const contents = typeof line.contents === "string" ? line.contents : JSON.stringify(line.contents ?? "");
        return `${line.user_id ? `<@${line.user_id}>: ` : ""}${contents}`;
      }).join("\n");
      await ingestSource({
        id: `slack-huddle:${file.id ?? event.file_id}`,
        kind: "call_note",
        title: file.title ?? file.name ?? "Slack Huddle transcript",
        body: transcript,
        occurredAt: new Date((file.huddle_date_start ?? file.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        slackChannel: channel,
        slackThreadTs: null,
        submittedBy: event.user_id ?? "unknown",
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action("handover_select_model", async ({ ack, action, respond, logger }) => {
    await ack();
    const selected = action as { block_id?: string; selected_option?: { value: string } };
    const intakeId = selected.block_id?.replace(/^intake:/, "");
    const source = intakeId ? pendingSources.get(intakeId) : undefined;
    if (!source || !selected.selected_option) {
      await respond({ replace_original: true, text: "This model-selection prompt expired. Post or mention the source again." });
      return;
    }
    try {
      const model = ModelSelectionSchema.parse(JSON.parse(selected.selected_option.value));
      await respond({ replace_original: true, text: `⏳ ${model.provider}/${model.model} is reading the source and current Linear issue graph…` });
      const { proposal, created } = await service.propose(source, model);
      pendingSources.delete(intakeId!);
      await respond({
        replace_original: true,
        text: created ? `Handover proposal: ${proposal.analysis.summary}` : "This source/model pair was already analyzed; here is the existing proposal.",
        blocks: proposalBlocks(proposal),
      });
    } catch (error) {
      logger.error(error);
      await respond({ replace_original: true, text: `Model analysis failed: ${String(error)}\nPost the source again to choose another model.` });
    }
  });

  app.action("handover_approve", async ({ ack, body, action, respond, logger }) => {
    await ack();
    try {
      const proposal = await service.approve((action as { value: string }).value, body.user.id);
      const result = proposal.status === "approved"
        ? `✅ Approved by <@${body.user.id}>. Applied: ${proposal.appliedIssueIdentifiers.join(", ") || "no writable changes"}.`
        : `⚠️ Application failed after: ${proposal.appliedIssueIdentifiers.join(", ") || "no changes"}. ${proposal.error}`;
      await respond({ replace_original: true, text: result });
    } catch (error) {
      logger.error(error);
      await respond({ response_type: "ephemeral", text: `Approval failed: ${String(error)}` });
    }
  });

  app.action("handover_create_anyway", async ({ ack, body, action, respond, logger }) => {
    await ack();
    try {
      const proposal = await service.createAnyway((action as { value: string }).value, body.user.id);
      const result = proposal.status === "approved"
        ? `✅ Override approved by <@${body.user.id}>. Created: ${proposal.appliedIssueIdentifiers.join(", ") || "no issues returned"}. Review warnings were copied into the task description.`
        : `⚠️ Override failed after: ${proposal.appliedIssueIdentifiers.join(", ") || "no changes"}. ${proposal.error}`;
      await respond({ replace_original: true, text: result });
    } catch (error) {
      logger.error(error);
      await respond({ response_type: "ephemeral", text: `Create-anyway failed: ${String(error)}` });
    }
  });

  app.action("handover_dismiss", async ({ ack, body, action, respond }) => {
    await ack();
    await service.dismiss((action as BlockAction["actions"][number] & { value: string }).value, body.user.id);
    await respond({ replace_original: true, text: `Dismissed by <@${body.user.id}>. No Linear changes were made.` });
  });

  return app;
}
