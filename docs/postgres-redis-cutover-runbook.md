# PostgreSQL、Redis 与 BullMQ 正式切换手册

## 目标状态

- PostgreSQL 是客户、消息、商机、报价、审批、订单、证据、审计和 Agent 运行状态的唯一权威源。
- Redis 保存登录会话、登录限频计数、Worker 心跳和 BullMQ 数据；Redis 丢失不应改变已确认业务事实。
- Agent、飞书通知和 Mem0 同步由 BullMQ Worker 消费。
- `queue_outbox` 与业务写入处于同一个 PostgreSQL 事务；发布失败会保留 pending 记录，重复发布依赖确定性 Job ID 去重。
- SQLite 只允许出现在 `scripts/sqlite-to-postgres.ts` 中，作为一次性只读迁移源。

## 本机启动

1. 启动 Docker Desktop，确认 `docker info` 成功。
2. 执行 `docker compose up -d postgres redis`。
3. 在 `.env` 配置：

   ```text
   DATABASE_URL=postgresql://crm_app:local-development-only@127.0.0.1:5432/tradeguard
   REDIS_URL=redis://127.0.0.1:6379/0
   ```

4. 如果需要保留原本的演示数据，在停止旧 API 后执行：

   ```powershell
   $env:SQLITE_SOURCE_PATH='F:\project\VSCode\CRM\data\crm.db'
   $env:MIGRATION_CONFIRM='sqlite-to-postgres'
   pnpm migrate:sqlite-to-postgres
   ```

5. 分别运行 `pnpm dev:api`、`pnpm dev:web` 和 `pnpm worker`。API 不再内嵌 Worker。
6. 创建独立的 `tradeguard_test` 数据库，复制 `.env.test.example` 为 `.env.test`，执行 `pnpm platform:check` 和 `pnpm test:integration`。

全新空数据库通过 `deploy/postgres/init/001-schema.sql` 初始化。生产空库随后运行 `pnpm bootstrap:admin`；迁移库不得重复初始化管理员。

## 生产密钥

生产 Compose 使用 Docker secrets。除了 PostgreSQL、Redis 的服务密码文件，还要提供：

- `DATABASE_URL_SECRET_FILE`：包含完整 PostgreSQL URL 的单行文件。
- `REDIS_URL_SECRET_FILE`：包含完整 Redis URL 的单行文件。
- 模型、飞书和监控 Token 对应的密钥文件。

`database_url` 中的密码必须和 `postgres_password` 一致，`redis_url` 中的密码必须和 `redis_password` 一致。不要把 URL 或 API Key 提交到 Git。

## 正式切换

1. 对原 SQLite 做文件级快照并记录 SHA-256；保留只读副本。
2. 停止旧 API 和旧 Worker，确保没有 SQLite 写进程。若需要展示维护页，将旧服务先设为只读再停止。
3. 启动空 PostgreSQL/Redis，确认 schema 初始化完成。
4. 以只读方式运行 `migrate:sqlite-to-postgres`。脚本持有 PostgreSQL advisory lock，在单事务内复制，并逐表比较行数和有序内容哈希。
5. 运行集成测试、`platform:check`，再以一个 API 和一个 Worker 启动。
6. 验证登录、客户、询价、审批、订单、审计；检查 `queue_outbox` pending 数和 BullMQ failed 数均无异常。
7. 扩容到多个 Worker，执行并发测试，观察任务只产生一次业务副作用。
8. 开放公网写流量并记录切换时间、SQLite 最后写入时间和 PostgreSQL 首次写入时间。

## 回滚边界

安全回滚窗口只存在于“PostgreSQL 验证期间尚未开放写流量”阶段：停止新服务，重新挂载原 SQLite 只读快照对应的旧版本即可。

一旦 PostgreSQL 开始接收正式写入，禁止直接切回 SQLite，否则会丢失新客户、审批和订单。此时应修复 PostgreSQL 服务或执行经过审核的反向数据迁移，而不是修改 Compose 指回旧文件。

## 备份恢复

- `pnpm backup` 使用 `pg_dump --format=custom`，并用 `pg_restore --list` 检查归档。
- `pnpm restore:drill -- <backup.dump>` 只允许恢复到名称包含 `restore`、`drill` 或 `test` 的隔离数据库，并要求 `RESTORE_DRILL_CONFIRM=isolated-database`。
- 恢复后脚本检查关键表并输出真实 RTO；RPO 由最近一个成功备份时间与故障时间计算。

## 当前验证状态

- TypeScript、Vite 构建和两个 Compose 文件的配置解析已通过。
- 集成测试覆盖 PostgreSQL 事务回滚、Redis 会话撤销和两个 BullMQ Worker 并发去重。
- 当前电脑的 Docker daemon 未运行，因此真实 PostgreSQL/Redis/BullMQ 测试尚未执行；启动 Docker 后必须以 `REQUIRE_INTEGRATION=true` 运行，避免跳过被误认为通过。
