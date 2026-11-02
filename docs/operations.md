# 运维验收

1. 公共 npm 源执行 `npm ci`，运行 `npm run verify` 与 `npm run audit:licenses`。
2. 使用 `codex-acp cli login --device-auth` 完成模型账号登录，运行 CLI 的 `models`、`probe`。
3. 设置 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_ALLOWED_USERS，运行 setup。
4. 前台 run 或 Linux deploy，检查 status 和 verify。
5. 飞书私聊发送文本，验证最终回复；群聊只有 @ 本机器人且发送人在白名单时响应。
6. 验证白名单外用户不能发起任务或审批；权限超时和 /deny 都拒绝操作。
7. /new 后检查独立 worktree；重启后发送新消息验证会话恢复及历史事件去重。
8. /cancel 可中止当前任务，已排队消息仍会继续处理。

当前自动测试使用本地模拟的飞书事件和 ACP Agent，不会自动发送真实飞书消息。
真实长连接、租户权限和模型调用需要在部署环境使用实际凭证验收。

运行目录：`~/.feishu-runtime/bots/<uuid>/`。
配置、进程状态、会话记录均以 0600 写入；worktree 和日志位于同一目录。
日志不记录原始飞书消息或模型 provider stderr。需要清理 worktree 时先停止机器人，
使用 `git -C <project> worktree list` 核对后逐一处理，避免丢失未提交修改。

systemd 环境继续使用 `~/.config/devbox-codex-bot/<slug>.proxy.env`。
可选 Codebase MR 审查只通过 Git SSH 读取 tmp-merge ref，不发布评论、不执行 MR 脚本。
