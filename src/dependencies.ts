import type { AnalysisResult, LinearIssue, ProposedChange, SourceEvent } from "./types.js";

type Edge = { from: string; to: string; change?: ProposedChange };

const STOP_WORDS = new Set(["a", "an", "and", "are", "for", "in", "is", "of", "on", "or", "the", "to", "with", "flow", "task", "issue"]);

export function enrichContextMatches(analysis: AnalysisResult, source: SourceEvent, issues: LinearIssue[]): AnalysisResult {
  const candidates = issues
    .map((issue) => ({ issue, score: similarity(`${source.title} ${source.body}`, `${issue.title} ${issue.description}`) }))
    .filter((candidate) => candidate.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!candidates.length) return analysis;

  const byId = new Map(issues.map((issue) => [issue.identifier, issue]));
  if (!analysis.changes.length) {
    const best = candidates[0]!.issue;
    return {
      ...analysis,
      changes: [contextChange(source, best, candidates.slice(1).map((candidate) => candidate.issue.identifier))],
    };
  }

  return {
    ...analysis,
    changes: analysis.changes.map((change, index) => {
      const matched = change.existingIssueIdentifier
        ? byId.get(change.existingIssueIdentifier)
        : index === 0 && change.action === "no_action" ? candidates[0]?.issue : undefined;
      if (!matched) {
        return change.action === "no_action"
          ? { ...change, relatedIssues: unique([...change.relatedIssues, ...candidates.map((candidate) => candidate.issue.identifier)]) }
          : change;
      }
      return {
        ...change,
        existingIssueIdentifier: change.existingIssueIdentifier ?? matched.identifier,
        blockedBy: unique([...change.blockedBy, ...matched.blockedBy]),
        blocks: unique([...change.blocks, ...matched.blocks]),
        relatedIssues: unique([
          ...change.relatedIssues,
          ...matched.related,
          ...candidates.map((candidate) => candidate.issue.identifier).filter((id) => id !== matched.identifier),
        ]),
        rationale: `${change.rationale} Context scan matched ${matched.identifier} (“${matched.title}”) and loaded its current relation graph.`,
      };
    }),
  };
}

