import type { HandoverAnalyzer } from "./analyzer.js";
import { enrichContextMatches, guardDependencyCycles, guardGrounding } from "./dependencies.js";
import type { IssueTracker } from "./linear.js";
import { ProposalStore } from "./store.js";
import type { ModelSelection, SourceEvent, StoredProposal } from "./types.js";

export class HandoverService {
  constructor(
    private readonly tracker: IssueTracker,
    private readonly analyzer: HandoverAnalyzer,
    private readonly store: ProposalStore,
  ) {}

  async propose(source: SourceEvent, model: ModelSelection): Promise<{ proposal: StoredProposal; created: boolean }> {
    const graph = await this.tracker.listIssueGraph();
    const history = await this.store.listSources();
    const rawAnalysis = await this.analyzer.analyze(source, graph, model, history);
    const contextual = enrichContextMatches(rawAnalysis, source, graph);
    const analysis = guardDependencyCycles(guardGrounding(contextual, source, graph), graph);
    return this.store.create(source, model, analysis);
  }

  async approve(id: string, user: string): Promise<StoredProposal> {
    const proposal = await this.store.get(id);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status !== "pending") return proposal;
    const applied: string[] = [];
    try {
      for (const change of proposal.analysis.changes) {
        const identifier = await this.tracker.applyChange(change, proposal.source);
        if (identifier) applied.push(identifier);
      }
      return await this.store.decide(id, "approved", user, applied);
    } catch (error) {
      return this.store.decide(id, "failed", user, applied, String(error));
    }
  }

  async createAnyway(id: string, user: string): Promise<StoredProposal> {
    const proposal = await this.store.get(id);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status !== "pending") return proposal;
    const applied: string[] = [];
    try {
      for (const change of proposal.analysis.changes) {
        const reviewContext = [
          change.conflicts.length ? `Conflicts requiring review:\n${change.conflicts.map((conflict) => `- ${conflict.issueIdentifier}: ${conflict.reason}`).join("\n")}` : "",
          change.ownerQuestion ? `Open decision: ${change.ownerQuestion}` : "",
        ].filter(Boolean).join("\n\n");
        const identifier = await this.tracker.applyChange({
          ...change,
          action: "create",
          existingIssueIdentifier: null,
          changedFields: [],
          description: `${change.description}${reviewContext ? `\n\n---\nCreated via explicit Slack override.\n${reviewContext}` : ""}`,
        }, proposal.source);
        if (identifier) applied.push(identifier);
      }
      return await this.store.decide(id, "approved", user, applied);
    } catch (error) {
      return this.store.decide(id, "failed", user, applied, String(error));
    }
  }

  dismiss(id: string, user: string): Promise<StoredProposal> {
    return this.store.decide(id, "dismissed", user);
  }
}
