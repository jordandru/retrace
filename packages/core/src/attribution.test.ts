import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, GENESIS_HASH } from "./schema.js";
import { computeHash } from "./chain.js";
import { collectAttributionAmendments, effectiveActor, preflightAttributionAmendment, AttributionOptions } from "./attribution.js";
import { verifiedAttributionSnapshot, prepareAttributionContext, AttributionGitFacts, AttributionPolicy } from "./attribution-context.js";
import { collectProvenanceAmendments, collectRejectedAmendments } from "./amendment.js";
import { reconcile } from "./reconcile.js";
import { renderTimeline, renderWhyChain } from "./explain.js";
import { buildProjectStatus, causalRootState } from "./status.js";
import { buildLineage, renderLineageDot, renderLineageMermaid, lineageForModel } from "./lineage.js";
import { buildExportBundle, verifyExportBundle } from "./export.js";
import { renderReportHtml } from "./report.js";

const actor = (id:string,type:Event["actor"]["type"]="agent") => ({type,id});
const O=actor("O"), B=actor("B"), C=actor("C"), H=actor("H","human");
const ids=(...names:string[])=>names.map(id=>({id,role:"generated" as const}));
function ev(id:string,who=O,artifacts=ids("doc:a","doc:b"),action:Event["action"]="edited"):Event {
  return {id,seq:0,project:"p",actor:who,action,artifacts,caused_by:"R",timestamp:"2026-09-07T00:00:00Z",received_at:"2026-09-07T00:00:00Z",hash_v:2,prev_hash:GENESIS_HASH,hash:"",method:{params:{sealed_by:who.type==="human"?"owner":`pinned:${who.id}`}}};
}
function amendment(id:string,target="T",from=O,to=B,scope?:string[],evidence=["E"],supersedes?:string):Event {
  return {...ev(id,H,[{id:`event:${target}`,role:"used"} as any,...evidence.map(id=>({id:`event:${id}`,role:"used"} as any))],"other"),action_detail:"amended",tags:["amendment","attribution"],intent:"corroborated human correction",method:{tool:"retrace_amend",params:{sealed_by:"owner",target_event_id:target,attribution:{from,to,...(scope?{artifacts:scope}:{}),evidence,...(supersedes?{supersedes}:{})}}}};
}
const root=()=>({...ev("R",H,ids("task:r"),"instructed"),caused_by:undefined});
const base=()=>[root(),ev("G",C),ev("E",B),ev("T"),amendment("A")];
const policy:AttributionPolicy={profile:"retrace-attribution/1",repositories:[{name:"org/r",aliases:["r"],from_seq:0,hook_sealed_by:["assert:hook"]}],non_git:[{scheme:"doc",from_seq:0,capture_stamps:["assert:capture"]},{scheme:"task",from_seq:0,capture_stamps:[]}]};
const noGit=():AttributionGitFacts=>({resolutions:{},commits:[],excluded:[],refs:[],object_format:"sha1"});
async function prepare(input:Event[],facts=noGit(),p=policy) {
  const events=structuredClone(input);
  for(let i=0;i<events.length;i++){events[i].seq=i;events[i].prev_hash=i?events[i-1].hash:GENESIS_HASH;events[i].hash=await computeHash(events[i]);}
  const snapshot=await verifiedAttributionSnapshot(events,"p",{seq:events.length-1,hash:events.at(-1)!.hash});
  const context=await prepareAttributionContext(snapshot,p,facts,["T","E","G"]);
  const options:AttributionOptions={snapshot,context};
  return {events,options,result:collectAttributionAmendments(events, options)};
}
const reason=(r:Awaited<ReturnType<typeof prepare>>,id="A")=>r.result.rejected.find(x=>x.event.id===id)?.reason;
const active=(r:Awaited<ReturnType<typeof prepare>>,target="T")=>r.result.effective.get(target)??[];

test("v7 B1 / v6 4, 5h: a beneficiary's signed-in claim plus human selection is effective, not proof of authorship",async()=>{
  const x=base();x[3].actor={...O,model:"old-model",display_name:"old display",on_behalf_of:"principal"};
  x[3].artifacts.push({id:"event:context",role:"used"} as any);
  x[3].artifacts.push({id:"doc:input",role:"used"} as any);
  const r=await prepare(x);const before=JSON.stringify(r.events);
  assert.equal(active(r)[0].whole_event,true);
  assert.deepEqual(effectiveActor(r.events[3],r.result.effective).actor,{...B,on_behalf_of:"principal"});
  assert.equal(effectiveActor(r.events[3],r.result.effective).by_artifact.has("doc:input"),false);
  assert.equal(JSON.stringify(r.events),before);
});

