import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StoredProposalSchema, type AnalysisResult, type ModelSelection, type SourceEvent, type StoredProposal } from "./types.js";

export class ProposalStore {
  constructor(private readonly path: string) {}

  static idempotencyKey(source: SourceEvent, model: ModelSelection): string {
    return createHash("sha256").update(JSON.stringify({ id: source.id, kind: source.kind, body: source.body, model })).digest("hex");
  }

  async create(source: SourceEvent, model: ModelSelection, analysis: AnalysisResult): Promise<{ proposal: StoredProposal; created: boolean }> {
    const all = await this.readAll();
    const idempotencyKey = ProposalStore.idempotencyKey(source, model);
    const existing = all.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return { proposal: existing, created: false };
    const proposal: StoredProposal = {
      id: randomUUID(), idempotencyKey, status: "pending", source, model, analysis,
      createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
      appliedIssueIdentifiers: [], error: null,
    };
    all.push(proposal);
    await this.writeAll(all);
    return { proposal, created: true };
  }

  async get(id: string): Promise<StoredProposal | undefined> {
    return (await this.readAll()).find((item) => item.id === id);
  }

  async listSources(): Promise<SourceEvent[]> {
    const proposals = await this.readAll();
    return [...new Map(proposals.map((proposal) => [proposal.source.id, proposal.source])).values()];
  }

  async decide(id: string, status: "approved" | "dismissed" | "failed", user: string, applied: string[] = [], error: string | null = null): Promise<StoredProposal> {
    const all = await this.readAll();
    const index = all.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Proposal not found");
    const current = all[index]!;
    if (current.status !== "pending") return current;
    const updated = { ...current, status, decidedAt: new Date().toISOString(), decidedBy: user, appliedIssueIdentifiers: applied, error };
    all[index] = StoredProposalSchema.parse(updated);
    await this.writeAll(all);
    return all[index]!;
  }

  private async readAll(): Promise<StoredProposal[]> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return StoredProposalSchema.array().parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(items: StoredProposal[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(items, null, 2));
    await rename(temporary, this.path);
  }
}
