# Wangsu 能力配置修复

这些 PostgreSQL 脚本只修改指定现有系统渠道的能力配置，端点必须为
`https://api.edgecloudapp.com/v2/llm`。不改价格、启停、供应商默认值、密钥或历史任务。
遇到审计外的型号、协议或自定义能力会中止事务。能力 JSON 实际变化时，
只递增对应模型的 `capability_version` 并更新 `updated_at`；重复执行不改记录。

| 环境 | 渠道 | 原审计快照预期的第一阶段变化 |
| --- | --- | --- |
| 开发 | `CHANNEL_000003` | Fast 和 Nano：2 行 |
| 生产 | `CHANNEL_000006` | Fast、Nano 和 Hailuo 2.3：3 行 |

`backup-wangsu-capabilities.sql` 只读，每环境输出六行 JSON Lines，仅包含模型身份、
能力版本和两个阶段会改动的 JSON 路径。每条路径保留 `present` 和 `value`，
以便将原来缺失的字段恢复为缺失。修复前检查并妥善保存备份，限制读取权限。

在实际部署目录放置 SQL 后执行。生产使用 `CHANNEL_000006`，按真实 Compose
文件调整命令。以下沿用 PostgreSQL 容器已有数据库身份，不打印密码：

```sh
umask 077
wangsu_backup=$(mktemp /tmp/wangsu-capabilities.XXXXXX)
docker compose -f docker-compose.deploy.yml exec -T postgres sh -c '
  : "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"
  exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v channel_id=CHANNEL_000003
' < scripts/sql/backup-wangsu-capabilities.sql > "$wangsu_backup"
wc -l "$wangsu_backup"

docker compose -f docker-compose.deploy.yml exec -T postgres sh -c '
  : "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"
  exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v channel_id=CHANNEL_000003 -v dry_run=true
' < scripts/sql/repair-wangsu-capabilities-core.sql
```

第一阶段兼容现有插件：移除 Fast 无依据的 4K，将 Nano 参考图上限收窄至 14
且保留管理员更严限制，将审计中的 Hailuo 2.3 错误 `480p` 修正为 `768P/1080P`。
检查预演行数后，将同一命令改为 `-v dry_run=false` 正式提交。省略变量默认回滚；
只接受 `true` 或 `false`。本轮两环境第一阶段已执行，再次预演均为零行变化。

第二阶段必须等待新版前后端和 Wangsu 插件发布：

- Gemini 迁移独立 `imageResolution=1k/2k/4k`，新版应用继续匹配原 `quality` 价格档。
- Nano 增加 `1:4/1:8/4:1/8:1` 原生比例，不造比例转像素表。
- Kling 开放 `720P/1080P` 和 `16:9/9:16/1:1`，新版插件映射 `eca_mode=std/pro`，默认 1080P/pro。

先完成第一阶段。新版全部就绪后，以同一 Docker/psql 命令增加
`-v code_and_plugin_ready=true -v dry_run=true`，输入文件改为
`repair-wangsu-capabilities-native-resolution.sql`。检查预期四行变化后，
显式设置 `-v dry_run=false` 提交。被管理员改过的相关路径会触发事务中止。
两阶段均不开放 GPT Image 2 medium，不修改 Qwen。

正式提交后，按部署既有机制刷新路由目录缓存。Redis 版本键为
`canvas:logical-model-route-catalog:version`。用只读备份查询回读能力路径，
并比较价格、启停未变。不要在旧插件上执行第二阶段。
