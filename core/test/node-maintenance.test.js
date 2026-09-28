"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { inspectLogs, preflightFolders, installSnapshot, backupList, deleteBackup } = require("../lib/koinos/node-maintenance");
const { NodeManager } = require("../lib/koinos/node-manager");
const { classifyCrash, crashRemedy } = require("../lib/koinos/node-health");
const mismatch = "replayed state delta merkle root does not match block receipt";
const id = "previous-2026-09-13T10-00-00-000Z";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-maintenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function data(root, name, value) { fs.mkdirSync(path.join(root, name), { recursive: true }); fs.writeFileSync(path.join(root, name, "data"), value); }

test("replay mismatch is recognized and displayed with recovery disabled after reopening", async () => {
  const mgr = new NodeManager({ dataRoot: "/unused", autoRecover: false });
  const services = ["chain", "block_store", "mempool", "p2p", "block_producer"].map(service => ({ service, state: "running" }));
  let reads = 0;
  mgr.dockerInfo = async () => ({ ok: true }); mgr.services = async () => services;
  mgr.filesReady = () => true; mgr.readProducerPublicKey = () => null;
  mgr._compose = async () => { reads++; return { ok: true, stdout: mismatch, stderr: "" }; };
  const results = await Promise.all([mgr.status("mainnet"), mgr.status("mainnet")]);
  assert.equal(reads, 1);
  for (const r of results) { assert.equal(r.health.ok, false); assert.equal(r.health.needsRepair, true); }
  assert.equal(classifyCrash(mismatch), "replay-mismatch");
  assert.equal(crashRemedy("replay-mismatch"), "repair");
});
test("repeated producer timeouts warn without claiming corruption", () => {
  const line = "block_producer | No response to client request abc within 30000ms";
  assert.equal(inspectLogs(line).health, null);
  assert.equal(inspectLogs(line + "\n" + line).health.reason, "chain-unresponsive");
  assert.equal(inspectLogs(line + "\n" + line).health.needsRepair, undefined);
});
test("peer count uses the latest report, missing is unknown, capped lists are lower bounds", () => {
  assert.equal(inspectLogs("starting").peers, null);
  const header = "p2p-1 | 2026-09-13T10:00:00.000Z Connected peers:";
  const row = "p2p-1 | - /ip4/1.2.3.4/tcp/8888/p2p/abc";
  assert.equal(inspectLogs(header + "\n" + row + "\n" + row).peers.count, 2);
  assert.equal(inspectLogs(header + "\n" + row + "\np2p-1 | and 5 more...").peers.lowerBound, true);
  assert.equal(inspectLogs(header + "\n" + row + "\n" + header).peers.count, 0);
});
test("folder lock preflight restores data and gives restart advice before download", t => {
  const root = fixture(t); data(root, "chain", "original");
  preflightFolders(root);
  assert.equal(fs.readFileSync(path.join(root, "chain/data"), "utf8"), "original");
  t.mock.method(fs, "renameSync", () => { const e = new Error("locked"); e.code = "EPERM"; throw e; });
  assert.throws(() => preflightFolders(root), /Restart Windows fully/);
});
test("partial snapshot install rolls original databases back without touching keys", t => {
  const root = fixture(t), live = path.join(root, "live"), staged = path.join(root, "staged"), backup = path.join(root, id);
  for (const name of ["chain", "block_store", "block_producer"]) data(live, name, "original-" + name);
  for (const name of ["chain", "block_store"]) data(staged, name, "new-" + name);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (src, dst) => {
    if (src === path.join(staged, "block_store")) { const e = new Error("locked"); e.code = "EPERM"; throw e; }
    return rename(src, dst);
  });
  assert.throws(() => installSnapshot(live, backup, path.join(staged,"chain"), path.join(staged,"block_store")), /Restart Windows/);
  for (const name of ["chain", "block_store", "block_producer"]) assert.equal(fs.readFileSync(path.join(live, name, "data"), "utf8"), "original-" + name);
  assert.equal(fs.readFileSync(path.join(staged,"chain/data"), "utf8"), "new-chain");
});
test("backup listing measures bytes and deletion cannot target live data or escape restore", async t => {
  const root = fixture(t), restore = path.join(root, "restore");
  data(restore, id, "12345"); data(root, "chain", "keep");
  const list = await backupList(restore);
  assert.equal(list[0].bytes, 5);
  await assert.rejects(deleteBackup(restore, "../chain"), /Invalid/);
  await deleteBackup(restore, id);
  assert.equal(fs.readFileSync(path.join(root,"chain/data"), "utf8"), "keep");
});
test("backup deletion rejects symlinks", { skip: process.platform === "win32" }, async t => {
  const root = fixture(t), restore = path.join(root, "restore"); fs.mkdirSync(restore); data(root, "chain", "keep");
  fs.symlinkSync(path.join(root,"chain"),path.join(restore,id),"dir");
  await assert.rejects(deleteBackup(restore,id), /real directory/);
});
test("an initial stopped observation does not permanently cache missing health", async () => {
 const mgr = new NodeManager({dataRoot:"/unused"});
 await mgr.observe("mainnet", []);
 mgr._observations.get("mainnet").at = 0;
 mgr._compose = async () => ({ok:true,stdout:mismatch,stderr:""});
 const r = await mgr.observe("mainnet", [{service:"chain",state:"running"}]);
 assert.equal(r.health.needsRepair,true);
});
test("unreachable chain eventually fails health even without any head reading", () => {
 const {assessHealth, CORE_SERVICES}=require("../lib/koinos/node-health");
 const services=CORE_SERVICES.map(service=>({service,state:"running"}));
 assert.equal(assessHealth({services,probeFailed:true,lastHeightAt:0,now:600000}).reason,"chain-unresponsive");
 assert.equal(assessHealth({services,probeFailed:true,lastHeightAt:0,now:1000}).reason,"rpc-unavailable");
});
test("interrupted install marker prevents starts and deletion of recovery data", async t => {
 const root=fixture(t); const mgr=new NodeManager({dataRoot:root});
 fs.mkdirSync(mgr.dirs("mainnet").basedir,{recursive:true});
 fs.writeFileSync(path.join(mgr.dirs("mainnet").basedir,".kai-restore-incomplete.json"),"{}");
 await assert.rejects(mgr.start("mainnet",null),/interrupted/);
 await assert.rejects(mgr.removeBackup("mainnet",id),/interrupted/);
});
test("successful snapshot preserves old databases and leaves identity untouched", t => {
 const root=fixture(t), live=path.join(root,"live"), staged=path.join(root,"staged"), backup=path.join(root,id);
 for(const name of ["chain","block_store","p2p","block_producer"]) data(live,name,"old-"+name);
 for(const name of ["chain","block_store"]) data(staged,name,"new-"+name);
 installSnapshot(live,backup,path.join(staged,"chain"),path.join(staged,"block_store"));
 for(const name of ["chain","block_store"]) {
  assert.equal(fs.readFileSync(path.join(live,name,"data"),"utf8"),"new-"+name);
  assert.equal(fs.readFileSync(path.join(backup,name,"data"),"utf8"),"old-"+name);
 }
 for(const name of ["p2p","block_producer"]) assert.equal(fs.readFileSync(path.join(live,name,"data"),"utf8"),"old-"+name);
 assert.equal(fs.existsSync(path.join(live,".kai-restore-incomplete.json")),false);
});