for(const [name,modify,expected] of [
  ["mixed kinds and precedence",(x:Event[])=>{x[4].method!.params!.artifact_roles=[];x[4].caused_by="absent";},"malformed"],
  ["unrooted",(x:Event[])=>{x[4].caused_by="absent";},"unrooted"],
  ["missing target",(x:Event[])=>{x[4].method!.params!.target_event_id="absent";x[4].artifacts[0].id="event:absent";},"missing_target"],
  ["instruction target",(x:Event[])=>{x[4].method!.params!.target_event_id="R";x[4].artifacts[0].id="event:R";},"target_is_instruction"],
  ["agent relay",(x:Event[])=>{x[4].actor=B;},"relay_disabled"],
  ["unstamped authority",(x:Event[])=>{delete x[4].method!.params!.sealed_by;},"untrusted_authority"],
  ["pinned human authority",(x:Event[])=>{x[4].method!.params!.sealed_by="pinned:H";},"untrusted_authority"],
  ["human beneficiary",(x:Event[])=>{(x[4].method!.params!.attribution as any).to=H;},"human_beneficiary_unsupported"],
  ["model injection",(x:Event[])=>{(x[4].method!.params!.attribution as any).to={...B,model:"forged"};},"malformed"],
  ["self-interested operator",(x:Event[])=>{x[4].actor={...H,id:B.id};},"self_interested"],
  ["no-op",(x:Event[])=>{(x[4].method!.params!.attribution as any).to=O;},"no_op"],
  ["unknown actor",(x:Event[])=>{(x[4].method!.params!.attribution as any).to=actor("unknown");},"unknown_actor"],
  ["foreign scope",(x:Event[])=>{(x[4].method!.params!.attribution as any).artifacts=["doc:c"];},"scope_invalid"],
  ["empty scope",(x:Event[])=>{(x[4].method!.params!.attribution as any).artifacts=[];},"scope_invalid"],
  ["input evidence",(x:Event[])=>{x[2].artifacts=ids("doc:a","doc:b").map(a=>({...a,role:"used"})) as any;},"uncorroborated"],
  ["partial coverage",(x:Event[])=>{x[2].artifacts=ids("doc:a");},"partial_coverage"],
  ["stale from",(x:Event[])=>{(x[4].method!.params!.attribution as any).from=C;},"stale_from"],
  ["actor type collision",(x:Event[])=>{x[1].actor=B;x[1].artifacts=ids("doc:other");x[2].actor=actor("B","system");},"uncorroborated"],
  ["unstamped primary witness",(x:Event[])=>{x[1].actor=B;x[1].artifacts=ids("doc:other");delete x[2].method!.params!.sealed_by;},"uncorroborated"],
] as const)test(`attribution rejects ${name}`,async()=>{const x=base();modify(x);assert.equal(reason(await prepare(x)),expected);});

test("v6 4c–4e / B2: disjoint scopes, multiple overlap, scoped from and full predecessor removal",async()=>{
  const x=base();x[4]=amendment("A","T",O,B,["doc:a"]);x.push(amendment("B","T",O,B,["doc:b"]));
  x.push(amendment("bad","T",B,C,["doc:a","doc:b"],["G"],"B"));
  let r=await prepare(x);assert.equal(reason(r,"bad"),"no_supersede");assert.equal(active(r).length,2);assert.deepEqual(effectiveActor(r.events[3],r.result.effective).actor,O);
  const y=base();y.push(amendment("next","T",B,C,["doc:a"],["G"],"A"));r=await prepare(y);
  assert.deepEqual(r.result.superseded.map(a=>a.amendment_id),["A"]);
  assert.deepEqual([...effectiveActor(r.events[3],r.result.effective).by_artifact.keys()],["doc:a"]);
  assert.deepEqual(effectiveActor(r.events[3],r.result.effective).actor,O);
});

