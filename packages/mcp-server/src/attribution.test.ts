import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "./index.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSigningKey, buildExportBundle, appendEvent, collectAttributionAmendments, AttributionPolicy } from "@retrace-dev/core";
import { SqliteStore } from "./sqlite-store.js";
import { attributionDeployment } from "./doctor.js";
import { attributionOptionsForRepo } from "./attribution.js";

test("human CLI: dry-run, sealed amendment, real blob/trailer observations and exported render pairing",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"retrace-attribution-"));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith("RETRACE_")&&!k.startsWith("GIT_")));
  Object.assign(env,{GIT_AUTHOR_NAME:"Test",GIT_AUTHOR_EMAIL:"test@example.com",GIT_COMMITTER_NAME:"Test",GIT_COMMITTER_EMAIL:"test@example.com",RETRACE_DB:join(dir,"ledger.db"),RETRACE_PROJECT:"p"});
  const git=(...args:string[])=>execFileSync("git",["-C",dir,...args],{env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const bin=fileURLToPath(new URL("./export-cli.js",import.meta.url));
  const cli=(args:string[])=>spawnSync(process.execPath,[bin,...args],{cwd:dir,env,encoding:"utf8"});
  try {
    git("init","-q");git("config","core.hooksPath","/dev/null");
    writeFileSync(join(dir,"a file.txt"),"claimed contribution\n");git("add","a file.txt");
    git("commit","-q","-m","fixture\n\nRetrace-Actor: B");const oid=git("rev-parse","HEAD"),blob=git("rev-parse","HEAD:a file.txt");
    const policy:AttributionPolicy={profile:"retrace-attribution/1",repositories:[{name:"org/r",aliases:["r"],from_seq:0,hook_sealed_by:["assert:hook"]}],non_git:[]};
    writeFileSync(join(dir,".retrace.json"),JSON.stringify({project:"p",attribution:policy}));
    const store=new SqliteStore(env.RETRACE_DB!);
    const human={type:"human" as const,id:"test@example.com"},beneficiary={type:"agent" as const,id:"B"},recorded={type:"agent" as const,id:"O"};
    const root=(await appendEvent(store,{project:"p",actor:human,action:"instructed",artifacts:[{id:"task:test",role:"generated"}],intent:"test"})).event;
    const artifact="repo:org/r#a file.txt",cid=`commit:org/r@${oid.slice(0,12)}`;
    const edit=(await appendEvent(store,{project:"p",actor:beneficiary,action:"edited",artifacts:[{id:artifact,role:"both"}],caused_by:root.id,change:{after_hash:blob},method:{params:{sealed_by:"pinned:B"}}})).event;
    const seal=(await appendEvent(store,{project:"p",actor:recorded,action:"committed",artifacts:[{id:cid,role:"generated"},{id:artifact,role:"generated"}],caused_by:root.id,method:{tool:"git",params:{sealed_by:"assert:hook"}},idempotency_key:`git:${oid}`})).event;
    const witness=(await appendEvent(store,{project:"p",actor:beneficiary,action:"committed",artifacts:[{id:cid,role:"generated"},{id:artifact,role:"generated"}],caused_by:root.id,method:{tool:"git",params:{sealed_by:"assert:hook"}}})).event;
    const args=["amend-attribution","--target",seal.id,"--to","agent/B","--evidence",`${edit.id},${witness.id}`,"--reason","human reviewed the covering contribution","--caused-by",root.id,"--human",human.id];
    const dry=cli([...args,"--dry-run"]);assert.equal(dry.status,0,dry.stderr);const preview=JSON.parse(dry.stdout);assert.equal(preview.recorded,false);assert.equal(preview.result.flags.content_bound,true);assert.equal(preview.result.flags.trailer_corroborated,true);
    assert.equal((await store.all("p")).length,4);
    const written=cli(args);assert.equal(written.status,0,written.stderr+written.stdout);assert.match(written.stdout,/"recorded":true/);assert.match(written.stdout,/"effective":true/);
    const events=await store.all("p"),options=await attributionOptionsForRepo(dir,events,"p");
    assert.equal(collectAttributionAmendments(events,undefined,options).effective.get(seal.id)?.[0].whole_event,true);
    assert.equal(events.find(e=>e.id===seal.id)?.actor.id,"O");
    // Same receipt, but an absent or mismatching content observation leaves the amendment effective.
    const result=collectAttributionAmendments(events,undefined,{...options,contentBoundArtifacts:()=>[]});assert.equal(result.effective.get(seal.id)?.length,1);assert.equal(result.effective.get(seal.id)?.[0].flags.content_bound,undefined);
    // A sealed commit by B is not trailer corroboration if the actual Git trailer says someone else.
    assert.equal(options.trailerCorroborated?.(seal,[witness],{type:"agent",id:"other"}),false);
    const key=await generateSigningKey();const bundle=await buildExportBundle(store,{project:"p"},{signingKey:key.privateKey});
    const bundlePath=join(dir,"bundle.json"),pubkeyPath=join(dir,"public.jwk");writeFileSync(bundlePath,JSON.stringify(bundle));writeFileSync(pubkeyPath,JSON.stringify(key.publicKey));
    const rendered=cli(["render",bundlePath,"--pubkey",pubkeyPath]);assert.equal(rendered.status,0,rendered.stderr);assert.match(rendered.stdout,/^attribution amendments: 1 effective/);assert.match(rendered.stderr,/attribution amendments: 1 effective/);assert.match(rendered.stdout,/recorded|attribution amended →/);
    const effective=cli(["render",bundlePath,"--pubkey",pubkeyPath,"--effective"]);assert.equal(effective.status,0,effective.stderr);assert.match(effective.stdout,/^effective view — recorded actors in parentheses/);assert.match(effective.stdout,/recorded as/);
    const unsignedPath=join(dir,"unsigned.json");writeFileSync(unsignedPath,JSON.stringify({...bundle,signature:undefined}));
    const unsigned=cli(["render",unsignedPath,"--pubkey",pubkeyPath,"--effective"]);assert.match(unsigned.stdout,/^attribution evaluation unavailable: untrusted_export/);assert.doesNotMatch(unsigned.stdout,/^effective view/);
    // CLI is the supported human path; failed preflight does not append by default.
    const failed=cli(args);assert.equal(failed.status,1);assert.equal((await store.all("p")).length,5);
    const forced=cli([...args,"--from","agent/O","--seal-anyway"]);assert.equal(forced.status,2,forced.stderr+forced.stdout);assert.equal((await store.all("p")).length,6);assert.match(forced.stdout,/no_supersede/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("PR gate refuses an older Worker while ordinary doctor reports deployment pending", () => {
  assert.equal(attributionDeployment({}, true).level, "fail");
  assert.equal(attributionDeployment({capabilities: ["attribution-v7"]}, true).level, "pass");
  assert.equal(attributionDeployment({}, false).level, "warn");
});

test("MCP attribution parameter is recognized, mutually exclusive, and cannot relay a human amendment",async()=>{
  const store=new SqliteStore(":memory:"),server=buildServer(store);
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);const client=new Client({name:"attribution-test",version:"1"});await client.connect(ct);
  try {
    const list=await client.listTools();const schema=list.tools.find(t=>t.name==="retrace_amend")!.inputSchema;
    assert.ok(schema.properties?.attribution);
    const args={target_event_id:"absent",attribution:{to:{type:"agent",id:"B"},evidence:[]},reason:"review",caused_by:"absent"};
    const relay=await client.callTool({name:"retrace_amend",arguments:args}) as any;assert.equal(relay.isError,true);assert.match(JSON.stringify(relay.content),/relay_disabled/);
    for(const other of [{artifact_roles:[]},{attest_causal_root:true}]){const mixed=await client.callTool({name:"retrace_amend",arguments:{...args,...other}}) as any;assert.equal(mixed.isError,true);assert.match(JSON.stringify(mixed.content),/malformed/);}
    assert.deepEqual(await store.projects(),[]);
  }finally{await client.close();await server.close();}
});
