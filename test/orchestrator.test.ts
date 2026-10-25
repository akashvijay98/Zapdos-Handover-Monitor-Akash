import assert from "node:assert/strict";
import test from "node:test";
import { chronologicalView, createBoardTools, dependencyNeighborhoodFor, semanticMatches, sourceTimelineFor } from "../src/orchestrator.js";
import type { LinearIssue, SourceEvent } from "../src/types.js";

function issue(identifier: string, title: string, overrides: Partial<LinearIssue> = {}): LinearIssue {
  return { id: identifier, identifier, title, description: "", status: "Todo", assignee: null, dueDate: null, priority: 0, url: `https://linear.example/${identifier}`, blocks: [], blockedBy: [], related: [], ...overrides };
}

test("ReAct board tools are read-only semantic, dependency, and chronology inspectors", () => {
  const tools = createBoardTools([issue("ZAP-1", "Finalize attendee list")]);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "semantic_search_tasks",
    "inspect_dependency_neighborhood",
    "inspect_chronological_board",
    "inspect_source_timeline",
  ]);
});

test("semantic search connects workflow meaning despite different task titles", () => {
  const issues = [
    issue("ZAP-18", "Finalize annual retreat attendee list", { description: "Confirm dietary requirements and room needs." }),
    issue("ZAP-40", "Refactor API client"),
  ];
  const matches = semanticMatches("Book travel and accommodation for attendees", issues);
  assert.equal(matches[0]?.issue.identifier, "ZAP-18");
  assert.ok((matches[0]?.score ?? 0) > (matches[1]?.score ?? 0));
});

test("dependency inspection expands the graph without inventing missing issues", () => {
  const issues = [
    issue("ZAP-1", "First", { blocks: ["ZAP-2"] }),
    issue("ZAP-2", "Second", { blockedBy: ["ZAP-1"], blocks: ["ZAP-3"] }),
    issue("ZAP-3", "Third", { blockedBy: ["ZAP-2"] }),
  ];
  const result = dependencyNeighborhoodFor(["ZAP-1", "ZAP-404"], 2, new Map(issues.map((value) => [value.identifier, value])));
  assert.deepEqual(result.issues.map((value) => value.identifier), ["ZAP-1", "ZAP-2", "ZAP-3"]);
  assert.deepEqual(result.missing, ["ZAP-404"]);
});

test("chronological inspection exposes deadline inversions", () => {
  const issues = [
    issue("ZAP-1", "Launch compliance review", { dueDate: "2026-11-07", blocks: ["ZAP-2"] }),
    issue("ZAP-2", "Launch release", { dueDate: "2026-11-03", blockedBy: ["ZAP-1"] }),
  ];
  const result = chronologicalView(["launch"], issues);
  assert.deepEqual(result.issues.map((value) => value.identifier), ["ZAP-2", "ZAP-1"]);
  assert.match(result.deadlineConflicts[0]?.reason ?? "", /after ZAP-2 is due/);
});

test("source timeline returns semantically relevant events in occurred order", () => {
  const history: SourceEvent[] = [
    { id: "later", kind: "slack_message", title: "Catering update", body: "Catering headcount is 80 people", occurredAt: "2026-10-25T12:00:00Z", slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" },
    { id: "unrelated", kind: "email", title: "Camera layout", body: "Please update camera three", occurredAt: "2026-10-23T12:00:00Z", slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" },
    { id: "earlier", kind: "call_note", title: "Catering plan", body: "Catering headcount is 60 people", occurredAt: "2026-10-24T12:00:00Z", slackChannel: "C1", slackThreadTs: null, submittedBy: "U1" },
  ];
  assert.deepEqual(sourceTimelineFor(["catering", "headcount"], history).map((source) => source.id), ["earlier", "later"]);
});
