# PostgreSQL、Redis 与可靠队列迁移需求

> 本文件必须保持 UTF-8 编码。

## 1. 需求理解

将当前只适合单机共享 SQLite 文件的部署模式，升级为 API、Worker 可独立水平扩容的生产架构。PostgreSQL 是业务事实唯一权威源；Redis 仅承载会话、限流、缓存和 BullMQ 队列，不得成为报价、审批、订单或审计事实的唯一存储。

## 2. 功能拆分

- PostgreSQL：客户、产品、会话、消息、商机、报价、审批、订单、证据、审计和运行记录。
- Redis：登录会话、登录失败限流、短期缓存、分布式互斥和 BullMQ。
- BullMQ：Agent 分析、审批后派发、飞书通知、Mem0 同步和知识同步任务。
- Worker：可运行多个副本；任务使用确定性 Job ID，至少一次投递，业务写入依靠 PostgreSQL 唯一约束实现幂等。
- 运维：PostgreSQL/Redis 健康检查、连接池、队列积压、失败任务、数据库连接数和复制/备份告警。

## 3. 页面与交互

现有页面和业务交互保持不变。任务状态继续从 PostgreSQL 查询，前端不直接访问 Redis 或队列。失败任务进入人工处理状态，不在页面上伪装成成功。

## 4. API 要求

- 现有 API 路径和响应字段保持兼容。
- 写接口继续要求 CSRF、幂等键和角色权限。
- 接口成功只表示业务事实已持久化；异步执行返回 `202`。
- Ready 探针同时验证 PostgreSQL、Redis和队列 Worker 心跳。

## 5. 数据要求

- 主键继续使用 UUID/Text，避免集中式序列成为迁移障碍。
- 金额继续使用整数分，不使用浮点金额。
- JSON 文本逐步迁移为 `jsonb`，第一阶段保持字段兼容。
- 时间统一使用 UTC；迁移后新列使用 `timestamptz`。
- 所有组织级业务表保留 `organization_id` 并建立组合索引。
- SQLite 迁移必须核对每张表行数、关键外键和内容哈希。

## 6. 校验规则

- 生产环境必须配置 `DATABASE_URL` 和 `REDIS_URL`，禁止回退 SQLite 或内存 Redis。
- 队列 Job ID 必须由业务幂等键生成。
- 队列失败不得绕过审批、权限复核和证据版本复核。
- Redis 数据丢失不能造成业务事实丢失；可由 PostgreSQL 重新生成待执行任务。

## 7. 权限与菜单

权限矩阵保持不变。数据库连接账号按 API、Worker、迁移、备份拆分；应用账号不得拥有建库和超级用户权限。后续可启用 PostgreSQL RLS 作为第二道租户隔离防线。

## 8. 测试与回归范围

- PostgreSQL 集成测试：事务、唯一约束、并发写、租户隔离、审批和订单状态机。
- Redis 测试：会话撤销、TTL、限频和故障行为。
- BullMQ 测试：重复投递、Worker 崩溃、重试、退避、死信和多 Worker 竞争。
- 迁移测试：SQLite 快照导入、行数核对、哈希核对和回滚。
- 性能测试：API 多实例、Worker 多实例、连接池饱和和队列积压恢复。

## 9. 风险与待确认项

- 第一阶段采用单主 PostgreSQL + 持久化 Redis；跨可用区高可用由部署平台提供。
- `Pending confirmation`：云厂商、托管 PostgreSQL/Redis 规格和备份保留周期。
- `Pending confirmation`：是否要求 PostgreSQL RLS 在第一期强制上线。
- SQLite 到 PostgreSQL 切换需要短暂停写窗口；在真实部署前确定可接受时长。