test("v6 7b: rejected overlapping append leaves the first amendment active",async()=>{
  const x=base();x.push(amendment("next","T",O,C,undefined,["G"]));const r=await prepare(x);
  assert.equal(reason(r,"next"),"no_supersede");assert.deepEqual(active(r).map(a=>a.amendment_id),["A"]);
});

test("v6 7g–7i: final-ledger cascade, successor rejection, reactivation, and input permutation",async()=>{
  const x=[root(),ev("F",actor("D")),ev("G",C),ev("E",B),ev("W",C),ev("T"),amendment("A1","T",O,B),amendment("A2","T",B,C,undefined,["W"],"A1"),amendment("X","E",B,C,undefined,["G"]),amendment("Y","G",C,actor("D"),undefined,["F"])];
  const before=await prepare(x.slice(0,8));assert.equal(active(before)[0].amendment_id,"A2");
  const withdrawn=await prepare(x.slice(0,9));assert.equal(reason(withdrawn,"A1"),"evidence_amended");assert.equal(reason(withdrawn,"A2"),"no_supersede");assert.equal(active(withdrawn).length,0);
  const restored=await prepare(x);assert.equal(reason(restored,"X"),"evidence_amended");assert.equal(active(restored)[0].amendment_id,"A2");
  const state=(r:ReturnType<typeof collectAttributionAmendments>)=>JSON.stringify({effective:[...r.effective],superseded:r.superseded,rejected:r.rejected.map(x=>[x.event.id,x.reason]),unavailable:r.unavailable});
  const expected=state(restored.result);
  let seed=2139;
  for(let i=0;i<100;i++) {const perm=[...restored.events];for(let j=perm.length-1;j>0;j--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const k=seed%(j+1);[perm[j],perm[k]]=[perm[k],perm[j]];}assert.equal(state(collectAttributionAmendments(perm, restored.options)),expected);}
});

test("event-wide witness exclusion and surviving alternative/missing extra citation",async()=>{
  const x=base();x[4]=amendment("A","T",O,B,["doc:a"]);x.push(amendment("X","E",B,C,["doc:b"],["G"]));
  assert.equal(reason(await prepare(x)),"evidence_amended");
  const y=base();y.splice(3,0,ev("E2",B));y[5]=amendment("A","T",O,B,["doc:a"],["E","E2","missing"]);y.push(amendment("X","E",B,C,["doc:b"],["G"]));
  assert.equal(active(await prepare(y)).length,1);
});

test("non-Git capture policy: ordinary edits do not bound windows, exact capture stamps do",async()=>{
  const x=base();x.splice(3,0,{...ev("capture",actor("capture","system"),ids("doc:b"),"committed"),method:{params:{sealed_by:"assert:capture"}}});
  const r=await prepare(x);assert.equal(reason(r),"partial_coverage");
  await assert.rejects(()=>prepare(base(),noGit(),{...policy,non_git:[]}),/context_missing/);
});

test("snapshots: incomplete, forged, conflicting and tampered inputs never yield an active map",async()=>{
  const r=await prepare(base());
  assert.equal(collectAttributionAmendments(r.events).unavailable,"untrusted_snapshot");
  assert.equal(collectAttributionAmendments(r.events.slice(1), r.options).unavailable,"incomplete_snapshot");
  await assert.rejects(()=>verifiedAttributionSnapshot([...r.events,{...r.events[2],intent:"changed"}],"p",r.options.snapshot!.head),/conflicting id/);
  await assert.rejects(()=>verifiedAttributionSnapshot(r.events.map((e,i)=>i===2?{...e,intent:"changed"}:e),"p",r.options.snapshot!.head),/invalid_snapshot/);
  const duplicate=await verifiedAttributionSnapshot([...r.events,r.events[2]],"p",r.options.snapshot!.head);assert.equal(duplicate.events.length,5);
});

test("attribution attempts cannot also act as provenance amendments",async()=>{
  const r=await prepare(base());assert.equal(collectProvenanceAmendments(r.events,()=>true).size,0);assert.equal(collectRejectedAmendments(r.events,()=>false).length,0);
});

test("preflight uses an after-head position and returns an unsigned, unsealed input",async()=>{
  const r=await prepare(base().slice(0,4));
  const p=preflightAttributionAmendment({project:"p",target_event_id:"T",to:B,evidence:["E"],caused_by:"R",reason:"human review"},{actor:H,sealed_by:"owner"},r.options);
  assert.equal(p.result.ok,true);for(const key of ["seq","id","received_at","hash","prev_hash"])assert.equal(key in p.input,false);
  assert.equal(p.input.method?.params?.sealed_by,undefined);
});

