import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatesArtifact, buildProjectStatus, EventStore, parseTrailers, Event, AttributionPolicy, AttributionGitFacts, AttributionOptions, verifiedAttributionSnapshot, prepareAttributionContext, isAttributionAmendment, sameActor, preflightAttributionAmendment, AttributionRequest, collectAttributionAmendments, appendEvent, GENESIS_HASH } from "@retrace-dev/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { fetchVerifiedRemoteEvents } from "./verified-events.js";

const git = (repo: string, args: string[]) => execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
export function loadAttributionPolicy(repo: string, file?: string): AttributionPolicy {
  const raw = JSON.parse(readFileSync(file ?? join(repo,".retrace.json"),"utf8"));
  const policy = file ? raw : raw.attribution;
  if (!policy || policy.profile !== "retrace-attribution/1") throw new Error("context_missing: supply --policy <versioned-attribution-policy.json> or .retrace.json attribution");
  return policy;
}

/** Read Git facts without changing refs or the index. NUL-delimited paths preserve spaces and quotes. */
export function attributionGitFacts(repo: string, events: Event[], policy: AttributionPolicy, extraTargets: string[] = []): AttributionGitFacts {
  const object_format = git(repo,["rev-parse","--show-object-format"]).trim() as "sha1" | "sha256";
  const refs = git(repo,["for-each-ref","--format=%(refname) %(objectname)"]).trim().split("\n").filter(Boolean).sort();
  refs.push(`HEAD ${git(repo,["rev-parse","HEAD"]).trim()}`);
  const reachable = new Set(git(repo,["rev-list","--all","HEAD"]).trim().split("\n").filter(Boolean));
  const known = new Set(reachable);
  // Full object IDs retained by producer records can identify abandoned commits whose loose objects were collected.
  for (const e of events) {
    const key = /^git:([0-9a-f]{40}|[0-9a-f]{64})$/.exec(e.idempotency_key ?? ""); if (key) known.add(key[1]);
    for (const a of e.artifacts) { const m=/^commit:[^@]+@([0-9a-f]{40}|[0-9a-f]{64})$/.exec(a.id); if(m) known.add(m[1]); }
  }
  const resolutions: AttributionGitFacts["resolutions"] = {};
  for (const e of events.filter(e=>e.action === "committed" || e.action === "merged")) for (const a of e.artifacts) {
    const m = /^commit:([^@]+)@([0-9a-f]{7,64})$/.exec(a.id); if(!m) continue;
    const mapping = policy.repositories.filter(p => e.seq >= p.from_seq && e.seq <= (p.through_seq ?? Infinity) && [p.name,...p.aliases].includes(m[1]));
    if (mapping.length !== 1) throw new Error(`context_missing: repository policy for ${a.id} at #${e.seq}`);
    let oid: string;
    try { oid=git(repo,["rev-parse","--verify",`${m[2]}^{commit}`]).trim(); }
    catch {
      const matches=[...known].filter(s=>s.startsWith(m[2]));
      if(matches.length!==1) throw new Error(`context_missing: ambiguous or unknown full OID for ${a.id}`);
      oid=matches[0];
    }
    resolutions[a.id]={repo:mapping[0].name,oid};
  }
  const seals = events.filter(e => e.action === "committed" || e.action === "merged").flatMap(e=>e.artifacts.filter(a=>resolutions[a.id]).map(a=>({seq:e.seq,...resolutions[a.id]})));
  const horizon = seals.filter(s=>reachable.has(s.oid)).reduce((n,s)=>Math.min(n,s.seq),Infinity);
  const excluded = [...new Set(seals.filter(s=>s.seq>=horizon && !reachable.has(s.oid)).map(s=>`${s.repo}@${s.oid}`))].sort();
  const targetIds=new Set([...extraTargets,...events.filter(isAttributionAmendment).map(e=>String(e.method?.params?.target_event_id))]);
  const commits: AttributionGitFacts["commits"] = [];
  for(const e of events.filter(e=>targetIds.has(e.id) && (e.action === "committed" || e.action === "merged"))) {
    const r=e.artifacts.map(a=>resolutions[a.id]).find(Boolean); if(!r) throw new Error(`context_missing: target OID ${e.id}`);
    if(commits.some(c=>c.repo===r.repo && c.oid===r.oid)) continue;
    const parents=git(repo,["show","-s","--format=%P",r.oid]).trim().split(" ").filter(Boolean);
    const args=parents.length ? ["diff","--name-status","-z","-M","-C",parents[0],r.oid,"--"] : ["diff-tree","--root","--no-commit-id","--name-status","-r","-z","-M","-C",r.oid,"--"];
    const tokens=git(repo,args).split("\0"); if(tokens.at(-1)==="")tokens.pop();
    const files: AttributionGitFacts["commits"][number]["files"] = [];
    while(tokens.length) { const status=tokens.shift()![0]; const path=tokens.shift(); if(path===undefined) throw new Error("context_conflict: malformed Git diff");
      if(status==="R"||status==="C") { const dest=tokens.shift(); if(dest===undefined) throw new Error("context_conflict: missing rename destination"); files.push({status,path:dest,from:path}); }
      else files.push({status,path});
    }
    commits.push({...r,parents,diff_profile:"first-parent-M-C/1",files});
  }
  return {resolutions,commits,excluded,refs,object_format};
}

