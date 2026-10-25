import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { DeadlineMonitor, DeadlineNotificationStore } from "../src/deadline-monitor.js";
import type { IssueTracker } from "../src/linear.js";
import type { LinearIssue } from "../src/types.js";

test("sends one reminder per issue, deadline, assignee, and warning window", async () => {
  const issue: LinearIssue = { id: "1", identifier: "ZAP-1", title: "Book venue", description: "", status: "Todo", assignee: "owner@example.com", dueDate: "2026-10-27", priority: 0, url: "https://linear.example/ZAP-1", blocks: [], blockedBy: [], related: [] };
  const tracker: IssueTracker = { async listIssueGraph() { return [issue]; }, async applyChange() { return null; } };
  const sent: unknown[] = [];
  const slack = {
    users: { async lookupByEmail() { return { user: { id: "U1" } }; } },
    conversations: { async open() { return { channel: { id: "D1" } }; } },
    chat: { async postMessage(value: unknown) { sent.push(value); return { ok: true }; } },
  } as unknown as WebClient;
  const dir = await mkdtemp(join(tmpdir(), "deadlines-"));
  const monitor = new DeadlineMonitor(tracker, slack, new DeadlineNotificationStore(join(dir, "sent.json")), [3, 1, 0], () => new Date("2026-10-24T12:00:00Z"));
  await monitor.run();
  await monitor.run();
  assert.equal(sent.length, 1);
});

test("groups deadlines and dependency risks into one daily assignee digest", async () => {
  const issues: LinearIssue[] = [
    { id: "1", identifier: "ZAP-1", title: "Ship launch", description: "", status: "Todo", assignee: "owner@example.com", dueDate: "2026-10-25", priority: 1, url: "https://linear.example/ZAP-1", blocks: [], blockedBy: ["ZAP-2"], related: [] },
    { id: "2", identifier: "ZAP-2", title: "Approve copy", description: "", status: "In Progress", assignee: "reviewer@example.com", dueDate: null, priority: 2, url: "https://linear.example/ZAP-2", blocks: ["ZAP-1"], blockedBy: [], related: [] },
  ];
  const tracker: IssueTracker = { async listIssueGraph() { return issues; }, async applyChange() { return null; } };
  const sent: Array<{ channel: string; text: string }> = [];
  const slack = {
    users: { async lookupByEmail({ email }: { email: string }) { return { user: { id: email } }; } },
    conversations: { async open({ users }: { users: string }) { return { channel: { id: users } }; } },
    chat: { async postMessage(value: { channel: string; text: string }) { sent.push(value); return { ok: true }; } },
  } as unknown as WebClient;
  const dir = await mkdtemp(join(tmpdir(), "daily-digest-"));
  const monitor = new DeadlineMonitor(tracker, slack, new DeadlineNotificationStore(join(dir, "sent.json")), [7, 3, 1, 0], () => new Date("2026-10-24T12:00:00Z"));
  const result = await monitor.run();
  assert.equal(result.sent, 2);
  assert.equal(sent.length, 2);
  assert.match(sent.find((item) => item.channel === "owner@example.com")?.text ?? "", /Blocked by ZAP-2/);
  assert.match(sent.find((item) => item.channel === "reviewer@example.com")?.text ?? "", /Blocking ZAP-1/);
});

test("includes overdue work and ignores completed dependencies", async () => {
  const issues: LinearIssue[] = [
    { id: "1", identifier: "ZAP-1", title: "Late task", description: "", status: "Todo", assignee: "owner@example.com", dueDate: "2026-10-20", priority: 1, url: "https://linear.example/ZAP-1", blocks: [], blockedBy: ["ZAP-2"], related: [] },
    { id: "2", identifier: "ZAP-2", title: "Finished prerequisite", description: "", status: "Done", assignee: "owner@example.com", dueDate: null, priority: 2, url: "https://linear.example/ZAP-2", blocks: ["ZAP-1"], blockedBy: [], related: [] },
  ];
  const tracker: IssueTracker = { async listIssueGraph() { return issues; }, async applyChange() { return null; } };
  const sent: Array<{ text: string }> = [];
  const slack = {
    users: { async lookupByEmail() { return { user: { id: "U1" } }; } },
    conversations: { async open() { return { channel: { id: "D1" } }; } },
    chat: { async postMessage(value: { text: string }) { sent.push(value); return { ok: true }; } },
  } as unknown as WebClient;
  const dir = await mkdtemp(join(tmpdir(), "overdue-digest-"));
  const monitor = new DeadlineMonitor(tracker, slack, new DeadlineNotificationStore(join(dir, "sent.json")), [3, 1, 0], () => new Date("2026-10-24T12:00:00Z"));
  await monitor.run();
  assert.match(sent[0]?.text ?? "", /Overdue by 4 days/);
  assert.doesNotMatch(sent[0]?.text ?? "", /Blocked by/);
});