test("Git eligible universe, same-SHA cutoff and reconcile per-file certificate",async()=>{
  const oid="a".repeat(40),cid=`commit:org/r@${oid}`,arts=[{id:cid,role:"generated" as const},...ids("repo:org/r#a","repo:org/r#b")];
  const x=[root(),ev("E",B,ids("repo:r#a","repo:r#b")),{...ev("T",O,arts,"committed"),method:{tool:"git",params:{sealed_by:"assert:hook"}}}, {...ev("W",O,arts,"committed"),tags:["push"],method:{params:{sealed_by:"webhook:github"}}},amendment("A")];
  const facts:AttributionGitFacts={...noGit(),resolutions:{[cid]:{repo:"org/r",oid}},commits:[{repo:"org/r",oid,parents:[],diff_profile:"first-parent-M-C/1",files:[{path:"a",status:"A"},{path:"b",status:"A"}]}]};
  let r=await prepare(x,facts);assert.equal(active(r)[0].whole_event,true);assert.deepEqual(active(r)[0].artifacts,["repo:org/r#a","repo:org/r#b"]);
  const commits=[{sha:oid,parents:[],files:[{path:"a",status:"A" as const},{path:"b",status:"A" as const}]}];
  const report=reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});
  assert.equal(report.ok,true);assert.equal(report.commits[0].findings.find(f=>f.kind==="misattributed")?.amended?.files.length,2);
  x[4]=amendment("A","T",O,B,["repo:org/r#a"]);r=await prepare(x,facts);
  const partial=reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});assert.equal(partial.ok,false);
  x[4]=amendment("A","W",O,B);r=await prepare(x,facts);assert.equal(active(r,"W")[0].whole_event,true);
  assert.equal(r.options.context!.domains.get("W")!.units[0].before,2);
  assert.equal(reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options}).ok,false,"amending webhook cannot clear the selected hook failure");
  x[3].actor=C;x[4]=amendment("A");r=await prepare(x,facts);
  const disagreement=reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});assert.equal(disagreement.ok,false);assert.equal(disagreement.commits[0].findings.some(f=>f.amended),false);
});

test("v6 7c, 7f, 8: amendment target, rejected predecessor, and pre-planted attempt",async()=>{
  const x=base();x.push(amendment("nested","A",H,C,["doc:a"],["G"]));assert.equal(reason(await prepare(x),"nested"),"target_is_amendment");
  const y=base();y[4]=amendment("bad","T",O,B,["doc:missing"]);y.push(amendment("A","T",B,C,undefined,["G"],"bad"));
  assert.equal(reason(await prepare(y)),"no_supersede");
  const z=base();[z[3],z[4]]=[z[4],z[3]];assert.equal(reason(await prepare(z)),"not_older");
});

test("v6 5d: human structured correction and prose never substitute for covering evidence",async()=>{
  const x=base();x[2]={...ev("correction",H,[{id:"commit:r@aaaaaaa",role:"used"} as any],"other"),tags:["correction"],intent:"B really did it",method:{params:{sealed_by:"owner",attributed_to:"B"}}};
  x[1].actor=B;x[1].artifacts=ids("doc:unrelated");x[4]=amendment("A","T",O,B,undefined,["correction"]);
  assert.equal(reason(await prepare(x)),"uncorroborated");
});

test("v6 5g: content observations are optional and do not decide effectiveness",async()=>{
  const r=await prepare(base());
  for(const bound of [undefined,[],["doc:a"],["doc:a","doc:b"]]) {
    const c=collectAttributionAmendments(r.events, {...r.options,...(bound?{contentBoundArtifacts:()=>bound}:{})});
    assert.equal(c.effective.get("T")?.length,1);
    assert.equal(c.effective.get("T")![0].flags.content_bound,bound?.length===2?true:undefined);
    assert.deepEqual(c.effective.get("T")![0].flags.content_bound_artifacts,bound??[]);
  }
});

