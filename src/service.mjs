import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists, run, validateSlug } from "./core.mjs";
import { readServiceEnvironment, resolveServiceEnvironment, writeServiceEnvironment } from "./runtime-env.mjs";

export function ensureUserLinger({
  commandRunner = run, exists = commandExists, userId = String(process.getuid()),
} = {}) {
  const hint = `请由管理员执行 loginctl enable-linger ${userId} 后重试；或使用 --no-service 仅启动 daemon`;
  if (!exists("loginctl")) throw new Error(`无法检查 user systemd 的 linger 状态；${hint}`);
  const inspect = () => commandRunner("loginctl", ["show-user", userId, "--property=Linger", "--value"], {
    allowFailure: true,
  });
  const current = inspect();
  if (current.status !== 0 || !["yes", "no"].includes(current.stdout.trim())) {
    throw new Error(`无法确认 user systemd 的 linger 状态；${hint}`);
  }
  if (current.stdout.trim() === "yes") return;
  const enabled = commandRunner("loginctl", ["--no-ask-password", "enable-linger", userId], { allowFailure: true });
  if (enabled.status !== 0) throw new Error(`启用 linger 失败；${hint}`);
  const updated = inspect();
  if (updated.status !== 0 || updated.stdout.trim() !== "yes") {
    throw new Error(`启用后仍无法确认 linger 生效；${hint}`);
  }
}

function quoteSystemd(value) {
  if (/\r|\n/.test(value)) throw new Error("systemd 参数不能包含换行");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdUnit({
  slug,
  runtimePath,
  pathEnv,
  home = fs.realpathSync(os.homedir()),
  description = "Devbox Codex Bot",
  environmentFile = path.join(home, ".config", "devbox-codex-bot", `${slug}.proxy.env`),
}) {
  validateSlug(slug);
  if (!path.isAbsolute(runtimePath)) throw new Error("runtimePath 必须是绝对路径");
  if (!pathEnv) throw new Error("PATH 不能为空");
  if (!path.isAbsolute(home) || /\r|\n/.test(home)) throw new Error("HOME 必须是无换行的绝对路径");
  if (!path.isAbsolute(environmentFile) || /[\r\n\0]/.test(environmentFile)) throw new Error("服务环境文件必须是绝对路径");
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=${quoteSystemd(`HOME=${home}`)}
Environment=${quoteSystemd(`NPM_CONFIG_PREFIX=${path.join(home, ".local")}`)}
Environment=${quoteSystemd(`PATH=${pathEnv}`)}
EnvironmentFile=-${environmentFile.replaceAll("%", "%%")}
ExecStart=${quoteSystemd(runtimePath)} bots start ${slug} --foreground
ExecStop=${quoteSystemd(runtimePath)} bots stop ${slug}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

export function renderSupervisorConfig({
  slug,
  runtimePath,
  pathEnv,
  home = fs.realpathSync(os.homedir()),
  user = os.userInfo().username,
  launcherPath,
}) {
  validateSlug(slug);
  if (!path.isAbsolute(runtimePath)) throw new Error("runtimePath 必须是绝对路径");
  for (const [name, value] of Object.entries({ pathEnv, home, user })) {
    if (!value || /[\r\n]/.test(value)) throw new Error(`${name} 无效`);
  }
  if (launcherPath && (!path.isAbsolute(launcherPath) || /[\r\n\0]/.test(launcherPath))) throw new Error("启动器路径无效");
  const command = launcherPath ? `"${launcherPath.replaceAll('"', '\\"')}" run --slug ${slug}` : `${runtimePath} bots start ${slug} --foreground`;
  return `[program:devbox-codex-bot-${slug}]
command=${command.replaceAll("%", "%%")}
user=${user}
environment=HOME="${home.replaceAll('"', '\\"')}",NPM_CONFIG_PREFIX="${path.join(home, ".local").replaceAll('"', '\\"')}",PATH="${pathEnv.replaceAll('"', '\\"')}"
autostart=true
autorestart=unexpected
startsecs=5
stopasgroup=true
killasgroup=true
stopsignal=TERM
stopwaitsecs=30
redirect_stderr=true
stdout_logfile=${home}/.feishu-runtime/supervisor-${slug}.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=5
`;
}

export function resolveExecutable(command, env = process.env) {
  const result = run("sh", ["-c", 'command -v "$1"', "sh", command], { env });
  const executable = result.stdout.trim();
  if (!path.isAbsolute(executable)) throw new Error(`无法解析 ${command} 的绝对路径`);
  return executable;
}

export function installSystemdUnit({ slug, enableNow = false, env = process.env, runtimeEnvironment } = {}) {
  if (process.platform !== "linux") throw new Error("systemd user service 只能在 Linux Devbox 安装");
  if (
    run("sh", ["-c", "command -v systemctl >/dev/null 2>&1"], {
      env,
      allowFailure: true,
    }).status !== 0
  ) {
    throw new Error("当前 Devbox 没有 systemctl，请使用 supervisor 或手工启动");
  }
  const runtimePath = resolveExecutable("feishu-runtime", env);
  const home = fs.realpathSync(env.HOME || os.homedir());
  const values = runtimeEnvironment || resolveServiceEnvironment({ env, previous: readServiceEnvironment(slug, env) });
  const environmentFile = writeServiceEnvironment(slug, values, env);
  const unit = renderSystemdUnit({ slug, runtimePath, pathEnv: env.PATH || "", home, environmentFile });
  const unitDir = path.join(home, ".config", "systemd", "user");
  const unitPath = path.join(unitDir, `devbox-codex-bot-${slug}.service`);
  fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(unitPath, unit, { encoding: "utf8", mode: 0o600 });
  run("systemctl", ["--user", "daemon-reload"], { env });
  if (enableNow) {
    const managed = run("systemctl", ["--user", "is-active", `devbox-codex-bot-${slug}.service`], { env, allowFailure: true }).status === 0;
    const status = run("feishu-runtime", ["bots", "status", slug, "--json"], {
      env,
      allowFailure: true,
    });
    if (!managed && status.status === 0 && /"status"\s*:\s*"running"/.test(status.stdout)) {
      run("feishu-runtime", ["bots", "stop", slug], { env });
    }
    run("systemctl", ["--user", "enable", path.basename(unitPath)], { env });
    run("systemctl", ["--user", managed ? "restart" : "start", path.basename(unitPath)], { env });
  }
  return unitPath;
}
