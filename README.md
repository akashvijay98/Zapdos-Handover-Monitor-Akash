# Approval-first Slack → Linear handover bot

This bot reads call notes, email text, and text/JSON/Markdown uploads posted in Slack. The user chooses an OpenAI or local Ollama Qwen model in Slack for each analysis. The selected model reads the current Linear issue graph, proposes creates or updates, and shows dependencies, dependents, conflicts, and blockers in Slack. **It cannot write to Linear until a user clicks “Approve Linear changes.”**

## What it does

- Accepts notes in a DM, an `@mention`, or an allowlisted channel.
- Automatically monitors new messages in allowlisted channels through Slack Events.
- Ingests completed Slack Huddle transcripts when Slack exposes their transcript file to the app.
- Downloads Slack text and JSON attachments using the bot token.
- Presents a Slack dropdown for the configured OpenAI and Ollama models.
- Reads current Linear issues and both directions of issue relations.
- Uses a LangChain ReAct orchestrator with read-only semantic-search, dependency-neighborhood, board-chronology, and prior-source-timeline tools.
- Uses OpenAI Structured Outputs to return a validated proposal.
- Posts a Block Kit review with create/update/no-action/owner-decision items.
- Applies creates, updates, and dependency relations only after confirmation.
- Offers a confirmed **Create task anyway** override for conflicts and owner-decision outcomes, preserving warnings in the new Linear issue description.
- Stores an audit record and source idempotency key in `.data/proposals.json`.
- Never auto-sends email, moves meetings, contacts customers, or makes payments.
- Optionally runs a deterministic daily task monitor that sends each assignee one Slack digest covering all pending tasks while highlighting approaching or overdue deadlines, upstream blockers, directly and transitively affected work, related open tasks, and dependency date conflicts—without invoking an LLM.

## Setup

1. Install dependencies: `npm install`
2. Install Ollama, then pull the local Qwen model: `ollama pull qwen3:8b`.
3. Copy `.env.example` to `.env` and fill in credentials. `OPENAI_API_KEY` is optional when only Ollama will be used. Configure comma-separated choices with `OPENAI_MODELS` and `OLLAMA_MODELS`.
4. Create a Slack app, enable Socket Mode and Interactivity, and add bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `files:read`
   - `im:history`
   - Add `channels:history` for allowlisted public channels.
   - Add `groups:history` for allowlisted private channels.
5. Subscribe the bot to `message.im`, `message.channels`, `message.groups`, and `file_shared` as applicable.
6. Create a Linear API key with read, create-issue, and write permissions. Set `LINEAR_TEAM_ID` to the team's UUID.
7. Ensure Ollama is running with `ollama serve`, then run `npm start`.

For the safest pilot, leave `ALLOWED_SLACK_CHANNEL_IDS` empty and use DMs or explicit mentions.

For automatic monitoring, set `ALLOWED_SLACK_CHANNEL_IDS` and `AUTO_ANALYZE_MODEL=ollama/qwen3:8b`. Invite the bot to each monitored channel. Every resulting Linear mutation remains approval-only.

## Deadline reminders

Enable scheduled checks with:

```env
DEADLINE_MONITOR_ENABLED=true
DEADLINE_MONITOR_INTERVAL_MINUTES=1440
DEADLINE_WARNING_DAYS=7,3,1,0
```

Add Slack scopes `users:read`, `users:read.email`, and `im:write`, then reinstall the app. Linear assignee email addresses must match Slack account emails. The monitor runs once at startup and then every 24 hours by default. It sends at most one digest to each assignee per UTC day, even after a restart. Every unfinished assigned task is included; `DEADLINE_WARNING_DAYS` determines the furthest approaching deadline to highlight (seven days by default), while overdue tasks and unresolved dependencies are always highlighted.

## Slack usage

Paste an email or call note in a DM:

```text
Subject: Re: Dock cameras
From: maria@customer.example
The price is overdue. Wei must verify the camera model before it is sent.
```

Or mention the bot and attach a `.txt`, `.md`, or `.json` file. The bot first asks which configured model to use. It then replies in the thread with a proposal labeled with its provider/model. Review the proposed writes and relation directions, then approve or dismiss.

## Safety model

`message/file → choose model in Slack → read Linear graph → structured proposal → Slack review → explicit approval → Linear mutations`

The proposal store is adequate for a single-process prototype. Before production, replace it with Postgres and use a transaction/outbox for applying multi-issue approvals atomically.

## Verification

```bash
npm run typecheck
npm test
```