export function guardGrounding(analysis: AnalysisResult, source: SourceEvent, issues: LinearIssue[]): AnalysisResult {
  const byId = new Map(issues.map((issue) => [issue.identifier, issue]));
  const sourceText = `${source.title} ${source.body}`;
  const hasExplicitCalendarDate = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(sourceText);
  const hasExplicitPriority = /\b(urgent|high priority|normal priority|low priority|p[0-4])\b/i.test(sourceText);

  return {
    ...analysis,
    changes: analysis.changes.map((change) => {
      const current = change.existingIssueIdentifier ? byId.get(change.existingIssueIdentifier) : undefined;
      const isProspectiveCreate = !change.existingIssueIdentifier &&
        (change.action === "create" || change.action === "needs_owner_decision");
      const unsupported: string[] = [];
      const duplicateCandidate = isProspectiveCreate
        ? issues.map((issue) => ({ issue, score: similarity(`${change.title} ${change.description}`, `${issue.title} ${issue.description}`) }))
          .filter((candidate) => candidate.score >= 0.7)
          .sort((a, b) => b.score - a.score)[0]?.issue
        : undefined;
      const requestedPeople = peopleCount(`${sourceText} ${change.title} ${change.description}`);
      const quantityConflicts = isProspectiveCreate && requestedPeople !== null
        ? issues.flatMap((issue) => {
          const existingPeople = peopleCount(`${issue.title} ${issue.description}`);
          return existingPeople !== null && existingPeople !== requestedPeople
            ? [{
              issueIdentifier: issue.identifier,
              reason: `Requested headcount is ${requestedPeople}, but ${issue.identifier} records a capacity or headcount of ${existingPeople} people.`,
            }]
            : [];
        })
        : [];
      const workflowPrerequisites = isProspectiveCreate
        ? unfinishedWorkflowPrerequisites(change, source, issues, unique([
          ...quantityConflicts.map((conflict) => conflict.issueIdentifier),
          ...change.blockedBy.filter((identifier) => byId.has(identifier)),
          ...change.relatedIssues.filter((identifier) => byId.has(identifier)),
        ]))
        : [];
      const workflowConflicts = workflowPrerequisites.map((issue) => ({
        issueIdentifier: issue.identifier,
        reason: `Required earlier workflow task ${issue.identifier} is still ${issue.status}: ${issue.title}.`,
      }));
      const changedFields = change.changedFields.filter((field) => {
        if (field === "dueDate" && !hasExplicitCalendarDate) {
          unsupported.push("The message uses a relative weekday but does not provide an explicit calendar date.");
          return false;
        }
        if (field === "priority" && !hasExplicitPriority) {
          unsupported.push("The message does not explicitly change the issue priority.");
          return false;
        }
        if (current && field === "dueDate" && change.dueDate === current.dueDate) return false;
        if (current && field === "title" && change.title.trim() === current.title.trim()) return false;
        if (current && field === "description" && change.description.trim() === current.description.trim()) return false;
        return true;
      });

      const endpointGrounded = (identifier: string) => {
        const issue = byId.get(identifier);
        if (!issue) return false;
        if (current?.identifier === identifier) return true;
        if (quantityConflicts.some((conflict) => conflict.issueIdentifier === identifier)) return true;
        if (workflowPrerequisites.some((candidate) => candidate.identifier === identifier)) return true;
        return similarity(sourceText, `${issue.title} ${issue.description}`) >= 0.34;
      };
      const blocks = change.blocks.filter((id) => {
        const grounded = endpointGrounded(id);
        if (!grounded) unsupported.push(`The proposed dependency on ${id} is not grounded in the source text.`);
        return grounded;
      });
      const blockedBy = change.blockedBy.filter((id) => {
        const grounded = endpointGrounded(id);
        if (!grounded) unsupported.push(`The proposed dependency on ${id} is not grounded in the source text.`);
        return grounded;
      });
      const proposedDueDate = changedFields.includes("dueDate") ? change.dueDate : current?.dueDate ?? change.dueDate;
      const chronologicalConflicts = [
        ...blockedBy.flatMap((identifier) => {
          const prerequisite = byId.get(identifier);
          return prerequisite?.dueDate && proposedDueDate && prerequisite.dueDate > proposedDueDate
            ? [{ issueIdentifier: identifier, reason: `${identifier} is due ${prerequisite.dueDate}, after this dependent task is due ${proposedDueDate}.` }]
            : [];
        }),
        ...blocks.flatMap((identifier) => {
          const dependent = byId.get(identifier);
          return dependent?.dueDate && proposedDueDate && proposedDueDate > dependent.dueDate
            ? [{ issueIdentifier: identifier, reason: `${identifier} is due ${dependent.dueDate}, before this prerequisite is due ${proposedDueDate}.` }]
            : [];
        }),
      ];
      const hasWritableChange = changedFields.length > 0 || blocks.length > 0 || blockedBy.length > 0;
      const unresolvedDecision = change.conflicts.length > 0 || quantityConflicts.length > 0 || workflowConflicts.length > 0 || chronologicalConflicts.length > 0 || change.ownerQuestion !== null;
      if (isProspectiveCreate && !change.evidence.length) unsupported.push("A new issue requires explicit source evidence.");
      if (duplicateCandidate) unsupported.push(`The proposed issue may duplicate ${duplicateCandidate.identifier}: ${duplicateCandidate.title}.`);
      if (isProspectiveCreate && change.assignee && !sourceText.toLowerCase().includes(change.assignee.toLowerCase().split("@")[0]!)) {
        unsupported.push("The proposed assignee is not explicitly identified in the source.");
      }
      const optionalCreateMetadata = (reason: string) =>
        reason.includes("relative weekday") || reason.includes("priority") || reason.includes("assignee");
      const reportedUnsupported = isProspectiveCreate
        ? unsupported.filter((reason) => !optionalCreateMetadata(reason))
        : unsupported;
      const createNeedsDecision = isProspectiveCreate && (reportedUnsupported.length > 0 || duplicateCandidate !== undefined);
      const action = unresolvedDecision || createNeedsDecision || (reportedUnsupported.length > 0 && !hasWritableChange)
        ? "needs_owner_decision" as const
        : change.action === "create" ? "create" as const
        : hasWritableChange ? change.action : "no_action" as const;

      return {
        ...change,
        action,
        dueDate: isProspectiveCreate
          ? hasExplicitCalendarDate ? change.dueDate : null
          : changedFields.includes("dueDate") ? change.dueDate : current?.dueDate ?? change.dueDate,
        assignee: isProspectiveCreate && unsupported.some((reason) => reason.includes("assignee")) ? null : change.assignee,
        priority: isProspectiveCreate
          ? hasExplicitPriority ? change.priority : "none" as const
          : changedFields.includes("priority") ? change.priority : "none" as const,
        changedFields,
        blocks,
        blockedBy: unique([...blockedBy, ...workflowPrerequisites.map((issue) => issue.identifier)]),
        conflicts: uniqueConflicts([
          ...change.conflicts,
          ...quantityConflicts,
          ...workflowConflicts,
          ...chronologicalConflicts,
          ...reportedUnsupported.map((reason) => ({ issueIdentifier: change.existingIssueIdentifier ?? change.localId, reason })),
        ]),
        relatedIssues: unique([
          ...change.relatedIssues,
          ...(duplicateCandidate ? [duplicateCandidate.identifier] : []),
          ...quantityConflicts.map((conflict) => conflict.issueIdentifier),
          ...workflowPrerequisites.map((issue) => issue.identifier),
        ]),
        ownerQuestion: workflowConflicts.length
          ? [
            change.ownerQuestion,
            quantityConflicts.length
              ? `Should this downstream task wait until ${workflowPrerequisites.map((issue) => issue.identifier).join(", ")} are completed, and should it use the existing ${peopleCount(`${byId.get(quantityConflicts[0]!.issueIdentifier)?.title ?? ""} ${byId.get(quantityConflicts[0]!.issueIdentifier)?.description ?? ""}`)}-person limit, or has the approved capacity changed to ${requestedPeople}?`
              : `Should this downstream task wait until ${workflowPrerequisites.map((issue) => issue.identifier).join(", ")} are completed, or has the workflow order changed?`,
          ].filter(Boolean).join(" ")
          : quantityConflicts.length
            ? change.ownerQuestion ?? `Should the request use the existing ${peopleCount(`${byId.get(quantityConflicts[0]!.issueIdentifier)?.title ?? ""} ${byId.get(quantityConflicts[0]!.issueIdentifier)?.description ?? ""}`)}-person limit, or has the approved capacity changed to ${requestedPeople}?`
          : reportedUnsupported.length
            ? change.ownerQuestion ?? "Which exact Linear task represents this prerequisite, and what calendar date was intended?"
            : change.ownerQuestion,
        risk: unsupported.length || quantityConflicts.length || workflowConflicts.length || chronologicalConflicts.length ? "high" as const : change.risk,
      };
    }),
  };
}

