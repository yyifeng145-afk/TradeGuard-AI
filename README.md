# Northstar CRM · 跨境客户经营与可信 Agent 协作

这是一个跨会话客户偏好、企业知识、报价规则、人工审批和 Agent 执行记录一体化的 CRM 项目。现在分为开发演示模式和单团队生产试运行模式；**生产试运行不等于已经完成真实客户渠道、企业 SSO 和高可用部署**。项目参考用户提供的架构图，不是原作者未开源代码的复刻。

生产试运行的部署步骤、验收门槛和待确认事项见 [生产试运行手册](docs/production-runbook.md)。请勿把现有演示数据库复制到生产卷。

## 已实现的业务闭环

客户询价 → 持久化任务 → 结构化抽取 → 受控工具读取 CRM / 客户记忆 / 企业知识 → 服务端整数金额计算 → 人工审批 → 报价交付 → 客户结果登记 → 订单履约与风险跟踪 → 审计与回归评测。

| 层次 | 当前实现 | 关键约束 |
| --- | --- | --- |
| 多租户 CRM | 客户、会话、产品、政策、报价、审批、审计 | 所有业务查询按 `organization_id` 限定 |
| Agent Worker | SQLite 任务租约、重试、运行事件、工具调用日志 | 模型只负责抽取；价格、权限和发送由服务端决定 |
| 工具网关 / MCP | 7 个内部受控工具；独立只读 MCP stdio 服务；二者复用领域查询与授权层 | 高风险动作不能通过 MCP 直接执行，避免入口间权限漂移 |
| 客户记忆 | 会话显式偏好提取为候选；人工确认；Mem0 最多召回 50 条并按 Hash 去重、重排 Top 10、返回前脱敏 | 未确认或外部检索结果不能作为报价权威证据 |
| 企业知识 | 已发布、有效期内且匹配产品范围的本地文档；报价固化版本与 SHA-256 指纹；可选 WeKnora | 审批、发送和人工交付前复核引用，撤回、过期、改版或静默改文均会使报价失效 |
| 报价治理 | 最小起订量、低于成本拦截、折扣和毛利率升级审批、政策版本校验 | 新报价必须记录贸易术语、指定地点和 30 天有效期；过期或政策变化会失效，不再发送 |
| 接口安全 | 会话 Cookie、CSRF 令牌、必填询价幂等键、跨租户校验 | 重复提交返回原任务；不同内容复用同一幂等键会被拒绝 |
| 订单履约 | 客户接受/拒绝、报价转订单、生产/风险/出货状态、物流凭据 | 订单固化获批报价快照，状态更新使用乐观锁并完整审计 |
| 质量与观测 | 8 项演示 Golden Corpus、26 项自动化测试、Prometheus/Alertmanager、可选 Langfuse 白名单元数据追踪与工具耗时 | 生产库禁用演示评测；监控和追踪不发送客户消息或工具参数 |

## 快速运行

要求 Node.js 24+、pnpm 11。项目使用 Node 内置 SQLite，无需先安装数据库。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:5173`。生产构建与单端口预览：

```bash
pnpm build
pnpm start
```

随后打开 `http://127.0.0.1:8787`。首次运行自动生成 `data/crm.db` 和演示数据。默认只监听本机；Docker Compose 也只映射到 `127.0.0.1`。

演示账号密码统一为 `Demo123!`：

- `sales@northstar.demo`：销售，发起询价、确认记忆；无权审批。
- `manager@northstar.demo`：经理，审批普通报价、运行评测。
- `finance@northstar.demo`：财务，审批高折扣或低毛利报价。
- `sales@other.demo`：第二租户，仅用于隔离测试，登录页不直接列出。

推荐演示文本：`Need 5,000 units of AX-200 with 20% discount, FOB Los Angeles.`。AX-200 标价 USD 12.80、成本 USD 8.50，折扣后单价 USD 10.24，总价 USD 51,200.00，毛利率约 16.99%。因此进入财务审批；销售不能越权批准，审批前也不会对客户发送正式报价。切换财务账号批准后，可在会话和 Agent 运行里查看结果。未写明贸易术语及指定地点时，系统会要求补充，而不会自行编造。

## 可选服务

复制 `.env.example` 为 `.env` 并按需设置。**不要把真实客户数据或密钥放入演示库，也不要使用默认账号对公网开放服务。**

- 模型：配置 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`，指向兼容 `/chat/completions` 的接口。只用于询价字段抽取；开发模式故障时可退回本地演示解析，**生产模式则停止自动报价并转人工复核**。所有关键金额与权限仍由代码校验。
- WeKnora：配置 `WEKNORA_BASE_URL`、`WEKNORA_API_KEY`、`WEKNORA_KNOWLEDGE_BASE_MAP`，例如 `{"org_northstar":"kb-id"}`。未为某租户配置知识库时，绝不复用别的租户知识库。
- Mem0 Platform：同时配置 `MEM0_SYNC_ENABLED=true` 和 `MEM0_API_KEY` 才会调用外部 API。仅把人工确认的偏好发往 Mem0；检索时使用 `orgId:customerId` 作为隔离键，请求最多 50 条候选，经本地内容 Hash 去重和关键词/供应商分数组合重排后只注入 Top 10，并对邮箱和电话脱敏。返回内容仍是待核实线索。此动作会把客户偏好传给 Mem0，配置前应完成企业隐私与跨境传输审查。
- Langfuse：配置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`。只导出运行状态、模式、工具名与结果，不上传客户原文、报价内容或工具输入。接入失败不影响主业务。

