import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chooseModel, listAvailableModels, probeModel } from "../src/codex.js";

function fakeCodex(t, scenario = "ok") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-codex-protocol-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "fake.mjs");
  fs.writeFileSync(file, `#!${process.execPath}
import readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
if (process.argv.includes('app-server')) {
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request=JSON.parse(line);
    if(process.env.SCENARIO==='hang') return;
    if(request.method==='initialize') send({id:request.id,result:{}});
    if(request.method==='model/list') send({id:request.id,result:request.params.cursor ? {data:[{id:'account-default',model:'account-default',isDefault:true}]} : {data:[{id:'other-model',model:'other-model',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Faster'},{reasoningEffort:'medium',description:'Default'},{reasoningEffort:'xhigh',description:'Deep'}]}],nextCursor:'page-two'}});
  });
} else {
  if(!process.argv.includes('--ephemeral')||!process.argv.includes('read-only')) process.exit(5);
  process.stdin.resume();
  process.stdin.on('end',()=>{
    if(process.env.SCENARIO==='error') send({type:'error',message:'proxy failed '+process.env.HTTPS_PROXY});
    else {send({type:'item.completed',item:{type:'agent_message',text:'DEPLOY_OK'}});send({type:'turn.completed'});}
  });
}
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, SCENARIO: scenario, HTTPS_PROXY: "http://fake:private@proxy.example" };
  delete env.NODE_TEST_CONTEXT;
  return { command: process.execPath, prefixArgs: [file, "cli"], env, timeoutMs: 3000 };
}

test("model discovery handles pagination and chooses account default", async t => {
  const models = await listAvailableModels(fakeCodex(t));
  assert.equal(models.length, 2);
  assert.equal(models[0].defaultReasoningEffort, "medium");
  assert.deepEqual(models[0].supportedReasoningEfforts.map(v => v.reasoningEffort), ["low", "medium", "xhigh"]);
  assert.equal(chooseModel(models), "account-default");
  assert.equal(chooseModel(models, undefined, "saved-model"), "saved-model");
  assert.equal(chooseModel(models, "auto", "saved-model"), "account-default");
  assert.equal(chooseModel(models, "explicit-model"), "explicit-model");
});

test("probe requires a completed, read-only model reply", async t => {
  const report = await probeModel({ model: "account-default", ...fakeCodex(t) });
  assert.equal(report.ok, true);
  assert.equal(report.model, "account-default");
});

test('discovery and probes use CODEX_PATH directly without the ACP bundled client', async t => {
  const fake = fakeCodex(t);
  const options = { env: { ...fake.env, CODEX_PATH: fake.prefixArgs[0] }, timeoutMs: 3000 };
  assert.equal((await listAvailableModels(options)).length, 2);
  assert.equal((await probeModel({ model: 'account-default', ...options })).ok, true);
});

test("model failures redact proxy credentials", async t => {
  await assert.rejects(probeModel({ model: "bad-model", ...fakeCodex(t, "error") }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test("stuck model discovery terminates at its deadline", async t => {
  await assert.rejects(listAvailableModels({ ...fakeCodex(t, "hang"), timeoutMs: 100 }), /超时/);
});