function contextChange(source: SourceEvent, issue: LinearIssue, related: string[]): ProposedChange {
  return {
    localId: "context-scan",
    action: "no_action",
    existingIssueIdentifier: issue.identifier,
    title: issue.title,
    rationale: `The message is too vague for a Linear mutation, but it semantically matches ${issue.identifier}. Its current dependency context is shown for review.`,
    evidence: [source.body || source.title],
    assignee: issue.assignee,
    dueDate: issue.dueDate,
    priority: "none",
    description: issue.description,
    changedFields: [],
    blockedBy: issue.blockedBy,
    blocks: issue.blocks,
    relatedIssues: unique([...issue.related, ...related]),
    conflicts: [],
    blockers: [],
    ownerQuestion: "What changed about this work, and is there a new commitment, owner, deadline, blocker, or dependency?",
    risk: "low",
  };
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.min(a.size, b.size);
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function peopleCount(value: string): number | null {
  const match = value.match(/\b(\d{1,6})\s*(?:people|persons?|attendees?|guests?|seats?)\b/i);
  return match ? Number(match[1]) : null;
}

function unfinishedWorkflowPrerequisites(
  change: ProposedChange,
  source: SourceEvent,
  issues: LinearIssue[],
  anchorIdentifiers: string[],
): LinearIssue[] {
  const request = `${source.title} ${source.body} ${change.title} ${change.description}`;
  if (!/\b(?:bill|invoice|place|order|book|purchase|send|publish|launch)\b/i.test(request)) return [];

  const anchorText = issues
    .filter((issue) => anchorIdentifiers.includes(issue.identifier))
    .map((issue) => `${issue.title} ${issue.description}`)
    .join(" ");
  const projectTerms = [...tokens(anchorText)].filter((token) =>
    !/^(?:test|confirm|annual|current|provisional|capacity|people|person|venue|headcount|attendee|guest)$/.test(token));
  const onboardingRequest = /\b(?:candidate|new hire|onboard|welcome email|start[ -]?day|first[ -]?day)\b/i.test(request);
  const workflowInput = /\bcater/i.test(request)
    ? /\b(?:cater|headcount|attendees?|guest|dietary|capacity|invitations?|invite)\b/i
    : /\b(?:travel|accommodation|hotel|flight)\b/i.test(request)
      ? /\b(?:attendees?|guest|headcount|invitations?|invite|venue|capacity|approval|final(?:ize)?)\b/i
      : onboardingRequest
        ? /\b(?:candidate|offer|background|new hire|laptop|desk|badge|access|first[ -]?week|meetings?|onboard)\b/i
      : /\b(?:approval|review|final(?:ize)?|confirm|capacity|headcount)\b/i;

  return issues.filter((issue) => {
    if (/done|complete|cancel|closed/i.test(issue.status)) return false;
    const text = `${issue.title} ${issue.description}`;
    const sameProject = projectTerms.some((term) => tokens(text).has(term));
    const directInput = workflowInput.test(text);
    return directInput && (onboardingRequest || sameProject || similarity(request, text) >= 0.2 || anchorIdentifiers.includes(issue.identifier));
  });
}

function uniqueConflicts<T extends { issueIdentifier: string; reason: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = `${value.issueIdentifier}:${value.reason.toLowerCase().replace(/[^a-z0-9]+/g, " ")}`;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function target(change: ProposedChange): string {
  return change.existingIssueIdentifier ?? `proposal:${change.localId}`;
}

export function guardDependencyCycles(analysis: AnalysisResult, issues: LinearIssue[]): AnalysisResult {
  const existing: Edge[] = issues.flatMap((issue) => issue.blocks.map((blocked) => ({ from: issue.identifier, to: blocked })));
  const proposed: Edge[] = analysis.changes.flatMap((change) => [
    ...change.blocks.map((blocked) => ({ from: target(change), to: blocked, change })),
    ...change.blockedBy.map((blocker) => ({ from: blocker, to: target(change), change })),
  ]);
  const accepted = [...existing];
  const cyclicChanges = new Map<ProposedChange, string>();

  for (const edge of proposed) {
    if (edge.from === edge.to || hasPath(edge.to, edge.from, accepted)) {
      if (edge.change) cyclicChanges.set(edge.change, `${edge.from} → ${edge.to} would create a circular dependency`);
    } else {
      accepted.push(edge);
    }
  }

  if (!cyclicChanges.size) return analysis;
  return {
    ...analysis,
    changes: analysis.changes.map((change) => {
      const reason = cyclicChanges.get(change);
      if (!reason) return change;
      return {
        ...change,
        action: "needs_owner_decision" as const,
        conflicts: [...change.conflicts, { issueIdentifier: change.existingIssueIdentifier ?? change.localId, reason }],
        ownerQuestion: change.ownerQuestion ?? "Which task is the true prerequisite so the dependency cycle can be removed?",
        risk: "high" as const,
      };
    }),
  };
}

function hasPath(start: string, destination: string, edges: Edge[]): boolean {
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  const queue = [start];
  const visited = new Set<string>();
  while (queue.length) {
    const node = queue.shift()!;
    if (node === destination) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    queue.push(...(graph.get(node) ?? []));
  }
  return false;
}