以上外部集成在没有真实账号和服务的环境下只做了代码与模拟请求测试，未声称完成真实服务联调。

## MCP 接入

独立 stdio MCP 服务暴露五个只读工具：`list_customers`、`get_customer_profile`、`search_products`、`get_quote_policy`、`search_knowledge`。启动前设置 `CRM_MCP_EMAIL` 与 `CRM_MCP_PASSWORD`，再运行 `pnpm mcp:stdio`。它不会暴露报价创建、审批或发送工具；销售账号仅能读取自己负责的客户，账号停用后现有 MCP 进程也会拒绝后续工具调用。测试使用 MCP SDK 客户端完成了协议握手、跨租户和客户归属校验。

## 测试与部署

```bash
pnpm test
pnpm build
docker compose up --build
```

26 项自动化测试覆盖：租户知识库隔离、报价审批与恰好一次本地交付、Agent 运行/客户绑定、候选记忆、Mem0 50→Top10 重排/Hash 去重/脱敏、知识内容静默修改失效、报价过期/政策变化失效、询价幂等、CSRF、HTTP 多租户边界、Golden Corpus、MCP 握手与只读边界、销售运行轨迹脱敏、Worker 就绪探针、监控指标及备份恢复演练。UI 的“质量评测”可由经理或财务手动触发 8 项固定业务断言。

参考 TradePilot 外贸业务链补充的差距分析、接口、数据和后续规划见 [TradePilot 业务流程对照](docs/tradepilot-gap-analysis.md)。当前订单由销售依据外部客户回复人工登记生成，不代表系统已核验真实渠道回执。

生产 Compose 已包含 Caddy 自动 HTTPS、Docker secrets、日志轮转、Prometheus/Alertmanager、内部飞书告警和异地备份辅助任务，且 `docker compose config` 已校验；本机没有运行中的生产服务器，因此证书签发、真实告警送达和整套容器长稳运行尚未实测。上线前必须按[生产验证记录](docs/production-validation-record.md)完成真实账号、外部存储、安全/并发/长稳及 UAT 验收。若要求多实例或自动故障切换，仍需迁移 PostgreSQL 与可靠消息队列。

## 代码审查后的优化与剩余问题

本轮已修复五类直接影响演示可信度的问题：正式报价缺少贸易条款和有效期；Cookie 写接口没有 CSRF 校验；重复询价会产生重复任务；报价过期或政策更新后仍停留在“待审批/已批准”状态；跨产品检索可能把 AX-200 手册误当作 BX-90 报价依据。旧数据库中的历史报价会保留原状，新报价开始执行更严格的规则；无法可靠补造的旧条款不会被伪造。

仍需单独建设的部分：

1. **上线安全（高优先级）**：生产模式已禁止演示账号自动播种，增加登录限流、密码更换与会话撤销、账号停用、客户移交、HTTPS Secure Cookie、销售客户归属、自批拦截和文件型容器密钥；企业 SSO/MFA、云 KMS/集中密钥托管和独立安全审查仍未完成。
2. **真实渠道与交付（高优先级）**：飞书现在仅作为内部待办提醒；生产模式不再伪造 Web 客户送达，而是要求销售人工发送并登记外部凭据。真实客户渠道自动收发、回执与对账仍未接入。
3. **外部记忆可靠性（中优先级）**：Mem0 同步失败目前只记录审计，没有持久重试队列；外部检索结果保持未核实，不能直接提升为报价依据。
4. **评测泛化（中优先级）**：当前 Golden Corpus 以种子产品和政策为基线，应扩充真实脱敏样本、模型误抽取、提示注入、并发与多租户压力测试。
5. **架构扩展（中优先级）**：SQLite + WAL、事务化任务租约和一致性备份支持限定负载的单机试运行；多实例、高可用及更严格恢复目标仍需 PostgreSQL、可靠队列和演练，不应直接横向扩容共享 SQLite 卷。

## 与参考架构的差异

现阶段不是参考架构的 1:1 全量复刻。前端为 React + Vite；Agent 使用确定性状态机与模型抽取，未采用 Pi Agent Core 通用循环；开发模式仍用 Web 演示会话。项目已吸收共享领域授权、Mem0 分层召回与知识版本/内容指纹复核等做法，但没有为了简历凑满 18 个工具。生产试运行模式的飞书机器人只发内部通知，客户询价由销售人工录入，正式报价由销售在已有渠道手动交付并登记。Mem0、WeKnora、Langfuse 均是可选适配器，未经真实账号联调不能称为生产集成已验证。

## 参考资料

- [用户提供的飞书文档](https://kcnjsi69cjvj.feishu.cn/wiki/DNBAwIDMViIdkJkGryqcO9YUnab)
- [WeKnora 知识检索 API](https://github.com/Tencent/WeKnora/blob/main/docs/api/knowledge-search.md)
- [Mem0 Platform Quickstart](https://docs.mem0.ai/platform/quickstart)
- [Langfuse Observability](https://langfuse.com/docs/observability/get-started)