test("v6 9b: amending an edit never changes ordinary recorded covering actors",async()=>{
  const oid="b".repeat(40),cid=`commit:org/r@${oid}`,f="repo:org/r#a";
  const x=[root(),ev("G",C,ids(f)),ev("E",B,ids(f)),{...ev("T",O,[{id:cid,role:"generated"},...ids(f)],"committed"),method:{tool:"git",params:{sealed_by:"assert:hook"}}},amendment("edit-correction","E",B,C,[f],["G"])];
  const facts:AttributionGitFacts={...noGit(),resolutions:{[cid]:{repo:"org/r",oid}},commits:[{repo:"org/r",oid,parents:[],diff_profile:"first-parent-M-C/1",files:[{path:"a",status:"A"}]}]};
  const r=await prepare(x,facts);
  const report=reconcile([{sha:oid,parents:[],files:[{path:"a",status:"A"}]}],r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});
  assert.deepEqual(report.commits[0].coverage.a.actor_refs,[C,B]);
  assert.equal(report.ok,false);
});

test("v6 9c/9d: dual-seal disagreement reads recorded pairs despite effective agreement",async()=>{
  const oid="c".repeat(40),cid=`commit:org/r@${oid}`,f="repo:org/r#a";
  const x=[root(),ev("E",B,ids(f)),{...ev("T",O,[{id:cid,role:"generated"},...ids(f)],"committed"),method:{tool:"git",params:{sealed_by:"assert:hook"}}},{...ev("W",O,[{id:cid,role:"generated"},...ids(f)],"committed"),tags:["push"],method:{params:{sealed_by:"webhook:github"}}},amendment("A")];
  const facts:AttributionGitFacts={...noGit(),resolutions:{[cid]:{repo:"org/r",oid}},commits:[{repo:"org/r",oid,parents:[],diff_profile:"first-parent-M-C/1",files:[{path:"a",status:"A"}]}]};
  const commits=[{sha:oid,parents:[],files:[{path:"a",status:"A" as const}]}];
  let r=await prepare(x,facts);let report=reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});
  assert.equal(report.commits[0].findings.some(f=>f.kind==="producer_disagreement"),false);assert.equal(report.summary.amended,1);
  x[3].actor=B;r=await prepare(x,facts);assert.deepEqual(effectiveActor(r.events[2],r.result.effective).actor,B);
  report=reconcile(commits,r.events,{repoName:"org/r",hookSealedBy:["assert:hook"],attribution:r.options});assert.equal(report.commits[0].findings.some(f=>f.kind==="producer_disagreement"),true);assert.equal(report.ok,false);
});

test("render/status/lineage/export: default banner, effective header, partial count, and immutable bundle",async()=>{
  const x=base();x[4]=amendment("A","T",O,B,["doc:a"]);const r=await prepare(x);
  const text=renderTimeline(r.events,{attribution:r.result,banner:true});assert.match(text,/^attribution amendments: 1 effective/);assert.match(text,/1 of 2 artifacts/);
  assert.match(renderWhyChain([r.events[3],r.events[0]],{attribution:r.result}),/1 of 2 artifacts/);
  assert.match(renderTimeline(r.events,{attribution:r.result,banner:true,effective:true}),/^effective view — recorded actors in parentheses/);
  const store={all:async()=>r.events,head:async()=>({seq:r.events.length-1,hash:r.events.at(-1)!.hash}),get:async(id:string)=>r.events.find(e=>e.id===id)??null} as any;
  const status=await buildProjectStatus(store,"p",new Date(),r.options);assert.equal(status.capture.partially_amended_events,1);assert.equal(status.capture.attribution_amended_events,0);
  const graph=buildLineage(r.events,{includeActors:true,attribution:r.result});assert.ok(graph.edges.some(e=>e.type==="recorded-as"&&e.from==="u:agent/B"&&e.to==="u:agent/O"));assert.match(renderLineageDot(graph),/recorded-as/);
  const bundle=await buildExportBundle(store,{project:"p"});const bytes=JSON.stringify(bundle.events);
  assert.match(renderReportHtml(bundle,undefined,{attribution:r.result}),/1 of 2 artifacts/);assert.equal(JSON.stringify(bundle.events),bytes);
  const verdict=await verifyExportBundle(bundle);assert.equal(verdict.events_intact,true);
  assert.match(renderTimeline([r.events[3]],{attribution:collectAttributionAmendments(r.events)}),/attribution evaluation unavailable/);
});

