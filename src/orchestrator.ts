import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import type { HandoverAnalyzer } from "./analyzer.js";
import { AnalysisResultSchema, type AnalysisResult, type LinearIssue, type ModelSelection, type SourceEvent } from "./types.js";

const ORCHESTRATOR_PROMPT = `You are the read-only semantic and chronological investigator for an approval-first work-handover system.

Use ReAct reasoning internally: inspect the board with tools, observe the results, and continue until you have enough evidence. Never expose private chain-of-thought. Return only the requested structured proposal with concise evidence and conclusions.

For every source:
1. Call semantic_search_tasks using the complete source meaning, not only its title.
2. Inspect plausible matches and their neighbors with inspect_dependency_neighborhood.
3. Call inspect_chronological_board and inspect_source_timeline for the relevant project or workflow terms.
4. Compare intent, entities, quantities, workflow stage, status, due date, and source chronology. Later explicit statements may supersede earlier ones, but never assume they do without evidence.
5. Prefer an update over a duplicate. If multiple matches are plausible, use needs_owner_decision.
6. A downstream action is not ready when required upstream work is unfinished. Examples: a catering bill depends on final headcount and capacity; attendee travel depends on a final attendee list; start-day instructions depend on confirmed onboarding details.
7. Detect deadline inversions, incompatible quantities, superseded facts, status contradictions, duplicate work, and circular or missing prerequisites.
8. Treat the supplied Linear board as authoritative. Never invent an issue identifier, owner, date, price, status, dependency, or completed action.
9. Externally consequential actions such as sending email, customer contact, payments, calendar changes, or bookings require needs_owner_decision.
10. No tool may write to Linear, Slack, email, or calendar. Propose only; a separate approval workflow executes changes.

Dependency direction is strict: blockedBy contains prerequisites; blocks contains downstream work. Every relationship and conflict must cite source or board evidence in rationale/evidence.`;

export function createBoardTools(issues: LinearIssue[], history: SourceEvent[] = []) {
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));

  const semanticSearch = tool(
    async ({ query, limit }) => JSON.stringify(
      semanticMatches(query, issues).slice(0, limit),
    ),
    {
      name: "semantic_search_tasks",
      description: "Find existing Linear work with similar meaning, entities, quantities, workflow concepts, or expected outcomes. Returns scored complete issue records.",
      schema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(10),
      }),
    },
  );

  const dependencyNeighborhood = tool(
    async ({ identifiers, depth }) => JSON.stringify(
      dependencyNeighborhoodFor(identifiers, depth, byIdentifier),
    ),
    {
      name: "inspect_dependency_neighborhood",
      description: "Expand selected issues through blockedBy, blocks, and related edges. Use this before concluding that a task is independent.",
      schema: z.object({
        identifiers: z.array(z.string()).min(1).max(20),
        depth: z.number().int().min(1).max(5).default(3),
      }),
    },
  );

  const chronologicalBoard = tool(
    async ({ terms }) => JSON.stringify(chronologicalView(terms, issues)),
    {
      name: "inspect_chronological_board",
      description: "Return relevant issues ordered by deadline, including status and explicit dependency timing conflicts. Use workflow/project terms, not an issue identifier alone.",
      schema: z.object({
        terms: z.array(z.string().min(1)).min(1).max(20),
      }),
    },
  );

  const sourceTimeline = tool(
    async ({ terms }) => JSON.stringify(sourceTimelineFor(terms, history)),
    {
      name: "inspect_source_timeline",
      description: "Return prior Slack, email, and call sources in chronological order for the requested project or workflow terms. Use it to find superseded commitments and changed facts.",
      schema: z.object({
        terms: z.array(z.string().min(1)).min(1).max(20),
      }),
    },
  );

  return [semanticSearch, dependencyNeighborhood, chronologicalBoard, sourceTimeline] as const;
}

export class LangChainHandoverOrchestrator implements HandoverAnalyzer {
  constructor(
    private readonly openaiApiKey: string | undefined,
    private readonly ollamaBaseUrl: string,
  ) {}

  async analyze(source: SourceEvent, issues: LinearIssue[], selection: ModelSelection, history: SourceEvent[] = []): Promise<AnalysisResult> {
    const tools = [...createBoardTools(issues, history)];
    const shared = {
      tools,
      prompt: ORCHESTRATOR_PROMPT,
      responseFormat: AnalysisResultSchema,
      name: "handover_semantic_chronology_orchestrator",
    };
    const agent = selection.provider === "openai"
      ? createAgent({ ...shared, model: this.openAIModel(selection.model) })
      : createAgent({ ...shared, model: new ChatOllama({ model: selection.model, baseUrl: this.ollamaBaseUrl, temperature: 0 }) });
    const result = await agent.invoke({
      messages: [{
        role: "user",
        content: JSON.stringify({
          source,
          boardSummary: {
            issueCount: issues.length,
            identifiers: issues.map((issue) => issue.identifier),
          },
          instruction: "Investigate with all relevant read-only tools, then return the final handover proposal.",
        }),
      }],
    }, {
      configurable: { thread_id: `${source.id}:${selection.provider}:${selection.model}` },
      recursionLimit: 20,
    });
    return AnalysisResultSchema.parse(result.structuredResponse);
  }

