import type { KnownBlock } from "@slack/types";
import type { StoredProposal } from "./types.js";

const priorityEmoji = { urgent: "🔴", high: "🟠", normal: "🟡", low: "🔵", none: "⚪" };

function list(label: string, values: string[]): string {
  return values.length ? `*${label}:* ${values.join(", ")}` : `*${label}:* None`;
}

export function proposalBlocks(proposal: StoredProposal): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🤖 Handover suggestions", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: proposal.analysis.summary } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Source: *${proposal.source.title}* · Model: *${proposal.model.provider}/${proposal.model.model}* · No Linear changes have been made.` }] },
    { type: "divider" },
  ];

  for (const change of proposal.analysis.changes) {
    const target = change.existingIssueIdentifier ? ` — ${change.existingIssueIdentifier}` : "";
    const text = [
      `${priorityEmoji[change.priority]} *${change.action.toUpperCase()}${target}: ${change.title}*`,
      change.rationale,
      list("Blocked by", change.blockedBy),
      list("Blocks", change.blocks),
      list("Related", change.relatedIssues),
      list("Blockers", change.blockers),
      change.conflicts.length ? `*Conflicts:* ${change.conflicts.map((c) => `${c.issueIdentifier}: ${c.reason}`).join("; ")}` : "*Conflicts:* None",
      change.ownerQuestion ? `*Owner decision needed:* ${change.ownerQuestion}` : "",
      `*Evidence:* ${change.evidence.join("; ")}`,
    ].filter(Boolean).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text } }, { type: "divider" });
  }

  const hasWritable = proposal.analysis.changes.some((c) => c.action === "create" || c.action === "update");
  const hasSuggestion = proposal.analysis.changes.length > 0;
  blocks.push({
    type: "actions",
    block_id: `proposal:${proposal.id}`,
    elements: [
      ...(hasWritable ? [{ type: "button" as const, action_id: "handover_approve", style: "primary" as const, text: { type: "plain_text" as const, text: "Approve Linear changes" }, value: proposal.id, confirm: { title: { type: "plain_text" as const, text: "Apply changes?" }, text: { type: "mrkdwn" as const, text: "This will create/update the listed Linear issues and relations." }, confirm: { type: "plain_text" as const, text: "Apply" }, deny: { type: "plain_text" as const, text: "Cancel" } } }] : []),
      ...(hasSuggestion ? [{ type: "button" as const, action_id: "handover_create_anyway", text: { type: "plain_text" as const, text: "Create task anyway" }, value: proposal.id, confirm: { title: { type: "plain_text" as const, text: "Create despite warnings?" }, text: { type: "mrkdwn" as const, text: "This creates new Linear task(s) even when conflicts, blockers, duplicates, or open decisions were detected. Review notes will be preserved in the description." }, confirm: { type: "plain_text" as const, text: "Create anyway" }, deny: { type: "plain_text" as const, text: "Cancel" } } }] : []),
      { type: "button", action_id: "handover_dismiss", style: "danger", text: { type: "plain_text", text: "Dismiss" }, value: proposal.id },
    ],
  });
  return blocks;
}
