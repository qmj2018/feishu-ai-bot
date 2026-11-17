# 运维验收

1. 在 Linux / Windows WSL Linux 中运行 `./deploy.sh --project <git-root>`。检查已有 Node/npm/Git、lockfile 对应依赖均被复用，缺失才安装。Ubuntu/Debian 支持 apt 补齐系统工具；Node 安装到用户目录并核验官方摘要。
2. 已有 Codex 应跳过下载和升级；只有缺失时安装，未登录时引导设备登录。显式升级使用 `install --update-codex`；自定义入口使用 `CODEX_PATH` 或 `--codex-path`。
3. 已有本地机器人应直接复用。无配置时测试申请/已有/取消三条路径，确认只有选择申请才运行 `config init --new`；已有应用按需完成飞书登录并建立用户白名单。应用发布审核未通过时不能报告部署成功，重新运行不得重复创建应用或重复提审。
4. 前台 run 或 Linux deploy，检查 status 和 verify。
5. 飞书私聊发送文本，验证最终回复；群聊只有 @ 本机器人且发送人在白名单时响应。
6. 验证白名单外用户不能发起任务或审批；权限超时和 /deny 都拒绝操作。
7. /new 后检查独立 worktree；重启后发送新消息验证会话恢复及历史事件去重。
8. /cancel 可中止当前任务，已排队消息仍会继续处理。

当前自动测试使用本地模拟的飞书事件和 ACP Agent，不会自动发送真实飞书消息。
真实长连接、租户权限和模型调用需要在部署环境使用实际凭证验收。

执行动效：应用需开通并发布 `im:message.reactions:write_only` 权限。发送任务后，确认原消息下
出现 `Typing` 动态表情，任务完成、失败或取消后消失；同会话排队的下一条任务应在开始执行后才显示。
若没有动效，检查服务日志中的执行状态表情错误，并确认权限版本已发布；任务本身仍会继续执行。

用量查询：私聊发送 `/usage`（群聊需 @），检查账号额度窗口、剩余比例及北京时间的重置时间。
周额度依据接口返回的 10080 分钟窗口识别，不假定在 primary 或 secondary 中。上下文仅从当前
飞书会话对应的 Codex thread 读取最近 token_count 快照；查询不会恢复会话或调用模型。
任务执行中也应即时响应；新会话、缺少快照和不支持的引擎应显示数据不可用。

Markdown 回复：让模型返回标题、加粗、列表、链接、代码块及表格，确认以富文本显示。
检查长代码块跨多条回复时各段仍为代码块。旧消息不会自动更新；需发新任务验证。
此功能复用现有消息发送权限，不新增卡片权限。

用户与群监听：使用 `users list/add/remove` 管理全局用户白名单，`groups list/add/remove` 管理
被动监听群，`groups messages <chat_id> --limit 20` 查看缓存。配置应在下一条消息时热生效。
未配置监听的群仍可由白名单用户 @ 机器人派任务；监听的群内普通消息不能触发 Agent。
首次启用监听时执行 `groups authorize` 申请 `im:message.group_msg` 并提交发布；管理员审核后重试，
机器人须已被加入群。新增使用者还须在飞书应用的可用范围内。
核对多人会话/worktree 隔离、其他人不能审批原任务、移除用户后排队任务不再执行。

运行目录：`~/.feishu-runtime/bots/<uuid>/`。
配置、进程状态、会话记录均以 0600 写入；worktree 和日志位于同一目录。
日志不记录原始飞书消息或模型 provider stderr。需要清理 worktree 时先停止机器人，
使用 `git -C <project> worktree list` 核对后逐一处理，避免丢失未提交修改。

systemd 环境继续使用 `~/.config/feishu-ai-bot/<slug>.proxy.env`。
其中 `CODEX_PATH` 是模型列表、探测和 ACP 会话统一使用的本机入口。每次启动复用已有
Codex，不重复安装或自动升级。首次安装和显式升级失败时保持原客户端。
版本目录位于 `~/.local/share/feishu-ai-bot/codex/`，入口备份为 `codex.before-ai-bot-*`。
检查 `journalctl --user -u feishu-ai-bot-<slug>.service` 的版本检查记录，确认路径和版本。
通用审查流程维护在项目的 `.agents/skills/code-review/`，Codebase 入口为
`.agents/skills/codebase-mr-review/`。修改后运行 `node dist/bin/feishu-ai-bot.js skill install`
同步两者及引用资源到用户目录；`verify` 检查安装副本与项目文件是否一致。
审查按输入选择仓库和版本，读取目标仓库自己的规范、模块和调用链。
可选 Codebase MR 准备通过 Git SSH 读取 tmp-merge ref；审查结果默认返回请求会话。

## 模型卡片验收

- 在飞书应用的回调配置中订阅 `card.action.trigger`，并启用长连接与发布。
- `/models` 返回 Codex、Claude 各自的真实模型选项；某一 CLI 不可用时另一张仍能使用。
- 下拉选择后等待确认，下一条消息应使用新引擎和模型；重启后保持选择。
- 验证其他用户、跨对话复制、过期卡片和重放不能修改模型。
- 已有任务运行时点击选择，确认当前任务先完成，模型切换按队列处理。
- 两种引擎各自保存会话 ID，确认切回时恢复该引擎原上下文。
- 切换失败时应保留原设置；真实推理权限需要发送一条实际消息另行验收。

Codex 强度检查：每个模型只显示其支持的强度，默认标记由 CLI 元数据决定；
Extra high 的协议值必须是 xhigh。选择后验证下一轮与重启恢复时同时应用
model 和 reasoning_effort；强度设置失败不得更新本地已保存的模型/强度组合。

## 工作空间验收

- workspace create --repo 从 HTTPS/SSH 拉取，检查指定分支、origin 和元数据权限。
- 同名重试保留本地改动；不同仓库、分支、未知目录或符号链接应报错。
- workspace create --empty 应创建有效 HEAD，可用于会话 worktree。
- 拉取失败只清理本次临时目录；不自动 pull/reset 或运行仓库安装脚本。
- Linux deploy --repo/--workspace 应将工作空间 repo 路径交给机器人配置。
- 私有仓库认证需要事先配置，不能将凭证写在 URL 中。