  private openAIModel(model: string): ChatOpenAI {
    if (!this.openaiApiKey) throw new Error("OpenAI is not configured. Set OPENAI_API_KEY or choose an Ollama model.");
    return new ChatOpenAI({ model, apiKey: this.openaiApiKey, temperature: 0 });
  }
}

export function semanticMatches(query: string, issues: LinearIssue[]): Array<{ score: number; issue: LinearIssue }> {
  return issues
    .map((issue) => ({ score: semanticScore(query, `${issue.title} ${issue.description}`), issue }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.issue.identifier.localeCompare(right.issue.identifier));
}

function semanticScore(left: string, right: string): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const coverage = overlap / Math.min(leftTokens.size, rightTokens.size);
  const leftPeople = peopleCount(left);
  const rightPeople = peopleCount(right);
  const quantitySignal = leftPeople !== null && rightPeople !== null ? 0.15 : 0;
  const workflowSignal = sharedWorkflow(left, right) ? 0.25 : 0;
  return Math.min(1, coverage + quantitySignal + workflowSignal);
}

export function dependencyNeighborhoodFor(
  identifiers: string[],
  depth: number,
  issues: Map<string, LinearIssue>,
): { roots: string[]; issues: LinearIssue[]; missing: string[] } {
  const queue = identifiers.map((identifier) => ({ identifier, level: 0 }));
  const visited = new Set<string>();
  const found: LinearIssue[] = [];
  const missing: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.identifier)) continue;
    visited.add(current.identifier);
    const issue = issues.get(current.identifier);
    if (!issue) { missing.push(current.identifier); continue; }
    found.push(issue);
    if (current.level >= depth) continue;
    for (const identifier of [...issue.blockedBy, ...issue.blocks, ...issue.related]) {
      queue.push({ identifier, level: current.level + 1 });
    }
  }
  return { roots: identifiers, issues: found, missing };
}

export function chronologicalView(terms: string[], issues: LinearIssue[]): {
  issues: LinearIssue[];
  deadlineConflicts: Array<{ prerequisite: string; dependent: string; reason: string }>;
} {
  const query = terms.join(" ");
  const relevant = semanticMatches(query, issues)
    .filter(({ score }) => score >= 0.2)
    .map(({ issue }) => issue)
    .sort((left, right) => (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31"));
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
  const deadlineConflicts = relevant.flatMap((dependent) => dependent.blockedBy.flatMap((identifier) => {
    const prerequisite = byIdentifier.get(identifier);
    if (!prerequisite?.dueDate || !dependent.dueDate || prerequisite.dueDate <= dependent.dueDate) return [];
    return [{
      prerequisite: prerequisite.identifier,
      dependent: dependent.identifier,
      reason: `${prerequisite.identifier} is due ${prerequisite.dueDate}, after ${dependent.identifier} is due ${dependent.dueDate}.`,
    }];
  }));
  return { issues: relevant, deadlineConflicts };
}

export function sourceTimelineFor(terms: string[], history: SourceEvent[]): SourceEvent[] {
  const query = terms.join(" ");
  return history
    .map((source) => ({ source, score: semanticScore(query, `${source.title} ${source.body}`) }))
    .filter(({ score }) => score >= 0.2)
    .sort((left, right) => {
      const leftTime = left.source.occurredAt ? Date.parse(left.source.occurredAt) : Number.MAX_SAFE_INTEGER;
      const rightTime = right.source.occurredAt ? Date.parse(right.source.occurredAt) : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    })
    .map(({ source }) => source);
}

function normalizedTokens(value: string): Set<string> {
  const stop = new Set(["a", "an", "and", "are", "for", "in", "is", "of", "on", "or", "the", "to", "with", "task", "issue", "test"]);
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .map((token) => token.endsWith("ies") ? `${token.slice(0, -3)}y` : token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token)
    .filter((token) => token.length > 2 && !stop.has(token)));
}

function peopleCount(value: string): number | null {
  const match = value.match(/\b(\d{1,6})\s*(?:people|persons?|attendees?|guests?|seats?)\b/i);
  return match ? Number(match[1]) : null;
}

function sharedWorkflow(left: string, right: string): boolean {
  const workflows = [
    /\b(?:candidate|offer|background|new hire|onboard|welcome|start day|laptop|badge)\b/i,
    /\b(?:cater|headcount|attendee|guest|dietary|venue|capacity)\b/i,
    /\b(?:travel|accommodation|hotel|flight)\b/i,
    /\b(?:price|pricing|quote|proposal|invoice|bill)\b/i,
    /\b(?:install|camera|layout|deploy|server)\b/i,
  ];
  return workflows.some((workflow) => workflow.test(left) && workflow.test(right));
}