export async function attributionOptionsForRepo(repo: string, events: Event[], project: string, extraTargets: string[] = [], policyFile?: string): Promise<AttributionOptions> {
  const snapshot=await verifiedAttributionSnapshot(events,project,{seq:events.length-1,hash:events.at(-1)?.hash ?? GENESIS_HASH});
  const policy=loadAttributionPolicy(repo,policyFile);
  const facts=attributionGitFacts(repo,snapshot.events,policy,extraTargets);
  const context=await prepareAttributionContext(snapshot,policy,facts,extraTargets);
  const contentBoundArtifacts=(target:Event,evidence:Event[]):string[]=> {
    const r=target.artifacts.map(a=>facts.resolutions[a.id]).find(Boolean); if(!r) return [];
    const diff=facts.commits.find(c=>c.oid===r.oid && c.repo===r.repo); if(!diff) return [];
    const bound:string[]=[];
    for(const f of diff.files) {
      if(f.status==="D")continue;
      try {
        const entry=git(repo,["ls-tree","-z",r.oid,"--",f.path]).split("\0")[0];
        const match=/^[0-7]+ blob ([0-9a-f]+)\t/.exec(entry); if(!match)continue;
        const id=`repo:${r.repo}#${f.path}`;
        if (evidence.some(e => {
          const outputs = new Set(e.artifacts.filter(a => generatesArtifact(e, a)).map(a => context.canonicalArtifact(a.id, e.seq)));
          return e.change?.after_hash === match[1] && outputs.size === 1 && outputs.has(id);
        })) bound.push(id);
      } catch { /* optional blob observation does not decide effectiveness */ }
    }
    return bound;
  };
  const trailerCorroborated=(target:Event,evidence:Event[],to:{type:string;id:string}):boolean=> {
    if(to.type!=="agent")return false;
    const targetCommit=target.artifacts.map(a=>facts.resolutions[a.id]).find(Boolean);
    if(!targetCommit)return false;
    return evidence.some(e=> {
      if(e.action!=="committed" || !/^(assert:|webhook:)/.test(String(e.method?.params?.sealed_by ?? "")))return false;
      const commit=e.artifacts.map(a=>facts.resolutions[a.id]).find(Boolean);
      if(!commit || commit.repo!==targetCommit.repo || commit.oid!==targetCommit.oid)return false;
      try { return parseTrailers(git(repo,["show","-s","--format=%B",commit.oid])).trailers["retrace-actor"]?.includes(to.id) === true; } catch {return false;}
    });
  };
  return {snapshot,context,contentBoundArtifacts,trailerCorroborated};
}

