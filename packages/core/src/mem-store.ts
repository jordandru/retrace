/**
 * In-memory EventStore with policy tables. Used by tests; serialises writes so concurrent
 * PUTs observe If-Match the same way D1/SQLite transactions do.
 */
import { Event } from "./schema.js";
import {
  ArtifactIndexQuery, ArtifactIndexResult, ChainHead, EventStore, HeadMovedError, HistoryQuery, HistoryPage,
  PendingDelivery, Share, pageHistoryNewest,
} from "./store.js";
import { PolicyDocument, PolicyRouteRow, PolicySnapshot, PolicySnapshotBudget, PolicyWrite, assertRouteWriteConsistent, policySnapshotFromIndex } from "./policy.js";

export class MemoryEventStore implements EventStore {
  events: Event[] = [];
  shares = new Map<string, Share>();
  policies: PolicyDocument[] = [];
  routes = new Map<string, PolicyRouteRow>();
  pending: PendingDelivery[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async head(p: string) {
    const e = this.events.filter((x) => x.project === p).sort((a, b) => a.seq - b.seq).at(-1);
    return e ? { seq: e.seq, hash: e.hash } : null;
  }
  async insert(e: Event) {
    if (this.events.some((x) => x.project === e.project && x.seq === e.seq)) throw new Error("UNIQUE constraint failed: events.project, events.seq");
    this.events.push(e);
  }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: HistoryQuery): Promise<HistoryPage> { return pageHistoryNewest(this.events, q); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
  async deleteShare(id: string) { return this.shares.delete(id); }
  async deleteProject(p: string, audit: Event, expectedHead: ChainHead) {
    const head = await this.head(p);
    if (!head || head.seq !== expectedHead.seq || head.hash !== expectedHead.hash) throw new HeadMovedError(p, expectedHead);
    const evs = this.events.filter((e) => e.project === p);
    const counts = { events: evs.length, event_artifacts: evs.reduce((n, e) => n + e.artifacts.length, 0), shares: [...this.shares.values()].filter((s) => s.project === p).length };
    if (this.events.some((e) => e.project === audit.project && e.seq === audit.seq)) throw new Error("UNIQUE constraint failed: events.project, events.seq");
    this.events = this.events.filter((e) => e.project !== p);
    this.policies = this.policies.filter((d) => d.body.project !== p);
    for (const [id, s] of this.shares) if (s.project === p) this.shares.delete(id);
    this.events.push(audit);
    return counts;
  }
  async eventsReferencingArtifacts(q: ArtifactIndexQuery): Promise<ArtifactIndexResult> {
    const events = this.events.filter((e) => e.project === q.project && e.seq > q.after_seq && e.seq <= q.through_seq);
    return { ok: true, events };
  }
  async insertPendingDelivery(row: PendingDelivery) {
    if (this.pending.some((p) => p.delivery_id === row.delivery_id)) return;
    this.pending.push(row);
  }
  async getPendingDelivery(delivery_id: string) {
    return this.pending.find((p) => p.delivery_id === delivery_id) ?? null;
  }
  async listPendingDeliveriesOlderThan(received_at: string) {
    return this.pending.filter((p) => p.received_at < received_at);
  }
  async deletePendingDelivery(delivery_id: string) {
    const n = this.pending.length;
    this.pending = this.pending.filter((p) => p.delivery_id !== delivery_id);
    return this.pending.length < n;
  }

  async getPolicy(project: string, lookup: { digest?: string; version?: number; current?: boolean } = { current: true }) {
    const rows = this.policies.filter((d) => d.body.project === project);
    if (lookup.digest) return rows.find((d) => d.digest === lookup.digest) ?? null;
    if (lookup.version !== undefined) return rows.find((d) => d.envelope.version === lookup.version) ?? null;
    return rows.sort((a, b) => b.envelope.version - a.envelope.version)[0] ?? null;
  }
  async listPolicies(project: string, limit = 50) {
    return this.policies.filter((d) => d.body.project === project).sort((a, b) => b.envelope.version - a.envelope.version).slice(0, limit);
  }
  async getPolicyRoute(repo: string) { return this.routes.get(repo) ?? null; }
  async listPolicyRoutes(project: string) { return [...this.routes.values()].filter((r) => r.project === project).sort((a, b) => a.repo.localeCompare(b.repo)); }
  async getPolicyByActivationSeq(project: string, throughSeq: number) {
    return this.policies
      .filter((d) => d.body.project === project && d.envelope.activation.seq <= throughSeq)
      .sort((a, b) => b.envelope.activation.seq - a.envelope.activation.seq)[0] ?? null;
  }
  async readPolicySnapshot(project: string, U?: number, budget?: PolicySnapshotBudget): Promise<PolicySnapshot> {
    const head = await this.head(project);
    return policySnapshotFromIndex({
      project,
      U,
      budget,
      headSeq: head?.seq,
      getByActivationSeq: (p, seq) => this.getPolicyByActivationSeq(p, seq),
      getEvent: (id) => this.get(id),
    });
  }
  async applyPolicyWrite(write: PolicyWrite, expectedHeads: Record<string, ChainHead | null>) {
    return this.enqueue(async () => {
      for (const [project, expected] of Object.entries(expectedHeads)) {
        const head = await this.head(project);
        if (expected === null) {
          if (head) throw new HeadMovedError(project, { seq: -1, hash: "none" });
        } else if (!head || head.seq !== expected.seq || head.hash !== expected.hash) {
          throw new HeadMovedError(project, expected);
        }
      }
      assertRouteWriteConsistent(
        write,
        (repo) => this.routes.get(repo) ?? null,
        (project) => this.policies.filter((d) => d.body.project === project).sort((a, b) => b.envelope.version - a.envelope.version)[0] ?? null,
      );
      const snapshot = {
        events: this.events.slice(),
        policies: this.policies.slice(),
        routes: new Map(this.routes),
      };
      try {
        for (const e of write.events) {
          if (this.events.some((x) => x.project === e.project && x.seq === e.seq)) throw new Error("UNIQUE constraint failed: events.project, events.seq");
          this.events.push(e);
        }
        for (const d of write.documents) {
          if (this.policies.some((x) => x.digest === d.digest)) throw new Error("UNIQUE constraint failed: project_policies.digest");
          if (this.policies.some((x) => x.body.project === d.body.project && x.envelope.version === d.envelope.version))
            throw new Error("UNIQUE constraint failed: project_policies.project, version");
          this.policies.push(d);
        }
        for (const r of write.routes) this.routes.set(r.repo, r);
      } catch (err) {
        this.events = snapshot.events;
        this.policies = snapshot.policies;
        this.routes = snapshot.routes;
        throw err;
      }
    });
  }
}

export { MemoryEventStore as MemStore };
