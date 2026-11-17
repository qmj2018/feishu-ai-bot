import type { Environment, ServiceEnvironment } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { normalizeHomeEnv, validateSlug } from "./core.js";
import { localCodexPath } from "./local-codex.js";
import { APP_ID } from './identity.js';
import { LEGACY_APP_ID } from './legacy.js';

export const PROXY_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const ALLOWED_KEYS = new Set([...PROXY_KEYS, "CODEX_CONFIG", "CODEX_PATH"]);

export function serviceEnvironmentPath(slug: string, env: Environment = process.env) {
  validateSlug(slug);
  return path.join(normalizeHomeEnv(env).HOME, ".config", APP_ID, `${slug}.proxy.env`);
}

function validateValue(key: string, value: string) {
  if (!ALLOWED_KEYS.has(key) || typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`服务环境变量无效: ${key}`);
  }
  if (key === "CODEX_CONFIG" && value) {
    let config;
    try { config = JSON.parse(value); } catch { throw new Error("CODEX_CONFIG 必须是有效 JSON"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("CODEX_CONFIG 必须是 JSON 对象");
  }
  if (key === "CODEX_PATH") localCodexPath({ CODEX_PATH: value });
}

export function renderServiceEnvironment(values: ServiceEnvironment) {
  return Object.entries(values).map(([key, value]) => {
    validateValue(key, value);
    return `${key}=${JSON.stringify(value)}`;
  }).join("\n") + "\n";
}

export function readServiceEnvironment(slug: string, env: Environment = process.env): ServiceEnvironment {
  let file = serviceEnvironmentPath(slug, env);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    file = path.join(normalizeHomeEnv(env).HOME, '.config', LEGACY_APP_ID, `${slug}.proxy.env`);
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("服务环境文件必须是普通文件");
  const values: ServiceEnvironment = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !ALLOWED_KEYS.has(key)) throw new Error("服务环境文件包含不支持的配置行");
    let value;
    try { value = JSON.parse(line.slice(index + 1)); }
    catch { throw new Error(`服务环境文件格式错误: ${key}`); }
    validateValue(key, value);
    values[key] = value;
  }
  return values;
}

export function resolveServiceEnvironment({ env = process.env, previous = {}, proxyMode, model }: { env?: Environment; previous?: ServiceEnvironment; proxyMode?: string; model?: string } = {}): ServiceEnvironment {
  const values = { ...previous };
  values.CODEX_PATH = localCodexPath({ ...env, CODEX_PATH: env.CODEX_PATH ?? previous.CODEX_PATH });
  if (proxyMode !== undefined && !["auto", "env", "direct"].includes(proxyMode)) {
    throw new Error("--proxy-mode 必须是 auto、env 或 direct");
  }
  const useSavedProxy = proxyMode === undefined && PROXY_KEYS.some(key => key in previous);
  const source = useSavedProxy ? previous : env;
  const mode = proxyMode || "auto";
  for (const lower of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const value = mode === "direct" ? "" : source[lower] || source[lower.toUpperCase()] || "";
    values[lower] = values[lower.toUpperCase()] = value;
  }
  if (mode === "env" && !values.https_proxy && !values.all_proxy) {
    throw new Error("代理模式需要设置 HTTPS_PROXY/https_proxy 或 ALL_PROXY/all_proxy");
  }
  if (model !== undefined) {
    if (typeof model !== "string" || !model || /[\s\u0000-\u001f\u007f]/.test(model)) throw new Error("模型 ID 无效");
    const config = values.CODEX_CONFIG ? JSON.parse(values.CODEX_CONFIG) : {};
    values.CODEX_CONFIG = JSON.stringify({ ...config, model });
  }
  renderServiceEnvironment(values);
  return values;
}

export function writeServiceEnvironment(slug: string, values: ServiceEnvironment, env: Environment = process.env) {
  const content = renderServiceEnvironment(values);
  const file = serviceEnvironmentPath(slug, env);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("服务配置目录不能是符号链接");
  fs.chmodSync(directory, 0o700);
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("服务环境文件必须是普通文件");
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  return file;
}

export function configuredModel(values: ServiceEnvironment): string | undefined {
  return values.CODEX_CONFIG ? JSON.parse(values.CODEX_CONFIG).model : undefined;
}
