# feishu-ai-bot

通过飞书远程使用 Codex。消息接入由飞书官方开源 Node SDK 完成，本项目实现
消息队列、用户白名单、权限确认、会话持久化和 Git worktree 隔离，不再依赖 LarkLink。
运行依赖全部来自公共 npm，版本及完整性摘要见 `package-lock.json`。

## 安装

需要 Node.js 20+、npm、Git。Linux 支持 systemd 用户服务；macOS 可使用前台运行。

```bash
git clone https://github.com/qmj2018/feishu-ai-bot.git
cd feishu-ai-bot
npm ci --registry=https://registry.npmjs.org/
npm run verify
```

CLI 保留 `devbox-codex-bot` 兼容名称，可直接通过 Node 使用；`npm link` 后可使用
`feishu-ai-bot`。CLI 会自动查找本项目的 runtime 和 `node_modules/.bin/codex-acp`。

```bash
./node_modules/.bin/codex-acp cli login --device-auth
```

Codex 客户端开源；模型推理仍需要可用的 OpenAI 账号或 API 凭证，不是本地免费模型。

## 飞书配置

在飞书开放平台创建企业自建应用，开启机器人能力。事件订阅选择长连接，订阅
`im.message.receive_v1`，授予读取私聊和群聊 @ 消息、以应用身份发送消息所需权限，
发布应用并将机器人添加到对话。无需公网 webhook。

在当前终端安全设置以下环境变量（请勿提交真实值）：

- `FEISHU_APP_ID`：应用 ID。
- `FEISHU_APP_SECRET`：应用 Secret。
- `FEISHU_ALLOWED_USERS`：允许使用机器人的用户 open_id，逗号分隔，必须设置。
- `FEISHU_DOMAIN`：可选，`feishu`（默认）或 `lark`。

```bash
node bin/devbox-codex-bot.mjs setup --slug my-bot --project /absolute/path/to/git-repo
node bin/devbox-codex-bot.mjs run --slug my-bot
```

凭证只保存到 `~/.feishu-runtime/bots/<uuid>/feishu-runtime.json`，文件权限 0600。
只处理白名单用户的文本消息；群聊还必须 @ 当前机器人。审批消息在群聊中同样需要 @。
`setup` 不读取 `.env` 文件；凭证来自当前进程环境。修改凭证或白名单时，先停止机器人，
再运行 `FEISHU_*` 环境变量配置下的 `bin/feishu-runtime bots setup my-bot`。

## 会话和权限

每个用户、对话和线程有独立会话与 detached Git worktree。worktree 从项目已提交的
HEAD 创建，不包括原目录未提交的修改。会话 ID 和消息去重记录持久化，重启后下一条
新消息恢复会话；中断任务不会自动重放。

Codex 显式使用 `read-only` 模式，需要越过其沙箱权限边界时，飞书收到权限确认消息：

```text
/approve <一次性令牌>
/deny <一次性令牌>
```

仅原发起人在相同对话中的答复有效，300 秒未答复自动拒绝，不提供永久授权。
只读检查可能不触发审批。不会把飞书消息直接作为 Shell 命令执行。

- `/cancel`：取消当前会话任务；已排队的后续消息仍会执行。
- `/new`：在当前排队任务结束后开始新会话。
- 每会话最多 3 条运行中/排队消息，全局最多 4 个活跃队列。
- 单次任务最长 30 分钟，最终文本分段回复。暂不支持图片、附件、流式卡片回复。
- worktree 保留用于检查修改，暂不自动删除；Git worktree 不是容器，也不隔离用户凭证。

## 部署和运维

Linux 一键部署保留模型发现、连通性探测及可选的 systemd 用户服务。

```bash
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo --model auto
# 不使用 systemd，仅使用后台 daemon：
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo --service manual
node bin/devbox-codex-bot.mjs status --slug my-bot
node bin/devbox-codex-bot.mjs stop --slug my-bot
node bin/devbox-codex-bot.mjs doctor --slug my-bot
node bin/devbox-codex-bot.mjs verify --slug my-bot --json
```

请先运行 `npm ci`。`install` 命令基于 lockfile 执行公共源 `npm ci`，不访问内部包源。
`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 可按网络需要设置，模型和代理配置保存到
`~/.config/devbox-codex-bot/<slug>.proxy.env`（0600），支持 `--proxy-mode direct` 清除代理。
后台运行日志位于 runtime 的 `logs/feishu-runtime.log`。

可选的 `mr prepare` 和内置 review skill 保留 Codebase MR 的只读 Git 审查功能；
仅该功能需要内部仓库的 SSH 读取权限，不属于基础运行依赖，也不安装私有 npm 包。

## 依赖与许可证

| 直接依赖 | 固定版本 | 许可证 | 源码 |
| --- | --- | --- | --- |
| @larksuiteoapi/node-sdk | 1.76.0 | MIT | https://github.com/larksuite/node-sdk |
| @agentclientprotocol/sdk | 1.3.0 | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| @agentclientprotocol/codex-acp | 1.6.2 | Apache-2.0 | https://github.com/agentclientprotocol/codex-acp |

包括间接依赖和各平台可选包的清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

```bash
npm run audit:licenses
npm audit --registry=https://registry.npmjs.org/
```

许可证检查拒绝非公共 npm 源、缺少完整性摘要或未审查的许可证，并纳入 `npm run verify`。
项目代码采用 MIT 许可证；第三方软件继续遵循各自许可证。

原 LarkLink runtime 数据不会自动迁移，请重新配置凭证和白名单。历史设计文档已更新为
当前桥接架构，不再作为内部依赖的安装指南。
