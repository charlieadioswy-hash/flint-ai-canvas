# 图片像素尺寸定向修复

这次只修复四条已审计渠道模型的缺失映射：旧配置以 `size` 发送像素，却保存默认
`1:1` 和八个比例，没有对应像素预设。任务准入会拒绝比例请求。

| 环境 | 渠道 | 模型 | 新默认像素 | 预期变化 |
| --- | --- | --- | --- | --- |
| 开发 | `CHANNEL_000001` | `MODEL_000006` GPT Image 1.5、`MODEL_000016` GPT Image 2、`MODEL_000009` GPT Image 2.5 Sunburst | `1024x1024` | 3 行 |
| 生产 | `CHANNEL_000002` | `MODEL_000003` Seedream 5.0 Pro | `2048x2048` | 1 行 |

OpenAI 默认取既有明确像素 `1024x1024`，与已有连接测试一致。Ark 默认取既有
`2048x2048`，与 Ark 插件原来 `1:1 → 2048x2048` 的映射一致。本次不声称
验证了这些供应商的所有尺寸；仅避免宿主因缺映射拒绝默认请求。

`repair-image-pixel-sizes.sql` 从原 39 项移除八个含冒号的比例，保留 `auto` 和
30 个原有精确像素及其顺序；只修改 `image.size.values/default`。不增加
1K/2K/4K 档位或比例换算表，不修改质量、自定义开关、价格、启停、供应商默认值、
密钥或历史任务。保留 `2048x878` 等原有像素不表示供应商已验证支持，后续需根据
该供应商、型号或模板的文档收窄。旧画布已保存的比例仍需用户重新选择明确像素。

脚本要求精确匹配审计中的渠道、模型 ID、上游 key、协议、图片能力和旧尺寸结构。
首次修复还要求旧能力版本为 1；发现管理员自定义、typed 参数、独立分辨率、像素
映射或版本漂移即中止整个事务。实际修改时版本递增一次；完成后的精确尺寸状态
重复执行为零变化。不会更新或创建逻辑模型 revision。

先用 `backup-image-pixel-sizes.sql` 做定向只读备份，开发应有 3 行 JSON Lines，
生产应有 1 行；仅包含身份、原能力版本、更新时间和两个将修改的路径。记录
`present/value` 以区分缺失字段和 JSON null，无需下载全量数据库。

以下命令在真实部署目录执行，沿用 PostgreSQL 容器内部身份，不打印凭据；按
实际部署文件调整 Compose 路径。生产改为 `repair_environment=production`。

```sh
umask 077
image_size_backup=$(mktemp /tmp/image-pixel-sizes.XXXXXX)
docker compose -f docker-compose.deploy.yml exec -T postgres sh -c '
  : "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"
  exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v repair_environment=development
' < scripts/sql/backup-image-pixel-sizes.sql > "$image_size_backup"
wc -l "$image_size_backup"

docker compose -f docker-compose.deploy.yml exec -T postgres sh -c '
  : "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"
  exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v repair_environment=development -v dry_run=true
' < scripts/sql/repair-image-pixel-sizes.sql
```

省略 `dry_run` 默认 `ROLLBACK`，只接受 true/false。核对备份、预演变化行数和
默认值后，用同一命令的 `-v dry_run=false` 提交。再次预演必须为零变化。
正式提交后按部署既有机制刷新路由目录缓存，回读两个尺寸路径和能力版本，并
比较价格、启停、providerDefaults 完全不变。缓存版本键为
`canvas:logical-model-route-catalog:version`。

如需恢复，仅从本次备份恢复这两个路径、原能力版本及更新时间，并在恢复前
确认当前记录仍是本次修复结果；不要覆盖其他管理员后续修改。
