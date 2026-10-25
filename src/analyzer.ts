import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AnalysisResultSchema, type AnalysisResult, type LinearIssue, type ModelSelection, type SourceEvent } from "./types.js";

export interface HandoverAnalyzer {
  analyze(source: SourceEvent, issues: LinearIssue[], selection: ModelSelection, history?: SourceEvent[]): Promise<AnalysisResult>;
}

const SYSTEM_PROMPT = `You are an approval-first handover analyst. Extract only explicit commitments, changes, deadlines, dependencies, conflicts, and blockers from the supplied source.

Linear is authoritative. Never invent owners, dates, prices, issue identifiers, or facts. Prefer updating an existing issue over creating a duplicate. A proposed write must include evidence. Use needs_owner_decision when facts conflict or an owner/date cannot be safely chosen.

Decide whether the source reveals actionable work that belongs in Linear. Suggest action=create when no existing issue covers an expressed need, including: a commitment; requested feature or improvement; reported bug or user pain; operational problem; unresolved risk; required investigation; follow-up question that someone must answer; or a decision that needs an owner. The speaker does not need to use task language. “Customers want CSV export,” “Why does checkout lose the coupon?”, and “We should understand why invoices arrive late” can all justify new tasks when they identify concrete work. A creation needs a concise verb-led title, source evidence, a description of the desired outcome, and only explicitly stated metadata. If no deadline is stated, dueDate must be null. If no owner is stated, assignee must be null. If priority is not stated, use none. Do not create from pure small talk, a topic label with no expressed need, repetition of known status, or a hypothetical idea that nobody wants pursued. Never create a new issue when an existing issue is a plausible match; use update or needs_owner_decision instead.

People speaking in meetings usually do not know or mention Linear identifiers. Resolve each commitment semantically against the board using customer/project names, task meaning, descriptions, owners, dates, status, and neighboring dependencies. For example, “connect the integrations first” may match an issue titled “Connect your tools.” Put the matched board identifier in existingIssueIdentifier and explain the match in rationale. If multiple issues are plausible, do not guess: use needs_owner_decision, list the candidates as conflicts or relatedIssues, and ask a precise owner question.

Reason across the whole board, not only direct phrase matches. Detect duplicate work, incompatible dates, conflicting owners or statuses, incompatible quantities (for example, catering for 80 people when venue capacity is 60), prerequisites, downstream work, and circular dependencies. Before proposing a downstream action such as generating a bill, placing an order, sending invitations, publishing, or sending start-day instructions, chronologically inspect related workflow tasks and their statuses. In onboarding, an unsigned offer, incomplete background check, unprepared laptop/access, or unscheduled first-week plan must be reported before a welcome/start-day email is sent. An incomplete capacity check, approval, attendee list, invitation, or final headcount must likewise be reported as an unresolved prerequisite; use needs_owner_decision rather than create. A quantity that exceeds an existing capacity is also a conflict, even when the tasks have different titles. The source text is evidence for the proposed change; the current board is evidence for existing state.

Vague input is still a request for a context-impact scan. If the source is only a subject or short phrase, search every issue title and description for semantic matches. Return a no_action item for the best matching issue(s), populate relatedIssues/blockedBy/blocks from the board, and explain what context was found and what information is missing. Do not say there is nothing actionable until you have reported relevant board matches and their dependency impact. Never turn similarity alone into a create/update proposal.

Dependency direction is strict:
- blockedBy: existing issues that must finish before this proposed issue.
- blocks: existing issues that cannot finish until this proposed issue.
- relatedIssues: relevant but non-blocking issues.

List schedule/ownership/factual conflicts under conflicts. List non-issue impediments under blockers. No external action may be executed from analysis. Externally consequential actions (emails, payments, calendar moves, customer contact) must remain needs_owner_decision.

For updates, changedFields may only contain title, description, priority, dueDate, or assignee. Existing issue references must use identifiers present in the supplied board. Assignee must be null unless the source or board explicitly identifies one; if non-null, use an email or Linear user ID already present in the board.`;

export class OpenAIHandoverAnalyzer implements HandoverAnalyzer {
  private readonly client: OpenAI | null;

  constructor(apiKey?: string) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async analyze(source: SourceEvent, issues: LinearIssue[], selection: ModelSelection): Promise<AnalysisResult> {
    if (!this.client) throw new Error("OpenAI is not configured. Set OPENAI_API_KEY or choose an Ollama model.");
    const response = await this.client.responses.parse({
      model: selection.model,
      instructions: SYSTEM_PROMPT,
      input: JSON.stringify({ source, linearBoard: issues }),
      text: { format: zodTextFormat(AnalysisResultSchema, "handover_analysis") },
    });
    if (!response.output_parsed) throw new Error("The analyzer returned no structured proposal");
    return AnalysisResultSchema.parse(response.output_parsed);
  }
}

export class OllamaHandoverAnalyzer implements HandoverAnalyzer {
  constructor(private readonly baseUrl: string) {}

  async analyze(source: SourceEvent, issues: LinearIssue[], selection: ModelSelection): Promise<AnalysisResult> {
    const schema = z.toJSONSchema(AnalysisResultSchema);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selection.model,
        stream: false,
        format: schema,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Return JSON matching this schema:\n${JSON.stringify(schema)}\n\nAnalyze:\n${JSON.stringify({ source, linearBoard: issues })}` },
        ],
        options: { temperature: 0 },
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${details.slice(0, 500)}`);
    }
    const payload = await response.json() as { message?: { content?: string } };
    if (!payload.message?.content) throw new Error("Ollama returned no response content");
    return AnalysisResultSchema.parse(JSON.parse(payload.message.content));
  }
}

export class ModelRouter implements HandoverAnalyzer {
  constructor(
    private readonly openai: OpenAIHandoverAnalyzer,
    private readonly ollama: OllamaHandoverAnalyzer,
  ) {}

  analyze(source: SourceEvent, issues: LinearIssue[], selection: ModelSelection): Promise<AnalysisResult> {
    return selection.provider === "ollama"
      ? this.ollama.analyze(source, issues, selection)
      : this.openai.analyze(source, issues, selection);
  }
}
