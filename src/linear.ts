import type { LinearIssue, ProposedChange, SourceEvent } from "./types.js";

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export interface IssueTracker {
  listIssueGraph(): Promise<LinearIssue[]>;
  applyChange(change: ProposedChange, source: SourceEvent): Promise<string | null>;
}

export class LinearClient implements IssueTracker {
  constructor(
    private readonly apiKey: string,
    private readonly teamId: string,
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Linear API HTTP ${response.status}: ${details.slice(0, 1000)}`);
    }
    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
    if (!payload.data) throw new Error("Linear API returned no data");
    return payload.data;
  }

  async listIssueGraph(): Promise<LinearIssue[]> {
    const query = `
      query TeamIssues($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 25, after: $after, includeArchived: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id identifier title description dueDate priority url
              state { name type }
              assignee { id name email }
              relations { nodes { type relatedIssue { identifier } } }
              inverseRelations { nodes { type issue { identifier } } }
            }
          }
        }
      }`;
    type Node = {
      id: string; identifier: string; title: string; description?: string; dueDate?: string;
      priority: number; url: string; state: { name: string }; assignee?: { id: string; name: string; email: string };
      relations: { nodes: Array<{ type: string; relatedIssue: { identifier: string } }> };
      inverseRelations: { nodes: Array<{ type: string; issue: { identifier: string } }> };
    };
    type Result = { team: { issues: { pageInfo: { hasNextPage: boolean; endCursor?: string }; nodes: Node[] } } };
    const all: Node[] = [];
    let after: string | undefined;
    do {
      const result: Result = await this.graphql<Result>(query, { teamId: this.teamId, after });
      all.push(...result.team.issues.nodes);
      after = result.team.issues.pageInfo.hasNextPage ? result.team.issues.pageInfo.endCursor : undefined;
    } while (after);

    return all.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      status: issue.state.name,
      assignee: issue.assignee?.email ?? issue.assignee?.id ?? null,
      dueDate: issue.dueDate ?? null,
      priority: issue.priority,
      url: issue.url,
      blocks: issue.relations.nodes.filter((r) => r.type === "blocks").map((r) => r.relatedIssue.identifier),
      blockedBy: issue.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => r.issue.identifier),
      related: [
        ...issue.relations.nodes.filter((r) => r.type === "related").map((r) => r.relatedIssue.identifier),
        ...issue.inverseRelations.nodes.filter((r) => r.type === "related").map((r) => r.issue.identifier),
      ],
    }));
  }

  async applyChange(change: ProposedChange, source: SourceEvent): Promise<string | null> {
    if (change.action === "no_action" || change.action === "needs_owner_decision") return null;
    const priority = { urgent: 1, high: 2, normal: 3, low: 4, none: 0 }[change.priority];
    const evidence = `\n\n---\nSource: ${source.kind} ${source.id} (${source.title})\nSubmitted in Slack by <@${source.submittedBy}>.`;
    let issueId: string;
    let identifier: string;

    if (change.action === "create") {
      const mutation = `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier } }
      }`;
      const data = await this.graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(mutation, {
        input: {
          teamId: this.teamId,
          title: change.title,
          description: change.description + evidence,
          priority,
          ...(change.dueDate ? { dueDate: change.dueDate } : {}),
          ...(change.assignee ? { assigneeId: await this.resolveAssigneeId(change.assignee) } : {}),
        },
      });
      if (!data.issueCreate.success) throw new Error(`Linear rejected creation of ${change.title}`);
      issueId = data.issueCreate.issue.id;
      identifier = data.issueCreate.issue.identifier;
    } else {
      if (!change.existingIssueIdentifier) throw new Error("Update proposal is missing an issue identifier");
      const mutation = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`;
      const input: Record<string, unknown> = {};
      if (change.changedFields.includes("title")) input.title = change.title;
      if (change.changedFields.includes("description")) input.description = change.description + evidence;
      if (change.changedFields.includes("priority")) input.priority = priority;
      if (change.changedFields.includes("dueDate")) input.dueDate = change.dueDate;
      if (change.changedFields.includes("assignee") && change.assignee) input.assigneeId = await this.resolveAssigneeId(change.assignee);
      if (Object.keys(input).length) {
        const data = await this.graphql<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string } } }>(mutation, {
          id: change.existingIssueIdentifier,
          input,
        });
        if (!data.issueUpdate.success) throw new Error(`Linear rejected update of ${change.existingIssueIdentifier}`);
        issueId = data.issueUpdate.issue.id;
        identifier = data.issueUpdate.issue.identifier;
      } else {
        issueId = await this.resolveIssueId(change.existingIssueIdentifier);
        identifier = change.existingIssueIdentifier;
      }
    }

    await this.createRelations(issueId, change);
    return identifier;
  }

  private async createRelations(issueId: string, change: ProposedChange): Promise<void> {
    const relations = [
      ...change.blocks.map((relatedIssue) => ({ issueId, relatedIssue, type: "blocks" })),
      ...change.blockedBy.map((blocker) => ({ issue: blocker, relatedIssueId: issueId, type: "blocks" })),
      ...change.relatedIssues.map((relatedIssue) => ({ issueId, relatedIssue, type: "related" })),
    ];
    const mutation = `mutation CreateRelation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success }
    }`;
    for (const relation of relations) {
      try {
        const input = {
          issueId: "issue" in relation ? await this.resolveIssueId(relation.issue) : relation.issueId,
          relatedIssueId: "relatedIssue" in relation ? await this.resolveIssueId(relation.relatedIssue) : relation.relatedIssueId,
          type: relation.type,
        };
        await this.graphql(mutation, { input });
      } catch (error) {
        if (!String(error).toLowerCase().includes("already")) throw error;
      }
    }
  }

  private async resolveIssueId(identifier: string): Promise<string> {
    const query = `query ResolveIssue($id: String!) { issue(id: $id) { id } }`;
    const data = await this.graphql<{ issue: { id: string } | null }>(query, { id: identifier });
    if (!data.issue) throw new Error(`Linear issue not found: ${identifier}`);
    return data.issue.id;
  }

  private async resolveAssigneeId(value: string): Promise<string> {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return value;
    const query = `query WorkspaceUsers { users(first: 250) { nodes { id name email } } }`;
    const data = await this.graphql<{ users: { nodes: Array<{ id: string; name: string; email: string }> } }>(query, {});
    const needle = value.toLowerCase();
    const user = data.users.nodes.find((candidate) => candidate.email.toLowerCase() === needle || candidate.name.toLowerCase() === needle);
    if (!user) throw new Error(`Linear user not found: ${value}`);
    return user.id;
  }
}
