import assert from "node:assert/strict";
import test from "node:test";
import { enrichContextMatches, guardDependencyCycles, guardGrounding } from "../src/dependencies.js";
import type { AnalysisResult, LinearIssue, ProposedChange, SourceEvent } from "../src/types.js";

function issue(identifier: string, blocks: string[] = []): LinearIssue {
  return { id: identifier, identifier, title: identifier, description: "", status: "Todo", assignee: null, dueDate: null, priority: 0, url: "https://linear.example", blocks, blockedBy: [], related: [] };
}

function change(overrides: Partial<ProposedChange>): ProposedChange {
  return { localId: "c1", action: "update", existingIssueIdentifier: "ZAP-2", title: "Connect tools", rationale: "Meeting context", evidence: ["Tools need imported data"], assignee: null, dueDate: null, priority: "normal", description: "", changedFields: [], blockedBy: [], blocks: [], relatedIssues: [], conflicts: [], blockers: [], ownerQuestion: null, risk: "low", ...overrides };
}

test("marks a proposed relation as owner-decision when it closes a dependency cycle", () => {
  const analysis: AnalysisResult = { summary: "Dependency proposal", changes: [change({ blocks: ["ZAP-3"] }), change({ localId: "c2", existingIssueIdentifier: "ZAP-3", title: "Import data", blocks: ["ZAP-2"] })] };
  const guarded = guardDependencyCycles(analysis, [issue("ZAP-2"), issue("ZAP-3")]);
  assert.equal(guarded.changes[1]?.action, "needs_owner_decision");
  assert.match(guarded.changes[1]?.conflicts[0]?.reason ?? "", /circular dependency/);
});

test("detects a cycle against relations already stored in Linear", () => {
  const analysis: AnalysisResult = { summary: "Dependency proposal", changes: [change({ existingIssueIdentifier: "ZAP-3", blocks: ["ZAP-2"] })] };
  const guarded = guardDependencyCycles(analysis, [issue("ZAP-2", ["ZAP-3"]), issue("ZAP-3")]);
  assert.equal(guarded.changes[0]?.action, "needs_owner_decision");
});