test("scoped lineage/report disclose unavailable attribution in every format without changing the full projection",async()=>{
  const r=await prepare(base());const graph=buildLineage([r.events[3]],{includeActors:true,attribution:{...r.result,unavailable:"incomplete_snapshot: scoped lineage"}});
  assert.equal(graph.edges.some(e=>e.type==="recorded-as"),false);
  assert.match(renderLineageDot(graph),/attribution evaluation unavailable/);assert.match(renderLineageMermaid(graph),/attribution evaluation unavailable/);assert.match(lineageForModel(graph).attribution_unavailable!,/incomplete_snapshot/);
  const store={all:async()=>r.events} as any;const bundle=await buildExportBundle(store,{project:"p"});bundle.scope.artifact_id="doc:a";
  assert.match(renderReportHtml(bundle,undefined,{attribution:r.result}),/attribution evaluation unavailable/);assert.equal(r.result.unavailable,undefined);
});

test("v6 9f: reconcile does not collapse matching ids across actor types",async()=>{
  const oid="d".repeat(40),cid=`commit:org/r@${oid}`,f="repo:org/r#a";
  const seal={...ev("T",B,[{id:cid,role:"generated"},...ids(f)],"committed"),method:{tool:"git",params:{sealed_by:"assert:hook"}}};
  const events=[root(),ev("E",O,ids(f)),ev("system",actor("B","system"),ids(f)),seal,{...seal,id:"W",actor:actor("B","system"),tags:["push"],method:{params:{sealed_by:"webhook:github"}}}].map((e,seq)=>({...e,seq}));
  const report=reconcile([{sha:oid,parents:[],files:[{path:"a",status:"A"}]}],events,{repoName:"org/r",hookSealedBy:["assert:hook"]});
  assert.equal(report.commits[0].findings.some(f=>f.kind==="producer_disagreement"&&f.level==="fail"),true);
  assert.equal(report.commits[0].findings.some(f=>f.kind==="misattributed"&&f.level==="fail"),true);
  assert.deepEqual(report.commits[0].coverage.a.actor_refs,[O]);
});

test("human amendment authority accepts owner/assert and rejects pinned, webhook and unauthenticated receipts",async()=>{
  for(const stamp of ["owner","assert:human-operator","pinned:H","webhook:github","unauthenticated"]){
    const x=base();x[4].method!.params!.sealed_by=stamp;const r=await prepare(x);
    if(stamp==="owner"||stamp.startsWith("assert:"))assert.equal(active(r).length,1,stamp);
    else assert.equal(reason(r),"untrusted_authority",stamp);
  }
});

test("v6 5d witness-and-notary: a covering edit exists but citing only the same human's correction is insufficient",async()=>{
  const x=base();const correction={...ev("notary",H,[{id:"commit:r@aaaaaaa",role:"used"},{id:"event:E",role:"used"}] as any,"other"),tags:["correction"],method:{params:{sealed_by:"owner",attributed_to:B.id}},location:{session:"same-human-session"}};
  x[3].artifacts.push({id:"commit:r@aaaaaaa",role:"used"} as any);
  x.splice(4,0,correction);x[5]=amendment("A","T",O,B,undefined,["notary"]);x[5].location={session:"same-human-session"};
  assert.equal(reason(await prepare(x)),"uncorroborated");
  (x[5].method!.params!.attribution as any).evidence.push("E");x[5].artifacts.push({id:"event:E",role:"used"});
  assert.equal(active(await prepare(x)).length,1,"directly citing the existing edit changes the outcome");
});

test("shared causal root walker: strict attribution parents reject forward/foreign links and cycles",()=>{
  const r={...root(),seq:0},e={...ev("E"),seq:1};
  const state=(events:Event[])=>causalRootState(events[1],new Map(events.map(x=>[x.id,x])),{strictParents:true});
  assert.equal(state([r,e]),"rooted");
  assert.equal(state([{...r,seq:2},e]),"broken");
  assert.equal(state([{...r,project:"foreign"},e]),"broken");
  assert.equal(state([r,{...e,caused_by:undefined}]),"unlinked");
  assert.equal(state([r,{...e,caused_by:"missing"}]),"broken");
  assert.equal(state([r,{...e,caused_by:e.id}]),"broken");
});