test("includes an assigned pending task without a deadline or dependency", async () => {
  const issue: LinearIssue = { id: "1", identifier: "ZAP-1", title: "Write documentation", description: "", status: "Todo", assignee: "owner@example.com", dueDate: null, priority: 3, url: "https://linear.example/ZAP-1", blocks: [], blockedBy: [], related: [] };
  const tracker: IssueTracker = { async listIssueGraph() { return [issue]; }, async applyChange() { return null; } };
  const sent: Array<{ text: string }> = [];
  const slack = {
    users: { async lookupByEmail() { return { user: { id: "U1" } }; } },
    conversations: { async open() { return { channel: { id: "D1" } }; } },
    chat: { async postMessage(value: { text: string }) { sent.push(value); return { ok: true }; } },
  } as unknown as WebClient;
  const dir = await mkdtemp(join(tmpdir(), "pending-digest-"));
  const monitor = new DeadlineMonitor(tracker, slack, new DeadlineNotificationStore(join(dir, "sent.json")), [7, 3, 1, 0], () => new Date("2026-10-24T12:00:00Z"));
  await monitor.run();
  assert.match(sent[0]?.text ?? "", /ZAP-1/);
  assert.match(sent[0]?.text ?? "", /No due date/);
});

test("reports direct blockers, transitive impact, related work, and dependency date conflicts", async () => {
  const issues: LinearIssue[] = [
    { id: "1", identifier: "ZAP-1", title: "User task", description: "", status: "Todo", assignee: "owner@example.com", dueDate: "2026-10-27", priority: 1, url: "https://linear.example/ZAP-1", blocks: ["ZAP-2"], blockedBy: ["ZAP-4"], related: ["ZAP-5"] },
    { id: "2", identifier: "ZAP-2", title: "Directly affected", description: "", status: "Todo", assignee: "other@example.com", dueDate: "2026-10-26", priority: 2, url: "https://linear.example/ZAP-2", blocks: ["ZAP-3"], blockedBy: ["ZAP-1"], related: [] },
    { id: "3", identifier: "ZAP-3", title: "Transitively affected", description: "", status: "Todo", assignee: null, dueDate: "2026-10-28", priority: 3, url: "https://linear.example/ZAP-3", blocks: [], blockedBy: ["ZAP-2"], related: [] },
    { id: "4", identifier: "ZAP-4", title: "Late prerequisite", description: "", status: "In Progress", assignee: "other@example.com", dueDate: "2026-10-29", priority: 1, url: "https://linear.example/ZAP-4", blocks: ["ZAP-1"], blockedBy: [], related: [] },
    { id: "5", identifier: "ZAP-5", title: "Related open task", description: "", status: "Backlog", assignee: null, dueDate: null, priority: 0, url: "https://linear.example/ZAP-5", blocks: [], blockedBy: [], related: ["ZAP-1"] },
  ];
  const tracker: IssueTracker = { async listIssueGraph() { return issues; }, async applyChange() { return null; } };
  const sent: Array<{ channel: string; text: string }> = [];
  const slack = {
    users: { async lookupByEmail({ email }: { email: string }) { return { user: { id: email } }; } },
    conversations: { async open({ users }: { users: string }) { return { channel: { id: users } }; } },
    chat: { async postMessage(value: { channel: string; text: string }) { sent.push(value); return { ok: true }; } },
  } as unknown as WebClient;
  const dir = await mkdtemp(join(tmpdir(), "impact-digest-"));
  const monitor = new DeadlineMonitor(tracker, slack, new DeadlineNotificationStore(join(dir, "sent.json")), [7, 3, 1, 0], () => new Date("2026-10-24T12:00:00Z"));
  await monitor.run();
  const digest = sent.find((item) => item.channel === "owner@example.com")?.text ?? "";
  assert.match(digest, /Blocked by ZAP-4/);
  assert.match(digest, /Blocking ZAP-2/);
  assert.match(digest, /Affects downstream ZAP-3/);
  assert.match(digest, /Related open work ZAP-5/);
  assert.match(digest, /ZAP-4 is due 2026-10-29, after this task's 2026-10-27 deadline/);
  assert.match(digest, /ZAP-2 is due 2026-10-26, before this prerequisite's 2026-10-27 deadline/);
});
