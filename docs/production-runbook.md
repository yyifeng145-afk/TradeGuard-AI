# 单团队生产试运行手册

本文件须以 UTF-8 保存。它描述当前代码能够支持的**受控试运行**，不是“可直接公网放量”的证明。

## 1. 需求理解

目标是一个团队在自建服务器上管理客户、录入外部询价、生成受控报价草稿、由非创建人审批，再从现有邮件或 WhatsApp 渠道人工发送。飞书自定义机器人仅用于内部待办提醒，不接收客户消息，也不执行审批。自动化不能处理的内容进入人工复核。

**Pending confirmation**：客户实际沟通渠道、企业身份源、客户资料的保留与跨境使用规则、预计并发量、备份保留期、RPO/RTO 和系统域名。

## 2. HTTPS、密钥与启动步骤

1. 将域名的 A/AAAA 记录指向服务器，防火墙只对公网开放 80/443；数据库、API 的 8788、Prometheus 和 Alertmanager 均不应公网开放。仓库自带 Caddy 自动申请和续期证书，并屏蔽 `/internal/*`。
2. 复制 `.env.production.example` 为 `.env.production`，不得提交到仓库。若服务器的 Docker 网段与 `172.30.0.0/24` 冲突，先同时修改 Compose 子网、Caddy 固定 IP 和 `CRM_TRUSTED_PROXY_CIDRS`。
3. 在服务器创建仅部署账号可读的 `secrets` 目录。模型密钥、飞书 Webhook、飞书签名密钥及监控令牌各放一个文件；监控令牌用密码学随机源生成且至少 32 字符。目录权限设为 `0700`、文件设为 `0600`，不要把值写入命令历史、日志、镜像或 `.env.production`。应用支持 `NAME_FILE` 形式读取密钥。
4. 生产模式要求模型地址为 HTTPS 或本机回环地址。若使用转发头中的真实客户 IP，须把 API 容器实际看到的反向代理 IP/CIDR 写入 `CRM_TRUSTED_PROXY_CIDRS`。
5. 先执行 `docker compose --env-file .env.production -f compose.prod.yaml config --quiet`。首次初始化时，在操作者的临时环境中设置 `CRM_BOOTSTRAP_EMAIL`、`CRM_BOOTSTRAP_PASSWORD`（至少 16 位）和 `CRM_BOOTSTRAP_ORGANIZATION`，运行 `docker compose --env-file .env.production -f compose.prod.yaml run --rm --no-deps -e CRM_BOOTSTRAP_EMAIL -e CRM_BOOTSTRAP_PASSWORD -e CRM_BOOTSTRAP_ORGANIZATION api pnpm bootstrap:admin`。成功后立即清除这三个一次性变量。
6. 运行 `docker compose --env-file .env.production -f compose.prod.yaml up -d --build`。检查 `docker compose ... ps`、Caddy 证书日志、`https://域名/api/health` 和 `https://域名/api/ready`，然后执行第 8 节的公网安全检查。
7. 经 HTTPS 域名登录，在“团队与资料”页面至少创建两名不同角色的成员、客户、产品、政策和所需知识文档。报价创建人不能自批。在真实客户数据进入系统前完成第 8～10 节验收。

生产版与开发版使用不同的 Compose 文件和数据卷。不要把 `data/crm.db` 或 `crm_data` 演示卷迁入 `crm_prod_data`。

## 3. 页面与交互

- “团队与资料”：管理员创建和停用成员、发布政策；管理员/经理创建客户、移交负责人、维护产品和知识；管理员检查飞书提醒的失败或不确定状态。停用账号前须先移交其客户。
- “账户安全”：每位成员可修改自己的密码，其他登录会话随即撤销。
- “智能会话”：销售录入从既有渠道获得的询价。生产模式不显示示例询价按钮；模型异常会标记“待人工复核”，可在运行页手动重新分析，最多三次。
- “报价与审批”：经理或财务复核；批准后显示“待人工交付”，不会自动向客户发送。销售在外部渠道实际发送后，输入外部消息编号与说明，状态成为“人工交付已登记”，不等同于已送达回执。
- “订单与履约”：销售根据外部客户回复登记接受或拒绝；接受时按报价快照生成订单。生产、风险、待出货、出货和完成均需人工更新，出货必须记录物流或提单编号。该流程仍不等同于渠道或物流平台自动核验。
- “Agent 运行”：查看缺失字段、失败与待人工复核。演示 Golden Corpus 不在生产库运行。