test("producer rejection is separate from node health and only a successful submission clears it", async () => {
  const failure = "block_producer-1 | 2026-09-14 09:38:19 Error while submitting block: could not burn vhp";
  const quiet = "block_producer-1 | Producing with 17569.43050000 VHP";
  assert.equal(inspectLogs(failure).health, null);
  assert.equal(inspectLogs(failure + "\n" + quiet).production.reason, "vhp-burn-rejected");
  assert.equal(inspectLogs("chain-1 | Error while submitting block: could not burn vhp").production, null);
  assert.equal(inspectLogs(failure + "\nblock_producer-1 | Produced block - Height: 123").production.reason, null);
  const mgr = new NodeManager({ dataRoot: "/unused" });
  const services = [{ service: "block_producer", state: "running" }];
  let log = failure;
  mgr._compose = async () => ({ ok: true, stdout: log, stderr: "" });
  assert.equal((await mgr.observe("mainnet", services)).production.reason, "vhp-burn-rejected");
  mgr._observations.get("mainnet").at = 0; log = quiet;
  assert.equal((await mgr.observe("mainnet", services)).production.reason, "vhp-burn-rejected");
  mgr._observations.get("mainnet").at = 0; log = "block_producer-1 | Produced block - Height: 124";
  assert.equal((await mgr.observe("mainnet", services)).production.reason, null);
});
