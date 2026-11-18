import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/feishu-ai-bot.js", import.meta.url));

function machine(t, failProbe = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-deploy-machine-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, ".local/bin");
  const project = path.join(home, "my-project");
  const trace = path.join(home, "commands.jsonl");
  const stateFile = path.join(home, "state.json");
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const root = path.join(home, ".feishu-runtime/bots", id);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project);
  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "feishu-runtime.json"), JSON.stringify({ project: { path: project, name: "Existing" }, feishu: { appId: "test", appSecret: "placeholder", allowedUsers: ["ou_test"] } }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ workspaceMode: "per-session-worktree" }), { mode: 0o600 });
  fs.writeFileSync(stateFile, JSON.stringify({ running: true }));
  const body = `
import fs from 'node:fs';
import readline from 'node:readline';
const args=process.argv.slice(2);
const statePath=process.env.TEST_STATE;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const send=value=>console.log(JSON.stringify(value));
fs.appendFileSync(process.env.TEST_TRACE,JSON.stringify({tool,args})+'\\n');
if(tool==='npm') console.log(args[0]==='view' ? JSON.stringify('1.2.3') : 'npm test-version');
else if(tool==='loginctl') console.log('yes');
else if(tool==='systemctl') {
  if(args.includes('is-system-running')) console.log('running');
  if(args.includes('is-active')) {console.log(state.running?'active':'inactive');process.exitCode=state.running?0:3;}
  if(args.includes('stop')) {state.running=false;save();}
  if(args.includes('start')||args.includes('restart')) {state.running=true;save();}
} else if(tool==='feishu-runtime') {
  if(args[1]==='list') send({bots:[{slug:'portable-bot',runtimeId:'${id}',displayName:'Existing'}]});
  if(args[1]==='status') send({running:state.running,status:state.running?'running':'stopped',state:{nobind:false}});
  if(args[1]==='stop') {state.running=false;save();}
  if(args[1]==='start') {state.running=true;save();}
  if(args[1]==='config') {let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    const config=JSON.parse(input).config;
    fs.writeFileSync(process.env.TEST_CONFIG,JSON.stringify(config),{mode:0o600});
    fs.writeFileSync(process.env.TEST_CONFIG.replace('feishu-runtime.json','runtime.json'),JSON.stringify({workspaceMode:config.project?.workspaceMode||'per-session-worktree'}),{mode:0o600});
  });}
} else if(tool==='codex') {
  if(args.includes('--version')) console.log('codex-cli 1.2.3');
  else if(args.includes('login')) console.log('Logged in using test account');
  else if(args.includes('app-server')) readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});if(r.method==='model/list')send({id:r.id,result:{data:[{id:'portable-model',model:'portable-model',isDefault:true}]}});});
  else if(args.includes('exec')) {process.stdin.resume();process.stdin.on('end',()=>{if(process.env.TEST_FAIL==='yes')send({type:'error',message:'simulated network failure'});else {send({type:'item.completed',item:{type:'agent_message',text:'DEPLOY_OK'}});send({type:'turn.completed'});}});}
}
`;
  for (const tool of ["systemctl", "feishu-runtime", "codex", "npm", "loginctl"]) {
    fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nconst tool=${JSON.stringify(tool)};\n${body}`, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_PATH: path.join(bin, "codex"), PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_STATE: stateFile, TEST_TRACE: trace, TEST_CONFIG: path.join(root, "feishu-runtime.json"), TEST_FAIL: failProbe ? "yes" : "no", HTTPS_PROXY: "", https_proxy: "", HTTP_PROXY: "", http_proxy: "", ALL_PROXY: "", all_proxy: "", NO_PROXY: "", no_proxy: "" };
  delete env.NODE_TEST_CONTEXT;
  return { home, project, trace, stateFile, env };
}

test("portable deployment preserves existing project and persists discovered model", { skip: process.platform !== "linux" }, t => {
  const fake = machine(t);
  const result = spawnSync(process.execPath, [cli, "deploy", "--slug", "portable-bot", "--skip-install", "--proxy-mode", "direct"], { env: fake.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const config = JSON.parse(fs.readFileSync(fake.env.TEST_CONFIG, "utf8"));
  assert.equal(config.project.path, fs.realpathSync(fake.project));
  const contents = fs.readFileSync(path.join(fake.home, ".config/feishu-ai-bot/portable-bot.proxy.env"), "utf8");
  assert.match(contents, /portable-model/);
  assert.match(contents, /HTTPS_PROXY=""/);
  const calls = fs.readFileSync(fake.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const probe = calls.findIndex(call => call.tool === "codex" && call.args.includes("exec"));
  const stop = calls.findIndex(call => call.tool === "systemctl" && call.args.includes("stop"));
  assert.ok(probe >= 0 && stop > probe);
  assert.equal(JSON.parse(fs.readFileSync(fake.stateFile, "utf8")).running, true);
});

test("failed model check leaves running bot and its configuration untouched", { skip: process.platform !== "linux" }, t => {
  const fake = machine(t, true);
  const original = fs.readFileSync(fake.env.TEST_CONFIG, "utf8");
  const result = spawnSync(process.execPath, [cli, "deploy", "--slug", "portable-bot", "--skip-install"], { env: fake.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated network failure/);
  assert.equal(fs.readFileSync(fake.env.TEST_CONFIG, "utf8"), original);
  assert.equal(JSON.parse(fs.readFileSync(fake.stateFile, "utf8")).running, true);
  const calls = fs.readFileSync(fake.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(!calls.some(call => call.args.includes("stop") || call.args.includes("restart")));
  assert.equal(fs.existsSync(path.join(fake.home, ".config/feishu-ai-bot/portable-bot.proxy.env")), false);
});

test('deploy --cwd accepts a non-Git directory and persists its workspace and Codex modes', { skip: process.platform !== 'linux' }, t => {
  const fake = machine(t);
  const directory = path.join(fake.home, 'plain project');
  fs.mkdirSync(directory);
  const result = spawnSync(process.execPath, [cli, 'deploy', '--slug', 'portable-bot', '--skip-install', '--cwd', directory,
    '--codex-mode', 'agent-full-access'], { env: fake.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const config = JSON.parse(fs.readFileSync(fake.env.TEST_CONFIG, 'utf8'));
  assert.equal(config.project.path, directory);
  assert.equal(config.project.workspaceMode, 'project-directory');
  assert.equal(config.agents.codexMode, 'agent-full-access');
  assert.equal(fs.existsSync(path.join(directory, '.git')), false);
});