## 4. API 要求

生产模式保留 CSRF 校验和询价 `Idempotency-Key`。新增管理接口 `POST /api/admin/users`、`POST /api/admin/users/:id/disable`、`PATCH /api/customers/:id/owner`、`POST /api/customers`、`POST /api/products`、`POST /api/policies`、`POST /api/knowledge`；账户接口 `POST /api/auth/change-password`；运维接口 `GET /api/admin/notifications` 和管理员人工处置接口 `POST /api/admin/notifications/:id/resolve`；恢复接口 `POST /api/runs/:id/retry`；交付登记接口 `POST /api/quotes/:id/manual-delivery`。所有接口依赖当前会话与服务端角色检查，客户资料另外校验销售归属。`GET /api/ready` 在生产 API/Worker 分进程部署时同时检查数据库和最近 60 秒内的 Worker 心跳；Worker 停止后最多约 60 秒才会转为未就绪，应另配进程级告警。

飞书机器人只发送状态和记录 ID，不发送客户原文、价格、密钥或知识片段。若 HTTP 请求超时，状态为 `uncertain`，**不能自动重发**；管理员先核对群消息，再人工选择“已核实送达”或“重试”。机器人设置、签名与频率限制按[飞书官方自定义机器人文档](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)配置。

## 5. 数据与备份

生产模式使用显式配置的独立 SQLite 文件，API 与 Worker 必须位于同一主机并共享该数据卷；不要把同一卷挂载到多台主机。增量迁移通过事务串行执行。报价、审批、人工交付和通知各有状态记录，客户消息与工具日志分开保存；生产工具调用日志只保存字段名和执行状态，不重复存储原文。

使用 `docker compose --env-file .env.production -f compose.prod.yaml run --rm --no-deps api pnpm backup` 制作 SQLite 一致性快照并执行 `integrity_check`。备份写入独立备份卷，但**同机卷不是异地备份**。配置加密的 rclone remote 后执行 `docker compose --env-file .env.production -f compose.prod.yaml -f compose.offsite.yaml run --rm offsite-backup`，再执行同参数的 `offsite-verify`。远端需启用版本保留/对象锁、独立凭据和生命周期策略。

每月至少抽取一个异地快照下载到隔离主机，执行 `pnpm restore:drill -- <snapshot.sqlite>`。该命令复制到临时目录并检查完整性、必需表、外键和记录数，不覆盖生产库。恢复演练需记录快照时间、RPO、开始/结束时间、RTO 和操作者；正式恢复前必须停止写入并保留损坏库副本。

## 6. 校验规则

报价必须有明确的 SKU、数量、FOB/EXW 及指定地点；CIF 等当前未支持的条款转人工。金额、成本底线、政策版本和有效期由服务端计算校验。模型不可用或返回无效结果时不使用演示解析器，也不生成报价。政策或报价条款变化后，原审批失效。手工登记交付前再次核对政策、版本和有效期。

## 7. 权限与安全

销售仅能访问归属客户，MCP 只读工具遵守相同的客户归属规则并在每次调用时复查账号状态；经理、财务和管理员按角色访问与审批；报价创建人不能自批。销售接口不返回成本价或毛利，运行轨迹中的毛利、内部异常和审批备注也会脱敏。生产 Cookie 带 `Secure`，登录按邮箱限流；配置可信代理后才使用转发来的真实来源 IP 做应用层限流。管理员应为每位成员分配独立账号；成员可改密并撤销其他会话，管理员可移交客户后停用账号。部署前仍须完成 HTTPS、主机补丁、密钥保管、数据保留/删除方案和独立安全审查；本地账号暂不等同于企业 SSO/MFA。

## 8. 上线验证命令