test("vague subjects still load the matching issue dependency context", () => {
  const source: SourceEvent = { id: "slack:1", kind: "slack_message", title: "Checkout Flow Redesign", body: "Checkout Flow Redesign", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const checkout = { ...issue("ZAP-20", ["ZAP-22"]), title: "Redesign checkout flow", blockedBy: ["ZAP-19"], related: ["ZAP-21"] };
  const result = enrichContextMatches({ summary: "No explicit commitment", changes: [] }, source, [checkout, issue("ZAP-19"), issue("ZAP-21"), issue("ZAP-22")]);
  assert.equal(result.changes[0]?.existingIssueIdentifier, "ZAP-20");
  assert.deepEqual(result.changes[0]?.blockedBy, ["ZAP-19"]);
  assert.deepEqual(result.changes[0]?.blocks, ["ZAP-22"]);
  assert.deepEqual(result.changes[0]?.relatedIssues, ["ZAP-21"]);
  assert.equal(result.changes[0]?.action, "no_action");
});

test("removes dates and dependencies invented from vague relative timing", () => {
  const source: SourceEvent = { id: "slack:2", kind: "slack_message", title: "Checkout delay", body: "Checkout needs to launch Friday, but the payment API is not ready until Monday. Compliance is pending.", occurredAt: "2026-10-24T12:00:00Z", slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const checkout = { ...issue("ZAP-11"), title: "Implement redesigned checkout", dueDate: "2026-11-17" };
  const compliance = { ...issue("ZAP-13"), title: "Complete checkout compliance review", description: "Compliance approval" };
  const migration = { ...issue("ZAP-14"), title: "Migrate legacy payment sessions", description: "Move legacy payment sessions" };
  const proposed = change({ existingIssueIdentifier: "ZAP-11", dueDate: "2026-11-20", priority: "urgent", changedFields: ["dueDate", "priority"], blockedBy: ["ZAP-13", "ZAP-14"] });
  const guarded = guardGrounding({ summary: "Checkout delay", changes: [proposed] }, source, [checkout, compliance, migration]);
  assert.equal(guarded.changes[0]?.dueDate, "2026-11-17");
  assert.deepEqual(guarded.changes[0]?.changedFields, []);
  assert.deepEqual(guarded.changes[0]?.blockedBy, ["ZAP-13"]);
  assert.equal(guarded.changes[0]?.priority, "none");
  assert.equal(guarded.changes[0]?.risk, "high");
});

test("does not propose unchanged fields and gates unresolved conflicts", () => {
  const source: SourceEvent = { id: "slack:3", kind: "call_note", title: "Retreat", body: "The invitation is due November 3 but sponsor approval is not available until November 7.", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const invitation = { ...issue("ZAP-17"), title: "Send retreat invitation", dueDate: "2026-11-03" };
  const sponsor = { ...issue("ZAP-16"), title: "Approve sponsor artwork for retreat invitation", dueDate: "2026-11-07" };
  const proposed = change({ existingIssueIdentifier: "ZAP-17", title: invitation.title, dueDate: "2026-11-03", changedFields: ["title", "dueDate"], blockedBy: ["ZAP-16"], conflicts: [{ issueIdentifier: "ZAP-16", reason: "Approval follows invitation deadline" }], ownerQuestion: "Delay or remove artwork?" });
  const guarded = guardGrounding({ summary: "Conflict", changes: [proposed] }, source, [invitation, sponsor]);
  assert.deepEqual(guarded.changes[0]?.changedFields, []);
  assert.equal(guarded.changes[0]?.action, "needs_owner_decision");
});

test("allows grounded task creation while stripping invented metadata", () => {
  const source: SourceEvent = { id: "call:4", kind: "call_note", title: "Retreat follow-up", body: "Maya will call three alternative venues by November 8.", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const proposed = change({ localId: "new-venue-calls", action: "create", existingIssueIdentifier: null, title: "Call three alternative retreat venues", description: "Contact three alternative venues.", evidence: ["Maya will call three alternative venues by November 8."], dueDate: "2026-11-08", assignee: null, priority: "urgent", changedFields: [] });
  const guarded = guardGrounding({ summary: "New commitment", changes: [proposed] }, source, []);
  assert.equal(guarded.changes[0]?.action, "create");
  assert.equal(guarded.changes[0]?.dueDate, "2026-11-08");
  assert.equal(guarded.changes[0]?.priority, "none");
});

test("gates likely duplicate task creation for owner review", () => {
  const source: SourceEvent = { id: "call:5", kind: "call_note", title: "Retreat", body: "We need to finalize the retreat attendee list.", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const existing = { ...issue("ZAP-18"), title: "Finalize annual retreat attendee list", description: "Confirm attendee names" };
  const proposed = change({ localId: "new-list", action: "create", existingIssueIdentifier: null, title: "Finalize annual retreat attendee list", description: "Confirm attendee names", evidence: [source.body], changedFields: [] });
  const guarded = guardGrounding({ summary: "Possible task", changes: [proposed] }, source, [existing]);
  assert.equal(guarded.changes[0]?.action, "needs_owner_decision");
  assert.deepEqual(guarded.changes[0]?.relatedIssues, ["ZAP-18"]);
});

test("allows problem-derived task creation without inventing a due date", () => {
  const source: SourceEvent = { id: "call:6", kind: "call_note", title: "Customer feedback", body: "Customers keep losing their discount code when they return to checkout. We need to understand why.", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const proposed = change({ localId: "investigate-coupon", action: "create", existingIssueIdentifier: null, title: "Investigate lost checkout discount codes", description: "Determine why returning customers lose an entered discount code.", evidence: [source.body], dueDate: "2026-12-01", assignee: null, priority: "high", changedFields: ["dueDate", "priority"] });
  const guarded = guardGrounding({ summary: "New customer problem", changes: [proposed] }, source, []);
  assert.equal(guarded.changes[0]?.action, "create");
  assert.equal(guarded.changes[0]?.dueDate, null);
  assert.equal(guarded.changes[0]?.priority, "none");
  assert.deepEqual(guarded.changes[0]?.conflicts, []);
  assert.equal(guarded.changes[0]?.ownerQuestion, null);
});

test("flags a requested headcount that conflicts with an existing capacity", () => {
  const source: SourceEvent = { id: "slack:7", kind: "slack_message", title: "Generate Catering Bill for 80 People", body: "Generate Catering Bill for 80 People", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const capacity = { ...issue("ZAP-21"), title: "Confirm annual retreat venue capacity", description: "Current provisional capacity is 60 people." };
  const proposed = change({ localId: "catering-bill", action: "create", existingIssueIdentifier: null, title: "Generate Catering Bill for 80 People", description: "Generate a catering bill for 80 people.", evidence: [source.body] });
  const guarded = guardGrounding({ summary: "Catering request", changes: [proposed] }, source, [capacity]);
  assert.equal(guarded.changes[0]?.action, "needs_owner_decision");
  assert.deepEqual(guarded.changes[0]?.relatedIssues, ["ZAP-21"]);
  assert.match(guarded.changes[0]?.conflicts[0]?.reason ?? "", /80.*60 people/);
  assert.match(guarded.changes[0]?.ownerQuestion ?? "", /approved capacity changed to 80/);
  assert.equal(guarded.changes[0]?.risk, "high");
});

test("blocks a downstream catering bill while earlier retreat tasks are unfinished", () => {
  const source: SourceEvent = { id: "slack:8", kind: "slack_message", title: "Generate catering bill for 80 people", body: "Generate catering bill for 80 people", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const issues = [
    { ...issue("ZAP-17"), title: "Send annual retreat invitations", status: "Backlog" },
    { ...issue("ZAP-18"), title: "Finalize annual retreat attendee list", description: "Confirm dietary requirements.", status: "Todo" },
    { ...issue("ZAP-19"), title: "Submit final catering headcount", description: "Give the caterer the final guest count.", status: "Backlog" },
    { ...issue("ZAP-21"), title: "Confirm annual retreat venue capacity", description: "Current provisional capacity is 60 people.", status: "Backlog" },
  ];
  const proposed = change({ localId: "catering-bill", action: "create", existingIssueIdentifier: null, title: "Generate catering bill for 80 people", description: "Generate a catering bill for 80 people.", evidence: [source.body], blockedBy: ["ZAP-21"] });
  const guarded = guardGrounding({ summary: "Catering request", changes: [proposed] }, source, issues);
  const result = guarded.changes[0]!;
  assert.equal(result.action, "needs_owner_decision");
  assert.deepEqual(result.blockedBy.sort(), ["ZAP-17", "ZAP-18", "ZAP-19", "ZAP-21"]);
  assert.ok(result.conflicts.some((conflict) => conflict.issueIdentifier === "ZAP-19" && /still Backlog/.test(conflict.reason)));
  assert.doesNotMatch(result.conflicts.map((conflict) => conflict.reason).join(" "), /not grounded/);
  assert.match(result.ownerQuestion ?? "", /wait until/);
});

test("accepts and checks the attendee-list prerequisite before booking travel", () => {
  const source: SourceEvent = { id: "slack:9", kind: "slack_message", title: "Book travel and accommodation for attendees", body: "Book travel and accommodation for attendees", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const issues = [
    { ...issue("ZAP-17"), title: "Send annual retreat invitations", status: "Backlog" },
    { ...issue("ZAP-18"), title: "Finalize annual retreat attendee list", description: "Confirm the final employee attendee list and room needs.", status: "Todo" },
    { ...issue("ZAP-21"), title: "Confirm annual retreat venue capacity", status: "Backlog" },
  ];
  const proposed = change({ localId: "book-travel", action: "create", existingIssueIdentifier: null, title: "Book travel and accommodation for attendees", description: "Arrange attendee travel and accommodation.", evidence: [source.body], blockedBy: ["ZAP-18"] });
  const guarded = guardGrounding({ summary: "Travel request", changes: [proposed] }, source, issues);
  const result = guarded.changes[0]!;
  assert.equal(result.action, "needs_owner_decision");
  assert.ok(result.blockedBy.includes("ZAP-18"));
  assert.ok(result.blockedBy.includes("ZAP-17"));
  assert.ok(result.conflicts.some((conflict) => conflict.issueIdentifier === "ZAP-18" && /still Todo/.test(conflict.reason)));
  assert.doesNotMatch(result.conflicts.map((conflict) => conflict.reason).join(" "), /not grounded/);
  assert.match(result.ownerQuestion ?? "", /wait until/);
});

test("checks workflow prerequisites when a new task already needs an owner decision", () => {
  const source: SourceEvent = { id: "slack:10", kind: "slack_message", title: "attendees", body: "Book travel and accommodation for attendees", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const issues = [
    { ...issue("ZAP-17"), title: "Send annual retreat invitations", status: "Backlog" },
    { ...issue("ZAP-18"), title: "Finalize annual retreat attendee list", description: "Confirm the final employee attendee list and room needs.", status: "Todo" },
    { ...issue("ZAP-21"), title: "Confirm annual retreat venue capacity", status: "Backlog" },
  ];
  const proposed = change({
    localId: "book-travel",
    action: "needs_owner_decision",
    existingIssueIdentifier: null,
    title: "attendees",
    description: "Book travel and accommodation for attendees.",
    evidence: [source.body],
    relatedIssues: ["ZAP-18", "ZAP-17", "ZAP-21"],
    ownerQuestion: "Who should own this task?",
  });
  const result = guardGrounding({ summary: "Travel request", changes: [proposed] }, source, issues).changes[0]!;
  assert.equal(result.action, "needs_owner_decision");
  assert.deepEqual(result.blockedBy.sort(), ["ZAP-17", "ZAP-18", "ZAP-21"]);
  assert.ok(result.conflicts.some((conflict) => conflict.issueIdentifier === "ZAP-18"));
  assert.doesNotMatch(result.conflicts.map((conflict) => conflict.reason).join(" "), /not grounded/);
  assert.match(result.ownerQuestion ?? "", /Who should own this task.*wait until/s);
});

test("blocks a start-day welcome email while onboarding tasks are unfinished", () => {
  const source: SourceEvent = { id: "slack:11", kind: "slack_message", title: "Send welcome email with start-day instructions", body: "Send welcome email with start-day instructions for the candidate", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const issues = [
    { ...issue("ZAP-23"), title: "Get signed offer letter back from candidate", status: "Backlog" },
    { ...issue("ZAP-24"), title: "Complete background check", status: "Backlog" },
    { ...issue("ZAP-25"), title: "Order laptop for new hire", status: "Backlog" },
    { ...issue("ZAP-26"), title: "Reserve desk and badge access", status: "Backlog" },
    { ...issue("ZAP-27"), title: "Schedule first-week meetings with team", status: "Backlog" },
  ];
  const proposed = change({ localId: "welcome-email", action: "create", existingIssueIdentifier: null, title: "Send welcome email with start-day instructions for the candidate", description: "Send the candidate their start-day instructions.", evidence: [source.body] });
  const result = guardGrounding({ summary: "Welcome email", changes: [proposed] }, source, issues).changes[0]!;
  assert.equal(result.action, "needs_owner_decision");
  assert.deepEqual(result.blockedBy.sort(), ["ZAP-23", "ZAP-24", "ZAP-25", "ZAP-26", "ZAP-27"]);
  assert.equal(result.conflicts.length, 5);
  assert.ok(result.conflicts.every((conflict) => /still Backlog/.test(conflict.reason)));
  assert.match(result.ownerQuestion ?? "", /wait until ZAP-23, ZAP-24, ZAP-25, ZAP-26, ZAP-27/);
});

test("flags a dependency whose deadline comes after its dependent task", () => {
  const source: SourceEvent = { id: "slack:12", kind: "slack_message", title: "Prepare launch", body: "Prepare launch after compliance review", occurredAt: null, slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" };
  const launch = { ...issue("ZAP-30"), title: "Prepare launch", dueDate: "2026-11-03" };
  const compliance = { ...issue("ZAP-31"), title: "Complete launch compliance review", dueDate: "2026-11-07" };
  const proposed = change({ existingIssueIdentifier: "ZAP-30", title: launch.title, dueDate: launch.dueDate, blockedBy: ["ZAP-31"] });
  const result = guardGrounding({ summary: "Launch dependency", changes: [proposed] }, source, [launch, compliance]).changes[0]!;
  assert.equal(result.action, "needs_owner_decision");
  assert.match(result.conflicts.map((conflict) => conflict.reason).join(" "), /ZAP-31 is due 2026-11-07, after this dependent task is due 2026-11-03/);
  assert.equal(result.risk, "high");
});
