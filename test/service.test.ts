import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HandoverAnalyzer } from "../src/analyzer.js";
import type { IssueTracker } from "../src/linear.js";
import { HandoverService } from "../src/service.js";
import { ProposalStore } from "../src/store.js";
import type { AnalysisResult, LinearIssue, ModelSelection, ProposedChange, SourceEvent } from "../src/types.js";

const source: SourceEvent = { id: "E1", kind: "email", title: "Customer follow-up", body: "Price is overdue", occurredAt: null, slackChannel: "C1", slackThreadTs: "1", submittedBy: "U1" };
const change: ProposedChange = { localId: "c1", action: "update", existingIssueIdentifier: "ZAP-102", title: "Northwind price", rationale: "Customer followed up", evidence: ["Price is overdue"], assignee: null, dueDate: null, priority: "high", description: "Follow up", changedFields: ["description", "priority"], blockedBy: ["ZAP-200"], blocks: [], relatedIssues: ["ZAP-101"], conflicts: [], blockers: ["Camera model needs verification"], ownerQuestion: null, risk: "medium" };
const analysis: AnalysisResult = { summary: "One update", changes: [change] };
const model: ModelSelection = { provider: "ollama", model: "qwen3:8b" };

class FakeTracker implements IssueTracker {
  applied: ProposedChange[] = [];
  async listIssueGraph(): Promise<LinearIssue[]> { return []; }
  async applyChange(value: ProposedChange): Promise<string | null> { this.applied.push(value); return value.existingIssueIdentifier; }
}
const analyzer: HandoverAnalyzer = { async analyze() { return analysis; } };

test("analysis never writes to Linear before approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handover-"));
  const tracker = new FakeTracker();
  const service = new HandoverService(tracker, analyzer, new ProposalStore(join(dir, "store.json")));
  const { proposal } = await service.propose(source, model);
  assert.equal(tracker.applied.length, 0);
  assert.equal(proposal.status, "pending");
  await service.approve(proposal.id, "U1");
  assert.equal(tracker.applied.length, 1);
});

test("source idempotency prevents duplicate proposals and writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handover-"));
  const tracker = new FakeTracker();
  const service = new HandoverService(tracker, analyzer, new ProposalStore(join(dir, "store.json")));
  const first = await service.propose(source, model);
  const second = await service.propose(source, model);
  assert.equal(second.created, false);
  assert.equal(first.proposal.id, second.proposal.id);
  await service.approve(first.proposal.id, "U1");
  await service.approve(first.proposal.id, "U1");
  assert.equal(tracker.applied.length, 1);
});

test("the same source can be analyzed independently with another model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handover-"));
  const service = new HandoverService(new FakeTracker(), analyzer, new ProposalStore(join(dir, "store.json")));
  const local = await service.propose(source, model);
  const hosted = await service.propose(source, { provider: "openai", model: "gpt-5-mini" });
  assert.equal(local.created, true);
  assert.equal(hosted.created, true);
  assert.notEqual(local.proposal.id, hosted.proposal.id);
  assert.deepEqual(hosted.proposal.model, { provider: "openai", model: "gpt-5-mini" });
});

test("dismissal performs no write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handover-"));
  const tracker = new FakeTracker();
  const service = new HandoverService(tracker, analyzer, new ProposalStore(join(dir, "store.json")));
  const { proposal } = await service.propose(source, model);
  const result = await service.dismiss(proposal.id, "U1");
  assert.equal(result.status, "dismissed");
  assert.equal(tracker.applied.length, 0);
});

test("explicit override creates a task from a needs-owner-decision proposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handover-override-"));
  const tracker = new FakeTracker();
  const decision: ProposedChange = {
    ...change,
    action: "needs_owner_decision",
    existingIssueIdentifier: null,
    title: "Book attendee travel",
    conflicts: [{ issueIdentifier: "ZAP-18", reason: "Attendee list is unfinished" }],
    ownerQuestion: "Who owns this task?",
  };
  const decisionAnalyzer: HandoverAnalyzer = { async analyze() { return { summary: "Decision required", changes: [decision] }; } };
  const service = new HandoverService(tracker, decisionAnalyzer, new ProposalStore(join(dir, "store.json")));
  const { proposal } = await service.propose({ ...source, id: "override-source" }, model);
  const result = await service.createAnyway(proposal.id, "U2");
  assert.equal(result.status, "approved");
  assert.equal(tracker.applied.length, 1);
  assert.equal(tracker.applied[0]?.action, "create");
  assert.equal(tracker.applied[0]?.existingIssueIdentifier, null);
  assert.match(tracker.applied[0]?.description ?? "", /Created via explicit Slack override/);
  assert.match(tracker.applied[0]?.description ?? "", /Attendee list is unfinished/);
});