本地先执行 `pnpm build`、`pnpm test` 和 `pnpm audit --prod`。自动化覆盖租户隔离、CSRF、幂等、生产空库、限流、客户归属、模型故障转人工、自批拦截、飞书签名/去重、备份及隔离恢复。

真实环境按以下顺序执行，输出保存到变更单，禁止包含密钥或客户原文：

1. `pnpm verify:external` 使用合成询价验证真实模型结构、延迟阈值和真实飞书签名发送。只有获得群管理员同意后才设置 `FEISHU_RATE_TEST_CONFIRM=YES`，此时最多发送 10 条合成消息检查限频返回码。另在测试环境使用无效模型端点及暂停网络，确认任务进入人工复核且不产生报价。
2. 在 `.env.validation` 配置专用低权限测试账号后运行 `pnpm verify:security`，验证 TLS、安全响应头、内部端点不可公网访问、Secure Cookie 和 CSRF。再按销售、经理、财务、管理员四种身份执行越权矩阵，确认销售不能读取非归属客户、成本/毛利或自批报价。
3. 仅在隔离测试环境设置 `LOAD_CONFIRM_TARGET=staging` 后运行 `pnpm test:load`。请求数模式使用 `LOAD_REQUESTS`；长稳模式使用 `LOAD_DURATION_SECONDS`（上限 24 小时）及 `LOAD_CONCURRENCY`（上限 20）。记录吞吐量、P95/P99、错误率、任务积压、CPU、内存、磁盘和数据库大小；不可对生产客户数据压测。
4. 演练停止 Worker、模型超时、飞书超时、磁盘低水位和数据库只读/损坏副本。确认 API 未就绪、任务不丢失、超时飞书通知标记 `uncertain` 且不盲目重发、告警到达。禁止在生产库上制造磁盘满或损坏。

真实模型的数据合规不是代码测试可以代替的：上线前必须确认供应商 DPA、数据处理地域、传输/静态加密、日志与训练使用策略、保留/删除期限、子处理者及事故通知条款。不满足时仅发送脱敏数据，或改用合规的企业/自托管模型。

## 9. 监控与告警

Prometheus 每 15 秒使用独立 Bearer Token 抓取仅内网开放的指标；规则覆盖 API/数据库不可用、5 分钟内 5xx 异常增长、Worker 心跳超过 60 秒、任务积压、失败任务、通知异常、磁盘低于 10% 和风险订单。Alertmanager 将 firing 事件投递回 API，再由现有飞书通知队列发送记录 ID；它不携带客户原文或价格。Caddy 与容器日志均启用轮转。

首次上线必须逐条触发测试告警并检查“产生—送达—确认—恢复”全链路。若飞书是唯一告警渠道，服务器或网络整体故障时无法通知，因此正式使用还应增加独立于该服务器的外部可用性探测和第二通知渠道。日志应接入集中存储，并设置敏感字段脱敏、访问控制和保留期。

## 10. UAT 与上线门禁

至少由一名真实销售、一名经理/财务和管理员使用脱敏或合成数据完成 [UAT 验收单](uat-checklist.md)。必须确认客户/产品/贸易术语/币种/税费/交期/审批阈值/订单阶段/异常升级等字段与团队实际流程一致。阻断级或高优先级问题清零后由业务负责人签字；未签字不得录入真实客户数据。

## 11. 风险与开放问题

**当前仍未满足全面生产上线**：没有真实客户渠道自动收发与回执；人工交付仅为销售自报；SQLite 单机没有高可用与自动故障切换；没有企业 SSO/MFA；外部 Mem0、WeKnora、Langfuse 尚未使用企业账号联调。若要求多实例、高并发或严格恢复目标，应先迁移 PostgreSQL 与可靠消息队列，并制定正式迁移和回滚计划。

**Pending confirmation**：是否允许一期仅人工录入/发送客户消息；飞书群是否允许收到 CRM 记录 ID；是否已有 HTTPS 域名和反向代理；模型服务能否处理客户资料；是否需要客户级数据删除与导出；期望可用性及恢复时间。未确认前，不应接入真实客户数据或承诺“生产就绪”。
