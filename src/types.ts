import { z } from "zod";

export const SourceEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["call_note", "email", "slack_message", "unknown"]),
  title: z.string(),
  body: z.string(),
  occurredAt: z.string().nullable(),
  slackChannel: z.string(),
  slackThreadTs: z.string().nullable(),
  submittedBy: z.string(),
});
export type SourceEvent = z.infer<typeof SourceEventSchema>;

export const ModelSelectionSchema = z.object({
  provider: z.enum(["openai", "ollama"]),
  model: z.string().min(1),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const LinearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: z.number(),
  url: z.string(),
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  related: z.array(z.string()),
});
export type LinearIssue = z.infer<typeof LinearIssueSchema>;

const NullableString = z.string().nullable();

export const ProposedChangeSchema = z.object({
  localId: z.string(),
  action: z.enum(["create", "update", "no_action", "needs_owner_decision"]),
  existingIssueIdentifier: NullableString,
  title: z.string(),
  rationale: z.string(),
  evidence: z.array(z.string()),
  assignee: NullableString,
  dueDate: NullableString,
  priority: z.enum(["urgent", "high", "normal", "low", "none"]),
  description: z.string(),
  changedFields: z.array(z.string()),
  blockedBy: z.array(z.string()),
  blocks: z.array(z.string()),
  relatedIssues: z.array(z.string()),
  conflicts: z.array(z.object({ issueIdentifier: z.string(), reason: z.string() })),
  blockers: z.array(z.string()),
  ownerQuestion: NullableString,
  risk: z.enum(["low", "medium", "high"]),
});
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;

export const AnalysisResultSchema = z.object({
  summary: z.string(),
  changes: z.array(ProposedChangeSchema),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const StoredProposalSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["pending", "approved", "dismissed", "failed"]),
  source: SourceEventSchema,
  model: ModelSelectionSchema,
  analysis: AnalysisResultSchema,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  appliedIssueIdentifiers: z.array(z.string()),
  error: z.string().nullable(),
});
export type StoredProposal = z.infer<typeof StoredProposalSchema>;