export async function amendAttributionMain(flags: Record<string,string|boolean>): Promise<number> {
  const required=(name:string)=> {const v=flags[name];if(typeof v!=="string"||!v)throw new Error(`--${name} is required`);return v;};
  const pair=(s:string)=> {const m=/^(human|agent|system)\/(.+)$/.exec(s);if(!m)throw new Error("actor must be type/id");return {type:m[1] as "human"|"agent"|"system",id:m[2]};};
  const repo=typeof flags.repo==="string"?flags.repo:process.cwd();
  const cfg=JSON.parse(readFileSync(join(repo,".retrace.json"),"utf8"));
  const project=typeof flags.project==="string"?flags.project:cfg.project;
  if(!project)throw new Error("--project is required");
  const request:AttributionRequest={project,target_event_id:required("target"),to:pair(required("to")),evidence:required("evidence").split(","),caused_by:required("caused-by"),reason:required("reason"),...(typeof flags.from==="string"?{from:pair(flags.from)}:{}),...(typeof flags.artifacts==="string"?{artifacts:flags.artifacts.split(",")}:{}),...(typeof flags.supersedes==="string"?{supersedes:flags.supersedes}:{})};
  const human=required("human");
  // Human selection is explicit; the remote server still independently resolves and stamps the submitted actor.
  const store=makeStore();
  const authority=store instanceof RemoteStore ? await store.humanAuthority() : {actor:{type:"human" as const,id:human},sealed_by:"owner" as const,attribution_profile:"retrace-attribution/1"};
  if(authority.attribution_profile!=="retrace-attribution/1" || authority.sealed_by!=="owner" || !sameActor(authority.actor,{type:"human",id:human})) throw new Error("human authority does not match --human");
  const read=async()=>store instanceof RemoteStore ? (await fetchVerifiedRemoteEvents(store,project,flags.pubkey,undefined,{project})).events : await store.all(project);
  const evaluate=async()=> {const events=await read();const options=await attributionOptionsForRepo(repo,events,project,[request.target_event_id],typeof flags.policy==="string"?flags.policy:undefined);return {options,preflight:preflightAttributionAmendment(request,authority,options)};};
  let {options,preflight}=await evaluate();
  const preview=()=> {
    const diagnostics=options.context!.diagnostics;
    const by_reason:Record<string,number>={};
    for(const diagnostic of diagnostics)by_reason[diagnostic.reason]=(by_reason[diagnostic.reason]??0)+1;
    return {recorded:false,advisory:true,head:options.snapshot!.head,policy_digest:options.context!.policy_digest,git_facts_digest:options.context!.git_facts_digest,diagnostics_summary:{total:diagnostics.length,by_reason},...(flags.verbose?{diagnostics}:{}),result:preflight.result,affected:preflight.affected,input:preflight.input};
  };
  if(flags["dry-run"]){console.log(JSON.stringify(preview(),null,2));return preflight.result.ok?0:1;}
  if(!preflight.result.ok && (!flags["seal-anyway"] || ["malformed","relay_disabled","untrusted_authority"].includes(preflight.result.reason)))throw new Error(`amendment rejected: ${preflight.result.reason}`);
  // Recheck immediately before submission. Acceptance remains advisory under concurrent writes.
  const fresh=await read();if(fresh.at(-1)?.hash!==options.snapshot!.head.hash)({options,preflight}=await evaluate());
  if(!preflight.result.ok && (!flags["seal-anyway"] || ["malformed","relay_disabled","untrusted_authority"].includes(preflight.result.reason)))throw new Error(`amendment rejected: ${preflight.result.reason}`);
  const input={...preflight.input,idempotency_key:`attribution-attempt:${crypto.randomUUID()}`};
  const {event}=store instanceof RemoteStore?await store.append(input):await appendEvent(store,{...input,method:{...input.method,params:{...input.method?.params,sealed_by:"owner"}}});
  // Print the durable ID before any fallible post-write read.
  console.log(JSON.stringify({recorded:true,id:event.id}));
  if(!sameActor(event.actor,{type:"human",id:human}))throw new Error("sealed actor differs from requested human authority");
  try {
    const all=await read(), after=await attributionOptionsForRepo(repo,all,project,[],typeof flags.policy==="string"?flags.policy:undefined);
    const result=collectAttributionAmendments(all, after);
    const active=[...result.effective.values()].flat().some(a=>a.amendment_id===event.id);
    console.log(JSON.stringify({recorded:true,id:event.id,effective:active,unavailable:result.unavailable,rejection:result.rejected.find(r=>r.event.id===event.id)?.reason}));return active?0:2;
  }catch(error){console.error(`recorded ${event.id}; attribution evaluation unavailable: ${error instanceof Error?error.message:error}`);return 2;}
}

export async function attributionViewForEvents(repo: string, events: Event[], project: string, policyFile?: string) {
  const result=collectAttributionAmendments(events);
  if (!events.some(isAttributionAmendment)) return result;
  try { return collectAttributionAmendments(events, await attributionOptionsForRepo(repo,events,project,[],policyFile)); }
  catch(error) { return {...result,unavailable:error instanceof Error?error.message:String(error)}; }
}

/** Remote projections require the authenticated export/head path, not a head inferred from an event page. */
export async function attributionViewForStore(store: ReturnType<typeof makeStore>, repo: string, project: string) {
  try {
    const events = store instanceof RemoteStore ? (await fetchVerifiedRemoteEvents(store, project, undefined, undefined, { project })).events : await store.all(project);
    return await attributionViewForEvents(repo, events, project);
  } catch (error) {
    return {...collectAttributionAmendments([]), unavailable: error instanceof Error ? error.message : String(error)};
  }
}

export async function attributionStatusForStore(store: ReturnType<typeof makeStore>, repo: string, project: string) {
  const events = store instanceof RemoteStore ? (await fetchVerifiedRemoteEvents(store, project, undefined, undefined, { project })).events : await store.all(project);
  const snapshotStore: EventStore = Object.create(store);
  snapshotStore.all = async () => events;
  try {
    const options = events.some(isAttributionAmendment) ? await attributionOptionsForRepo(repo, events, project) : undefined;
    return await buildProjectStatus(snapshotStore, project, new Date(), options);
  } catch (error) {
    const status = await buildProjectStatus(snapshotStore, project);
    status.capture.attribution_unavailable = error instanceof Error ? error.message : String(error);
    return status;
  }
}
