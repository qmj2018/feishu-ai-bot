# 飞书 Codex 机器人：开源依赖架构

当前实现替换了旧的内部 LarkLink 部署方案。

```text
飞书事件长连接 → 官方 Node SDK → 本项目 Bridge → ACP SDK → Codex ACP → Codex CLI
                                      ↓
                              用户白名单 / 任务队列
                              一次性审批 / 会话存储
                              每会话 Git worktree
```

飞书 SDK 负责认证与长连接，项目自行实现事件过滤、持久化去重、限长消息队列、
权限请求转发和响应。ACP 使用官方协议 SDK，无内部包或协议实现复制。
Codex ACP 的公开 npm 包携带开源 Codex CLI，安装及依赖完整性由 lockfile 固定。

每次恢复 ACP 会话都显式设置 read-only 模式，防止继承 full-access 配置。
文件与终端能力不向 Agent 声明，由 Codex 自身的工具和沙箱执行；遇到权限请求时，
仅允许原消息发送者在同一飞书对话选择 allow_once/reject_once。权限超时自动取消。

持久化策略是先记录消息 ID 再处理，重启后不自动重放潜在副作用；这意味着运行中
崩溃的消息可能需要用户重新发送。会话 ID 恢复失败时明确报错，可用 /new 新建会话。
worktree 持久保留，不执行自动清理。Git worktree 不替代操作系统隔离。

独立 runtime CLI 提供 bots add/setup/config/start/stop/status/doctor 和前台运行；
部署工具保留 systemd、supervisor 配置渲染、模型发现、模型连通性检查与代理设置。
当前桥接仅处理文本，最终回复按段发送，不包含旧方案的 Web 工作台或互动卡片能力。

基础功能只访问公共 npm、飞书开放平台和用户配置的模型服务。
Codebase MR 准备是可选的 Git 集成，保留在 src/review.mjs，不是私有包依赖。
依赖许可检查见 scripts/audit-dependencies.mjs 和 THIRD_PARTY_NOTICES.md。
