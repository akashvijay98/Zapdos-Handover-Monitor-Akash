import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { IssueTracker } from "./linear.js";
import type { LinearIssue } from "./types.js";

type NotificationRecord = { key: string; assignee: string; sentAt: string; issueIdentifiers?: string[] };
type TaskSummary = {
  issue: LinearIssue;
  daysUntilDue: number | null;
  dueIsNearing: boolean;
  unresolvedBlockers: LinearIssue[];
  blockedTasks: LinearIssue[];
  affectedTasks: LinearIssue[];
  relatedTasks: LinearIssue[];
  conflicts: string[];
};

export class DeadlineNotificationStore {
  constructor(private readonly path: string) {}

  async has(key: string): Promise<boolean> {
    return (await this.read()).some((record) => record.key === key);
  }

  async add(record: NotificationRecord): Promise<void> {
    const records = await this.read();
    if (records.some((item) => item.key === record.key)) return;
    records.push(record);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(records, null, 2));
    await rename(temporary, this.path);
  }

  private async read(): Promise<NotificationRecord[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as NotificationRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

/** Builds and sends one actionable task digest per Linear assignee. */
export class DeadlineMonitor {
  constructor(
    private readonly tracker: IssueTracker,
    private readonly slack: WebClient,
    private readonly store: DeadlineNotificationStore,
    private readonly warningDays: number[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<{ checked: number; sent: number; skipped: number }> {
    const issues = await this.tracker.listIssueGraph();
    const issueByIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
    const pending = issues.filter((issue) => !isFinished(issue));
    const maxWarningDays = Math.max(0, ...this.warningDays);
    const byAssignee = new Map<string, TaskSummary[]>();

    for (const issue of pending) {
      if (!issue.assignee?.includes("@")) continue;
      const days = daysUntil(issue.dueDate, this.now());
      const unresolvedBlockers = issue.blockedBy
        .map((identifier) => issueByIdentifier.get(identifier))
        .filter((candidate): candidate is LinearIssue => Boolean(candidate && !isFinished(candidate)));
      const blockedTasks = issue.blocks
        .map((identifier) => issueByIdentifier.get(identifier))
        .filter((candidate): candidate is LinearIssue => Boolean(candidate && !isFinished(candidate)));
      const allUpstream = walkOpenRelations(issue.blockedBy, issueByIdentifier, (candidate) => candidate.blockedBy);
      const allDownstream = walkOpenRelations(issue.blocks, issueByIdentifier, (candidate) => candidate.blocks);
      const directIds = new Set(blockedTasks.map((candidate) => candidate.identifier));
      const affectedTasks = allDownstream.filter((candidate) => !directIds.has(candidate.identifier));
      const relatedTasks = issue.related
        .map((identifier) => issueByIdentifier.get(identifier))
        .filter((candidate): candidate is LinearIssue => Boolean(candidate && !isFinished(candidate)));
      const conflicts = dependencyDateConflicts(issue, allUpstream, allDownstream);
      const summaries = byAssignee.get(issue.assignee) ?? [];
      summaries.push({
        issue,
        daysUntilDue: days,
        dueIsNearing: days !== null && days <= maxWarningDays,
        unresolvedBlockers: allUpstream.length ? allUpstream : unresolvedBlockers,
        blockedTasks,
        affectedTasks,
        relatedTasks,
        conflicts,
      });
      byAssignee.set(issue.assignee, summaries);
    }

    let sent = 0;
    let skipped = pending.length - [...byAssignee.values()].reduce((total, tasks) => total + tasks.length, 0);
    for (const [assignee, tasks] of byAssignee) {
      tasks.sort(compareTasks);
      const key = `${utcDay(this.now())}:${assignee.toLowerCase()}`;
      if (await this.store.has(key)) { skipped += tasks.length; continue; }
      try {
        const user = await this.slack.users.lookupByEmail({ email: assignee });
        if (!user.user?.id) { skipped += tasks.length; continue; }
        const conversation = await this.slack.conversations.open({ users: user.user.id });
        if (!conversation.channel?.id) { skipped += tasks.length; continue; }
        await this.slack.chat.postMessage({ channel: conversation.channel.id, text: digestMessage(tasks), blocks: digestBlocks(tasks) });
        await this.store.add({ key, assignee, sentAt: this.now().toISOString(), issueIdentifiers: tasks.map(({ issue }) => issue.identifier) });
        sent++;
      } catch {
        skipped += tasks.length;
      }
    }
    return { checked: issues.length, sent, skipped };
  }
}

export function startDeadlineMonitor(monitor: DeadlineMonitor, intervalMinutes: number, log: (message: string) => void): NodeJS.Timeout {
  const run = () => monitor.run()
    .then((result) => log(`Daily task monitor checked ${result.checked} issues; sent ${result.sent} assignee digests; skipped ${result.skipped} tasks`))
    .catch((error) => log(`Daily task monitor failed: ${String(error)}`));
  void run();
  return setInterval(run, intervalMinutes * 60_000);
}

function daysUntil(dueDate: string | null, now: Date): number | null {
  if (!dueDate) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  return Number.isNaN(due) ? null : Math.ceil((due - today) / 86_400_000);
}

function utcDay(now: Date): string { return now.toISOString().slice(0, 10); }
function isFinished(issue: LinearIssue): boolean { return /done|complete|cancel|closed/i.test(issue.status); }

function compareTasks(left: TaskSummary, right: TaskSummary): number {
  if (left.daysUntilDue === null && right.daysUntilDue === null) return left.issue.identifier.localeCompare(right.issue.identifier);
  if (left.daysUntilDue === null) return 1;
  if (right.daysUntilDue === null) return -1;
  return left.daysUntilDue - right.daysUntilDue;
}

function timing(days: number | null, dueDate: string | null): string {
  if (days === null || !dueDate) return "No due date";
  if (days < 0) return `Overdue by ${Math.abs(days)} day${days === -1 ? "" : "s"} · ${dueDate}`;
  if (days === 0) return `Due today · ${dueDate}`;
  return `Due in ${days} day${days === 1 ? "" : "s"} · ${dueDate}`;
}

function taskLine(task: TaskSummary): string {
  const deadline = timing(task.daysUntilDue, task.issue.dueDate);
  const details = [task.dueIsNearing ? `⚠️ ${deadline}` : deadline];
  if (task.unresolvedBlockers.length) details.push(`Blocked by ${task.unresolvedBlockers.map((issue) => issue.identifier).join(", ")}`);
  if (task.blockedTasks.length) details.push(`Blocking ${task.blockedTasks.map((issue) => issue.identifier).join(", ")}`);
  if (task.affectedTasks.length) details.push(`Affects downstream ${task.affectedTasks.map((issue) => issue.identifier).join(", ")}`);
  if (task.relatedTasks.length) details.push(`Related open work ${task.relatedTasks.map((issue) => issue.identifier).join(", ")}`);
  if (task.conflicts.length) details.push(`🚨 Conflicts: ${task.conflicts.join("; ")}`);
  return `• <${task.issue.url}|*${task.issue.identifier}*> ${task.issue.title}\n  ${details.join(" · ")}`;
}

function digestMessage(tasks: TaskSummary[]): string {
  const overdue = tasks.filter((task) => task.daysUntilDue !== null && task.daysUntilDue < 0).length;
  const blocked = tasks.filter((task) => task.unresolvedBlockers.length).length;
  const conflicting = tasks.filter((task) => task.conflicts.length).length;
  const affecting = new Set(tasks.flatMap((task) => [...task.blockedTasks, ...task.affectedTasks]).map((issue) => issue.identifier)).size;
  return `📋 *Your daily Linear task digest*\n${tasks.length} task${tasks.length === 1 ? "" : "s"} need attention${overdue ? ` · ${overdue} overdue` : ""}${blocked ? ` · ${blocked} blocked` : ""}${conflicting ? ` · ${conflicting} with conflicts` : ""}${affecting ? ` · ${affecting} downstream affected` : ""}.\n\n${tasks.map(taskLine).join("\n")}`;
}

function walkOpenRelations(
  startingIdentifiers: string[],
  issueByIdentifier: Map<string, LinearIssue>,
  next: (issue: LinearIssue) => string[],
): LinearIssue[] {
  const queue = [...startingIdentifiers];
  const seen = new Set<string>();
  const result: LinearIssue[] = [];
  while (queue.length) {
    const identifier = queue.shift()!;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const issue = issueByIdentifier.get(identifier);
    if (!issue || isFinished(issue)) continue;
    result.push(issue);
    queue.push(...next(issue));
  }
  return result;
}

function dependencyDateConflicts(issue: LinearIssue, upstream: LinearIssue[], downstream: LinearIssue[]): string[] {
  const conflicts: string[] = [];
  if (issue.dueDate) {
    for (const blocker of upstream) {
      if (blocker.dueDate && blocker.dueDate > issue.dueDate) {
        conflicts.push(`${blocker.identifier} is due ${blocker.dueDate}, after this task's ${issue.dueDate} deadline`);
      }
    }
  }
  for (const dependent of downstream) {
    if (issue.dueDate && dependent.dueDate && issue.dueDate > dependent.dueDate) {
      conflicts.push(`${dependent.identifier} is due ${dependent.dueDate}, before this prerequisite's ${issue.dueDate} deadline`);
    }
  }
  return [...new Set(conflicts)];
}

function digestBlocks(tasks: TaskSummary[]): KnownBlock[] {
  const visible = tasks.slice(0, 20);
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Your daily Linear task digest" } },
  ];
  for (const task of visible) blocks.push({ type: "section", text: { type: "mrkdwn", text: taskLine(task) } });
  if (tasks.length > visible.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Plus ${tasks.length - visible.length} more tasks. Open Linear to review the full list.` }] });
  return blocks;
}
