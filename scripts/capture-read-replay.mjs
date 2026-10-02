/** Offline, test-only PR 148 step-1 equivalence replay.
 * Usage: RETRACE_DB=<scratch> RETRACE_URL= RETRACE_TOKEN= node scripts/capture-read-replay.mjs <export> <built-baseline-root>
 * Runs the actual baseline and current classifiers in separate temporary module trees; instrumentation is added
 * only to the temporary copies to observe their private preliminary/complete capture seals and rowsRead.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

assert.equal(process.env.RETRACE_URL, ''); assert.equal(process.env.RETRACE_TOKEN, '');
assert.ok(process.env.RETRACE_DB, 'scratch RETRACE_DB required');
const [exportPath, baselinePath] = process.argv.slice(2);
assert.ok(exportPath && baselinePath, 'export and built baseline root required');
const bytes = readFileSync(exportPath), bundle = JSON.parse(bytes);
const sourceHash = createHash('sha256').update(bytes).digest('hex');
const scratch = mkdtempSync(join(tmpdir(), 'capture-replay-'));
const currentPath = resolve('.');
function snapshot(label, source) {
  const root = join(scratch, label); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync(join(source, 'packages/core/dist'), join(root, 'core/dist'), { recursive: true });
  cpSync(join(source, 'packages/core/package.json'), join(root, 'core/package.json'));
  cpSync(join(source, 'packages/mcp-server/dist/sqlite-store.js'), join(root, 'sqlite-store.js'));
  const nm = join(root, 'node_modules'); mkdirSync(nm);
  for (const name of readdirSync(join(currentPath, 'node_modules'))) {
    if (name === '@retrace-dev') continue;
    symlinkSync(join(currentPath, 'node_modules', name), join(nm, name));
  }
  mkdirSync(join(nm, '@retrace-dev')); symlinkSync(join(root, 'core'), join(nm, '@retrace-dev/core'));
  const path = join(root, 'core/dist/classify.js'); let text = readFileSync(path, 'utf8');
  for (const stage of ['preliminary', 'complete']) {
    const pattern = new RegExp(`(const ${stage} = classifierCaptureSeals\\([^\\n]+;)`);
    assert.ok(pattern.test(text), `${label} ${stage} instrumentation anchor`);
    const boundary = label === 'old' ? 'firstStampedSeq([...events.values()], {repoName: opts.canonicalRepo})' : 'boundary';
    text = text.replace(pattern, `$1\n globalThis.__captureReplayTrace?.({stage: '${stage}', boundary: ${boundary}, rowsRead, result: ${stage}});`);
  }
  writeFileSync(path, text);
  return root;
}
const roots = { old: snapshot('old', resolve(baselinePath)), new: snapshot('new', currentPath) };
const modules = {};
for (const [label, root] of Object.entries(roots)) modules[label] = {
  core: await import(pathToFileURL(join(root, 'core/dist/index.js'))),
  capture: await import(pathToFileURL(join(root, 'core/dist/capture.js'))),
  sqlite: (await import(pathToFileURL(join(root, 'sqlite-store.js')))).SqliteStore,
};
const events = [...bundle.events].sort((a, b) => a.seq - b.seq);
const owners = events.filter(e => modules.old.core.ownerLoginRecord(e));
const commits = events.filter(e => Number.isInteger(e.method?.params?.claim_decision?.decision?.context?.read_head_seq));
const clean = value => JSON.parse(JSON.stringify(value, (key, v) => {
  if (key === 'timing' || key === 'classification_ms') return undefined;
  if (v instanceof Map) return [...v]; if (v instanceof Set) return [...v].sort();
  return v;
}));
const reports = [];
for (const kind of ['Memory', 'SQLite']) {
  const stores = {};
  for (const label of ['old', 'new']) {
    const { core, sqlite } = modules[label]; const store = kind === 'Memory' ? new core.MemoryEventStore() : new sqlite(':memory:');
    if (kind === 'Memory') store.events = events;
    else for (const e of events) await store.insert(e);
    for (const e of owners) {
      const record = core.ownerLoginRecord(e);
      for (const id of record.decision.consumed) {
        const row = { project: e.project, declaration_event_id: id, consumed_by_delivery: record.payload.delivery ?? null,
          consumed_by_event_id: e.id, consumed_by_seq: e.seq, consumed_at: e.received_at };
        if (kind === 'Memory') store.ownerLoginConsumption.set(`${e.project}\0${id}`, row);
        else store.db.prepare('INSERT INTO owner_login_consumption VALUES (?, ?, ?, ?, ?, ?)').run(...Object.values(row));
      }
    }
    stores[label] = store;
  }
  const report = { store: kind, owner_decisions: owners.length, commit_classifications: commits.length, matched: 0,
    capture_calls: 0, unknown_rows: 0, distinct_unknown_events: new Set(), boundaries: 0,
    raw_pairs: 0, matched_events: 0, semantic_pairs: 0, outcomes: {} };
  let records = 0;
  for (const e of [...owners, ...commits]) {
    const runs = {};
    for (const label of ['old', 'new']) {
      const { core } = modules[label], underlying = stores[label], reads = [], traces = [];
      globalThis.__captureReplayTrace = trace => traces.push(clean(trace));
      const store = new Proxy(underlying, { get(target, key) {
        if (key === 'eventsReferencingArtifacts' || key === 'captureIndexRows') return async (q, now, sink) => {
          const result = await target[key](q, now, sink);
          const entry = { query: { ...q, deadline: undefined }, ok: result.ok };
          if (!result.ok) entry.reason = result.reason;
          else {
            let pairs;
            if (key === 'captureIndexRows') pairs = result.rows.flatMap(row => row.keys.map(key => [row.seq, key]));
            else if (kind === 'SQLite') pairs = core.eventsReferencingArtifactsStatements(q).flatMap(({sql,params}) =>
              target.db.prepare(sql).all(...params).map(row => [row.seq, row.artifact_key]));
            else pairs = result.events.flatMap(event => core.artifactIndexRows(event)
              .filter(row => q.artifact_keys.some(key => modules[label].capture.sameArtifact(key, row.artifact_key)) || q.artifact_prefixes?.some(prefix => row.artifact_key.startsWith(prefix)))
              .map(row => [row.seq, row.artifact_key]));
            pairs = [...new Map(pairs.map(pair => [JSON.stringify(pair), pair])).values()];
            entry.raw_pairs = pairs.length; entry.events = new Set(pairs.map(pair => pair[0])).size;
            entry.semantic_pairs = pairs.filter(([, key]) => q.artifact_keys.some(k => modules[label].capture.sameArtifact(k, key)) || q.artifact_prefixes?.some(prefix => key.startsWith(prefix))).length;
            if (key === 'captureIndexRows') {
              report.capture_calls++; report.raw_pairs += entry.raw_pairs; report.matched_events += entry.events; report.semantic_pairs += entry.semantic_pairs;
              if (kind === 'SQLite') for (const {sql,params} of core.captureIndexStatements(q)) {
                for (const row of target.db.prepare(sql).all(...params)) if (row.stamped === null) {
                  report.unknown_rows++; report.distinct_unknown_events.add(row.seq);
                }
              }
            }
          }
          reads.push(entry); return result;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      }});
      const owner = core.ownerLoginRecord(e), record = owner ?? e.method.params.claim_decision;
      const context = record.decision.context;
      const policy = bundle.policies.find(doc => doc.digest === context.policy_digest); assert.ok(policy, `${e.id} policy`);
      const input = structuredClone(e), clock = Date.now();
      delete input.method.params.owner_login_decision; delete input.method.params.claim_decision;
      let result;
      if (owner) {
        const repo = e.artifacts.map(a => /^pr:(.+)#\d+$/.exec(a.id)?.[1]).find(Boolean) ?? '';
        result = await core.classifyOwnerLogin({ store, input, policy, canonicalR: repo,
          readHead: { seq: context.read_head_seq, hash: context.read_head_hash }, deadline: clock + 600_000, now: () => clock });
      } else {
        // Exports used for this build contain zero such records. Keep future runs explicit rather than silently skipping them.
        throw new Error(`commit classification ${e.id}: add its recorded context loader before extending this replay`);
      }
      const remaining = result.kind === 'decision' ? core.ownerLoginRecord(result.input).decision.timing.budget_rows_remaining : null;
      runs[label] = { result: clean(result), reads, traces, remaining };
    }
    assert.deepEqual(runs.new, runs.old, `${kind} ${e.id}: decisions, capture seals/boundaries, raw pairs, distinct events, semantic budget`);
    report.matched++; report.boundaries += runs.new.traces.length;
    const d = runs.new.result.kind === 'decision' ? modules.new.core.ownerLoginRecord(runs.new.result.input).decision : runs.new.result;
    const outcome = `${d.status ?? d.kind}/${d.reason ?? 'none'}`; report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;
    if (++records % 25 === 0) console.log(`${kind}: ${records}/${owners.length + commits.length} matched`);
  }
  assert.ok(report.capture_calls > 0 && report.boundaries > 0, 'replay must exercise capture reads and seal decisions');
  report.distinct_unknown_events = [...report.distinct_unknown_events].sort((a,b) => a-b);
  reports.push(report); console.log(JSON.stringify(report));
}
delete globalThis.__captureReplayTrace;
console.log(JSON.stringify({ source_sha256: sourceHash, events: events.length, reports }, null, 2));
