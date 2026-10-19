import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, BookOpen, Bot, BrainCircuit,
  Check, CheckCheck, ChevronRight, CircleAlert, ClipboardCheck, Clock3,
  Command, Database, FileCheck2, FileText, Filter, Globe2, LayoutDashboard, LockKeyhole,
  LogOut, Menu, MessageCircle, MoreHorizontal, Package, Plus, Search, Send, Settings2,
  ShieldCheck, Sparkles, Users, X
} from "lucide-react";
import {
  api, formatDate, formatMoney,
  type AgentRun, type Bootstrap, type Customer, type CustomerDetail, type EvaluationCase,
  type EvaluationRun, type Quote, type RunDetail, type SalesOrder, type User
} from "./api";
import AdminSetup from "./AdminSetup";
import AccountSecurity from "./AccountSecurity";
import "./agent-results.css";

type Page = "overview" | "customers" | "workspace" | "quotes" | "orders" | "runs" | "evaluation" | "audit" | "setup" | "account";
const nav: Array<{ id: Page; title: string; icon: typeof LayoutDashboard; section: string }> = [
  { id: "overview", title: "总览", icon: LayoutDashboard, section: "工作台" },
  { id: "customers", title: "客户档案", icon: Users, section: "工作台" },
  { id: "workspace", title: "智能会话", icon: MessageCircle, section: "工作台" },
  { id: "quotes", title: "报价与审批", icon: FileCheck2, section: "业务协作" },
  { id: "orders", title: "订单与履约", icon: Package, section: "业务协作" },
  { id: "runs", title: "Agent 运行", icon: Activity, section: "业务协作" },
  { id: "evaluation", title: "质量评测", icon: ShieldCheck, section: "治理中心" },
  { id: "audit", title: "审计日志", icon: FileText, section: "治理中心" },
  { id: "setup", title: "团队与资料", icon: Settings2, section: "治理中心" },
  { id: "account", title: "账户安全", icon: LockKeyhole, section: "治理中心" }
];

const roleLabel: Record<User["role"], string> = { sales: "销售代表", manager: "销售经理", finance: "财务审批", admin: "管理员", auditor: "审计员" };
const statusLabel: Record<string, string> = {
  queued: "等待处理", running: "执行中", awaiting_approval: "等待审批", dispatch_queued: "等待发送",
  manual_delivery_required: "待人工交付", manual_delivery_recorded: "人工交付已登记",
  succeeded: "已完成", needs_clarification: "待补充信息", needs_manual_review: "待人工复核", failed: "执行失败", rejected: "已驳回",
  pending_approval: "待审批", approved: "已批准", sent: "已发送", draft: "草稿", stale: "已失效", invalidated: "审批失效",
  confirmed: "订单已确认", production: "生产中", at_risk: "交期风险", ready_to_ship: "待出货", shipped: "已出货", completed: "已完成", cancelled: "已取消",
  accepted: "客户已接受", rejected_by_customer: "客户已拒绝"
};

function Status({ value }: { value: string }) {
  const tone = ["succeeded", "sent", "approved", "confirmed", "completed"].includes(value) ? "green"
    : ["failed", "rejected", "cancelled"].includes(value) ? "red"
      : ["awaiting_approval", "pending_approval", "manual_delivery_required", "needs_clarification", "needs_manual_review", "stale", "invalidated", "at_risk"].includes(value) ? "amber" : "blue";
  return <span className={`status status-${tone}`}><span className="status-dot" />{statusLabel[value] ?? value}</span>;
}

function SectionHeader({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><span>{text}</span></div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try { const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); onLogin(result.user); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setLoading(false); }
  }
  return <div className="login-shell">
    <div className="login-showcase"><div className="showcase-brand"><span className="brand-mark">N<span>.</span></span><span>Northstar CRM</span></div>
      <div className="showcase-content"><div className="showcase-kicker"><Sparkles size={15} /> AI-NATIVE CUSTOMER OPERATIONS</div><h1>让每一次客户对话<br />都有迹可循。</h1><p>把客户事实、报价规则与人工审批放进同一条可信的 Agent 工作流。</p>
        <div className="showcase-flow"><span><MessageCircle size={18} /> 客户询价</span><ArrowRight size={16} /><span><BrainCircuit size={18} /> 智能取证</span><ArrowRight size={16} /><span><ShieldCheck size={18} /> 审批交付</span></div>
      </div><div className="showcase-footer">CROSS-BORDER COMMERCE · INTELLIGENT COLLABORATION</div>
    </div>
    <div className="login-panel"><div className="login-card"><div className="login-overline">WORKSPACE ACCESS</div><h2>欢迎回来</h2><p>请使用团队分配的账号登录 CRM 工作台。</p>
      <form onSubmit={submit}><label htmlFor="login-email">邮箱</label><input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="login-password">密码</label><input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
        <button className="button primary login-button" disabled={loading}>{loading ? "登录中..." : "进入工作台"}<ArrowRight size={17} /></button>
      </form><div className="login-tip"><LockKeyhole size={15} />正式报价需由非创建人审批。</div>
    </div></div>
  </div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [user, setUser] = useState<User | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [inquiry, setInquiry] = useState("");
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const pendingInquiry = useRef<{ customerId: string; text: string; key: string } | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const [toast, setToast] = useState("");
  const [approvalModal, setApprovalModal] = useState<{ quote: Quote; decision: "approved" | "rejected" } | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [deliveryModal, setDeliveryModal] = useState<Quote | null>(null);
  const [deliveryChannel, setDeliveryChannel] = useState("email");
  const [deliveryReference, setDeliveryReference] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [responseModal, setResponseModal] = useState<Quote | null>(null);
  const [customerDecision, setCustomerDecision] = useState<"accepted" | "rejected">("accepted");
  const [responseChannel, setResponseChannel] = useState("email");
  const [responseReference, setResponseReference] = useState("");
  const [responseNote, setResponseNote] = useState("");
  const [orderModal, setOrderModal] = useState<SalesOrder | null>(null);
  const [orderTarget, setOrderTarget] = useState<SalesOrder["status"]>("production");
  const [orderNote, setOrderNote] = useState("");
  const [trackingReference, setTrackingReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [evaluation, setEvaluation] = useState<{ total: number; passed: number; cases: EvaluationCase[]; createdAt: string } | null>(null);

  async function refresh(silent = false) {
    try { const data = await api<Bootstrap>("/api/bootstrap"); setBoot(data); setUser(data.user); setSelectedCustomer((current) => data.customers.some((item) => item.id === current) ? current : data.customers[0]?.id ?? ""); }
    catch { if (!silent) { setUser(null); setBoot(null); } }
    finally { if (!silent) setLoading(false); }
  }
  async function loadCustomer(customerId: string) {
    try { const data = await api<CustomerDetail>(`/api/customers/${customerId}`); setCustomerDetail(data); }
    catch (error) { notify(String(error)); }
  }
  async function loadRun(runId: string) {
    try { setRunDetail(await api<RunDetail>(`/api/runs/${runId}`)); }
    catch (error) { notify(String(error)); }
  }
  function notify(message: string) { setToast(message); }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      void refresh(true);
      if (selectedCustomer && ["workspace", "customers"].includes(page)) void loadCustomer(selectedCustomer);
      if (selectedRun && ["workspace", "runs"].includes(page)) void loadRun(selectedRun);
    }, 2500);
    return () => clearInterval(timer);
  }, [user?.id, selectedCustomer, selectedRun, page]);
  useEffect(() => { if (user && selectedCustomer) void loadCustomer(selectedCustomer); }, [user?.id, selectedCustomer]);
  useEffect(() => { if (selectedRun) void loadRun(selectedRun); }, [selectedRun]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!sidebarOpen && !approvalModal && !deliveryModal && !responseModal && !orderModal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSidebarOpen(false); setApprovalModal(null); setDeliveryModal(null); setResponseModal(null); setOrderModal(null); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen, approvalModal, deliveryModal, responseModal, orderModal]);

  const selected = boot?.customers.find((customer) => customer.id === selectedCustomer);
  const latestCustomerRun = useMemo(() => boot?.runs.find((item) => item.customer_id === selectedCustomer), [boot?.runs, selectedCustomer]);
  const conversationItems = useMemo(() => {
    if (!customerDetail) return [];
    return [
      ...customerDetail.messages.map((message) => ({ kind: "message" as const, id: message.id, createdAt: message.created_at, message })),
      ...customerDetail.runs.map((run) => ({ kind: "run" as const, id: run.id, createdAt: run.created_at, run }))
    ].sort((left, right) => {
      const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (timeDifference !== 0) return timeDifference;
      return left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "message" ? -1 : 1;
    });
  }, [customerDetail]);
  const displayRun = runDetail?.run.id === selectedRun ? runDetail : null;
  useEffect(() => {
    if (!user || selectedRun) return;
    const nextRun = page === "workspace" ? latestCustomerRun?.id : page === "runs" ? boot?.runs[0]?.id : undefined;
    if (nextRun) setSelectedRun(nextRun);
  }, [user?.id, page, selectedRun, latestCustomerRun?.id, boot?.runs]);
  useEffect(() => {
    if (page !== "workspace") return;
    const frame = requestAnimationFrame(() => {
      const body = chatBodyRef.current;
      if (body) body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [page, selectedCustomer, conversationItems.length, customerDetail?.runs[0]?.updated_at]);

  function navigate(next: Page, customerId?: string, runId?: string) {
    if (customerId) setSelectedCustomer(customerId);
    if (runId) setSelectedRun(runId);
    else if (customerId) setSelectedRun(null);
    setPage(next); setSidebarOpen(false);
  }
  async function submitInquiry(event: FormEvent) {
    event.preventDefault(); if (!inquiry.trim()) return;
    setBusy(true);
    try {
      const text = inquiry.trim();
      const prior = pendingInquiry.current;
      const key = prior?.customerId === selectedCustomer && prior.text === text ? prior.key : crypto.randomUUID();
      pendingInquiry.current = { customerId: selectedCustomer, text, key };
      const result = await api<{ runId: string }>("/api/messages", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ customerId: selectedCustomer, text }) });
      pendingInquiry.current = null;
      setInquiry(""); setSelectedRun(result.runId); notify("询价已提交，Agent 正在分析证据");
      await Promise.all([refresh(true), loadCustomer(selectedCustomer), loadRun(result.runId)]);
    } catch (error) { notify(String(error)); }
    finally { setBusy(false); }
  }
  async function submitMemory(event: FormEvent) {
    event.preventDefault(); if (!memoryText.trim()) return;
    setBusy(true);
    try {
      await api(`/api/customers/${selectedCustomer}/memories`, { method: "POST", body: JSON.stringify({ content: memoryText }) });
      setMemoryText(""); await loadCustomer(selectedCustomer); notify("已新增候选记忆，确认后才会进入报价证据");
    } catch (error) { notify(String(error)); }
    finally { setBusy(false); }
  }
  async function confirmMemory(memoryId: string) {
    try { await api(`/api/memories/${memoryId}/confirm`, { method: "POST" }); await loadCustomer(selectedCustomer); notify("客户偏好已人工确认"); }
    catch (error) { notify(String(error)); }
  }
  async function submitApproval() {
    if (!approvalModal) return;
    setBusy(true);
    try {
      await api(`/api/approvals/${approvalModal.quote.approval_id}/decision`, { method: "POST", body: JSON.stringify({ decision: approvalModal.decision, note: approvalNote }) });
      notify(approvalModal.decision === "approved" ? (boot?.capabilities.environment === "production" ? "审批通过，等待人工向客户交付" : "审批通过，发送任务已排队") : "报价已驳回");
      setApprovalModal(null); setApprovalNote(""); await refresh(true);
    } catch (error) {
      notify(String(error));
      if (String(error).includes("报价已失效")) { setApprovalModal(null); await refresh(true); }
    }
    finally { setBusy(false); }
  }
  async function executeEvaluation() {
    setBusy(true);
    try { const result = await api<{ total: number; passed: number; cases: EvaluationCase[]; createdAt: string }>("/api/evaluations/run", { method: "POST" }); setEvaluation(result); await refresh(true); notify(`评测完成：${result.passed}/${result.total} 通过`); }
    catch (error) { notify(String(error)); }
    finally { setBusy(false); }
  }
  async function retrySelectedRun() {
    if (!selectedRun) return;
    setBusy(true);
    try {
      await api(`/api/runs/${selectedRun}/retry`, { method: "POST" });
      await Promise.all([refresh(true), loadRun(selectedRun)]);
      notify("已重新排队分析；模型仍不可用时会再次转人工复核");
    } catch (error) { notify(String(error)); }
    finally { setBusy(false); }
  }
  async function submitManualDelivery() {
    if (!deliveryModal) return;
    setBusy(true);
    try {
      await api(`/api/quotes/${deliveryModal.id}/manual-delivery`, { method: "POST", body: JSON.stringify({ channel: deliveryChannel, externalReference: deliveryReference, note: deliveryNote }) });
      setDeliveryModal(null); setDeliveryReference(""); setDeliveryNote("");
      await refresh(true); notify("人工交付已登记；渠道回执尚未由系统核验");
    } catch (error) { notify(String(error)); await refresh(true); }
    finally { setBusy(false); }
  }
  async function submitCustomerResponse() {
    if (!responseModal) return;
    setBusy(true);
    try {
      const result = await api<{ orderId: string | null }>(`/api/quotes/${responseModal.id}/customer-response`, {
        method: "POST", body: JSON.stringify({ decision: customerDecision, channel: responseChannel, externalReference: responseReference, note: responseNote })
      });
      setResponseModal(null); setResponseReference(""); setResponseNote("");
      await refresh(true);
      notify(result.orderId ? "客户接受已登记，并已生成可追踪订单" : "客户拒绝已登记，未创建订单");
      if (result.orderId) navigate("orders");
    } catch (error) { notify(String(error)); await refresh(true); }
    finally { setBusy(false); }
  }
  function openOrderUpdate(order: SalesOrder) {
    if (!user) return;
    const options = orderTransitions(order, user.role);
    if (!options.length) return;
    setOrderModal(order); setOrderTarget(options[0]); setOrderNote(""); setTrackingReference("");
  }
  async function submitOrderUpdate() {
    if (!orderModal) return;
    setBusy(true);
    try {
      await api(`/api/orders/${orderModal.id}/status`, { method: "PATCH", body: JSON.stringify({
        status: orderTarget, expectedVersion: orderModal.version, note: orderNote,
        ...(orderTarget === "shipped" ? { trackingReference } : {})
      }) });
      setOrderModal(null); await refresh(true); notify("订单履约状态已更新并写入审计记录");
    } catch (error) { notify(String(error)); await refresh(true); }
    finally { setBusy(false); }
  }
  async function logout() { await api("/api/auth/logout", { method: "POST" }); setUser(null); setBoot(null); setCustomerDetail(null); setRunDetail(null); }

  if (loading) return <div className="splash"><span className="brand-mark">N<span>.</span></span><span>正在加载工作台...</span></div>;
  if (!user || !boot) return <Login onLogin={(next) => { setUser(next); void refresh(); }} />;

  const searchableCustomers = boot.customers.filter((customer) => `${customer.name} ${customer.country} ${customer.industry}`.toLowerCase().includes(search.toLowerCase()));
  const pending = boot.quotes.filter((quote) => quote.approval_status === "pending");
  const canApprove = (quote: Quote) => quote.approval_status === "pending" && quote.quote_created_by !== user.id && (user.role === quote.required_role || user.role === "admin");
  const todayLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());

  return <div className="app-shell">
    {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label="关闭导航菜单" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><span className="brand-mark">N<span>.</span></span><div><strong>Northstar</strong><small>CRM INTELLIGENCE</small></div><button className="mobile-close icon-button" aria-label="关闭导航菜单" onClick={() => setSidebarOpen(false)}><X size={19} /></button></div>
      <div className="workspace-switch"><div className="workspace-avatar">CRM</div><div><strong>{boot.organizationName}</strong><small>Team workspace</small></div><span className="workspace-badge">{boot.capabilities.environment === "production" ? "TEAM" : "DEMO"}</span></div>
      <nav className="nav-list" aria-label="主导航">{["工作台", "业务协作", "治理中心"].map((section) => <div key={section} className="nav-group"><div className="nav-section">{section}</div>{nav.filter((item) => item.section === section && (item.id !== "setup" || ["admin", "manager"].includes(user.role)) && (item.id !== "evaluation" || (user.role !== "sales" && boot.capabilities.environment !== "production"))).map(({ id: itemId, icon: Icon, title }) => <button key={itemId} className={`nav-item ${page === itemId ? "nav-active" : ""}`} aria-current={page === itemId ? "page" : undefined} onClick={() => navigate(itemId)}><Icon size={18} strokeWidth={1.9} /><span>{title}</span>{itemId === "quotes" && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="system-card"><div className="system-icon"><ShieldCheck size={18} /></div><strong>可信执行模式</strong><p>所有正式报价均经过人工审批与审计记录。</p><span><span className="online-dot" />服务已连接</span></div><button className="sidebar-settings" onClick={() => navigate(["admin", "manager"].includes(user.role) ? "setup" : "audit")}><Settings2 size={17} /> 团队配置与审计 <ArrowRight size={15} /></button></div>
    </aside>

    <div className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-button" aria-label="打开导航菜单" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span className="breadcrumb">Northstar CRM</span><ChevronRight size={14} /><strong>{nav.find((item) => item.id === page)?.title}</strong></div><div className="topbar-right"><div className="topbar-badge"><span className="online-dot" />{boot.capabilities.model === "connected" ? "模型已配置" : "本地演示模式"}</div><button className="top-icon" onClick={() => navigate("quotes")} aria-label="审批通知"><Bell size={18} />{pending.length > 0 && <i />}</button><div className="top-divider" /><div className="user-menu"><div className="user-avatar">{user.name.slice(0, 1)}</div><div><strong>{user.name}</strong><small>{roleLabel[user.role]}</small></div></div><button className="top-icon logout" aria-label="退出登录" onClick={logout} title="退出登录"><LogOut size={18} /></button></div></header>

      <main className={`content content-${page}`}>
        {page === "overview" && <>
          <SectionHeader eyebrow={`${todayLabel} · CUSTOMER OPERATIONS`} title="经营总览" subtitle="从客户对话到报价交付，关键进展尽在掌握。" action={<button className="button primary" disabled={!boot.customers.length} onClick={() => navigate("workspace", boot.customers[0]?.id)}><Plus size={17} /> 发起智能询价</button>} />
          <div className="hero-panel"><div className="hero-content"><div className="hero-pill"><Sparkles size={14} /> AI 协作工作台</div><h2>让团队在可信的边界内，<br />更快推进每一笔跨境订单。</h2><p>客户记忆、企业政策和报价审批共同驱动可追溯的销售决策。</p><button disabled={!boot.customers.length} onClick={() => navigate("workspace", boot.customers[0]?.id)} className="hero-link">进入智能会话 <ArrowRight size={17} /></button></div><div className="hero-art"><div className="orb orb-one" /><div className="orb orb-two" /><div className="floating-card card-one"><div className="float-icon teal"><MessageCircle size={17} /></div><span>客户询价已接收</span><Check size={15} /></div><div className="floating-card card-two"><div className="float-icon purple"><BrainCircuit size={17} /></div><span>证据链校验完成</span><Check size={15} /></div><div className="floating-card card-three"><div className="float-icon orange"><ShieldCheck size={17} /></div><span>等待人工审批</span><Clock3 size={15} /></div></div></div>
          <div className="metric-grid"><Metric icon={<Users size={20} />} label="客户总数" value={String(boot.metrics.customers).padStart(2, "0")} detail="覆盖跨境贸易市场" tone="teal" /><Metric icon={<Activity size={20} />} label="进行中任务" value={String(boot.metrics.activeRuns).padStart(2, "0")} detail="实时跟踪执行状态" tone="violet" /><Metric icon={<ClipboardCheck size={20} />} label="待审批报价" value={String(boot.metrics.pendingApprovals).padStart(2, "0")} detail="高风险动作人工把关" tone="orange" /><Metric icon={<Package size={20} />} label="履约中订单" value={String(boot.metrics.activeOrders).padStart(2, "0")} detail={boot.metrics.atRiskOrders ? `${boot.metrics.atRiskOrders} 笔存在交期风险` : `${formatMoney(boot.metrics.orderVolumeCents)} 在执行`} tone="blue" /></div>
          <div className="overview-grid"><div className="panel"><div className="panel-head"><div><h3>最近的 Agent 运行</h3><p>可追踪的每一步智能协作</p></div><button className="text-link" onClick={() => navigate("runs")}>查看全部 <ArrowRight size={15} /></button></div>{boot.runs.length ? <div className="run-list">{boot.runs.slice(0, 4).map((item) => <button className="run-row" key={item.id} onClick={() => navigate("runs", item.customer_id, item.id)}><div className="run-icon"><Bot size={18} /></div><div><strong>{item.customer_name}</strong><small>{item.summary ?? "Agent 正在处理询价"}</small></div><Status value={item.status} /></button>)}</div> : <Empty icon={<Bot size={24} />} title="尚无运行记录" text="发起一条询价，观察 Agent 的完整取证流程。" />}</div>
            <div className="panel approval-panel"><div className="panel-head"><div><h3>待处理审批</h3><p>报价动作由人做最终决策</p></div><span className="count-pill">{pending.length} 项</span></div>{pending.length ? pending.slice(0, 3).map((quote) => <button key={quote.id} className="approval-preview" onClick={() => navigate("quotes")}><div className="approval-preview-top"><strong>{quote.customer_name}</strong><span>{formatMoney(quote.total_cents)}</span></div><p>{quote.sku} · {quote.quantity.toLocaleString()} 件 · 折扣 {(quote.discount_bps / 100).toFixed(0)}%</p><div><span className="risk-dot" />需{quote.required_role === "finance" ? "财务" : "经理"}审批 <ArrowRight size={15} /></div></button>) : <Empty icon={<CheckCheck size={24} />} title="审批已清空" text="当前没有等待处理的正式报价。" />}</div></div>
          <div className="panel customers-panel"><div className="panel-head"><div><h3>重点客户</h3><p>客户经营概况与最近互动</p></div><button className="text-link" onClick={() => navigate("customers")}>客户档案 <ArrowRight size={15} /></button></div><CustomerTable customers={boot.customers} onSelect={(customerId) => navigate("customers", customerId)} /></div>
        </>}

        {page === "customers" && <>
          <SectionHeader eyebrow="CUSTOMER 360°" title="客户档案" subtitle="统一查看客户事实、跨会话记忆与历史互动。" action={<div className="header-chip"><Database size={16} /> SQL 权威事实</div>} />
          <div className="search-row"><div className="search-field"><Search size={18} /><input type="search" aria-label="搜索客户、国家或行业" placeholder="搜索客户、国家或行业..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><span className="filter-button"><Filter size={17} />全部客户</span></div>
          <div className="customer-layout"><div className="panel customer-list-panel"><div className="panel-label">客户列表 <span>{searchableCustomers.length}</span></div>{searchableCustomers.length ? searchableCustomers.map((customer) => <button key={customer.id} onClick={() => setSelectedCustomer(customer.id)} className={`customer-list-item ${selectedCustomer === customer.id ? "selected" : ""}`}><div className="customer-avatar">{customer.name.slice(0, 2).toUpperCase()}</div><div><strong>{customer.name}</strong><small>{customer.country} · {customer.industry}</small></div><ChevronRight size={16} /></button>) : <div className="customer-search-empty">没有找到匹配的客户，请试试其他关键词。</div>}</div>
            <div className="customer-detail-column">{selected && <><div className="panel customer-profile"><div className="profile-top"><div className="profile-monogram">{selected.name.slice(0, 2).toUpperCase()}</div><div><div className="profile-title"><h2>{selected.name}</h2><span className="tier-badge">{selected.tier} 级客户</span></div><p>{selected.country} · {selected.industry}</p></div><button className="button secondary" onClick={() => navigate("workspace", selected.id)}><MessageCircle size={16} /> 打开会话</button></div><p className="profile-description">{selected.description}</p><div className="profile-facts"><div><span>客户状态</span><strong>{selected.status}</strong></div><div><span>客户负责人</span><strong>{selected.owner_name}</strong></div><div><span>最近互动</span><strong>{formatDate(selected.last_contact_at)}</strong></div><div><span>Agent 运行</span><strong>{selected.run_count} 次</strong></div></div></div>
              <div className="panel memory-panel"><div className="panel-head"><div><h3>跨会话客户记忆</h3><p>每条偏好都保留来源与确认状态</p></div><div className="evidence-tag"><BrainCircuit size={14} /> Memory</div></div>{customerDetail?.memories.length ? customerDetail.memories.map((memory) => <div className="memory-item" key={memory.id}><div className={`memory-symbol ${memory.status === "confirmed" ? "verified" : "candidate"}`}>{memory.status === "confirmed" ? <Check size={16} /> : <Clock3 size={16} />}</div><div><strong>{memory.content}</strong><small>{memory.status === "confirmed" ? "人工已确认" : "候选记忆 · 不用于权威报价"} · 置信度 {(memory.confidence * 100).toFixed(0)}% · {memory.source_message_id ? "来自会话" : "人工录入"}</small></div>{memory.status === "candidate" && <button className="mini-action" onClick={() => confirmMemory(memory.id)}>确认</button>}</div>) : <Empty icon={<BrainCircuit size={23} />} title="暂无客户记忆" text="可以添加一条待确认的客户偏好。" />}
                <form className="memory-form" onSubmit={submitMemory}><input placeholder="添加一条候选偏好，例如：偏好英文包装..." value={memoryText} onChange={(event) => setMemoryText(event.target.value)} /><button disabled={busy || memoryText.trim().length < 5}><Plus size={17} /> 添加</button></form></div></>}
            </div></div>
        </>}

        {page === "workspace" && <>
          <SectionHeader eyebrow="AI COLLABORATION" title="智能会话" subtitle="把客户询价转化为有证据、有边界、可审批的业务动作。" action={<div className="header-chip"><span className="online-dot" />{boot.capabilities.model === "connected" ? "模型解析已连接" : "规则演示模式"}</div>} />
          <div className="workspace-grid"><div className="panel workspace-customers"><div className="panel-head"><div><h3>客户会话</h3><p>{boot.customers.length} 个客户</p></div><MoreHorizontal size={18} /></div>{boot.customers.map((customer) => <button key={customer.id} className={`conversation-customer ${selectedCustomer === customer.id ? "active" : ""}`} onClick={() => { setSelectedCustomer(customer.id); setSelectedRun(null); }}><div className="customer-avatar">{customer.name.slice(0, 2).toUpperCase()}</div><div><strong>{customer.name}</strong><small>{customer.country} · {customer.status}</small></div>{selectedCustomer === customer.id && <span className="conversation-ping" />}</button>)}<div className="workspace-hint"><Sparkles size={17} /><p>选择客户并发送询价，Agent 将自动读取 CRM、记忆与政策。</p></div></div>
            <div className="panel chat-panel"><div className="chat-header"><div className="customer-avatar large">{selected?.name.slice(0, 2).toUpperCase()}</div><div><strong>{selected?.name}</strong><small><span className="online-dot" />{boot.capabilities.environment === "production" ? "人工录入客户询价" : "Web 演示渠道"} · {selected?.country}</small></div><button className="top-icon" onClick={() => navigate("customers", selectedCustomer)} title="客户档案"><Users size={18} /></button></div><div className="chat-body" ref={chatBodyRef}><div className="chat-date">客户会话与 Agent 分析记录</div>{conversationItems.length ? conversationItems.map((item) => item.kind === "message" ? <div className={`chat-message ${item.message.direction === "outbound" ? "outbound" : "inbound"}`} key={`message-${item.id}`}><div className="message-bubble">{item.message.body}</div><small>{formatDate(item.message.created_at)}</small></div> : <div className="chat-message agent-result" key={`run-${item.id}`}><div className="agent-result-bubble"><div className="agent-result-head"><span><Bot size={15} /> Agent 分析</span><Status value={item.run.status} /></div><p>{item.run.summary ?? "Agent 正在领取任务并分析询价..."}</p><div className="agent-result-note">内部分析结果 · 尚未作为客户消息发送</div><div className="agent-result-actions">{item.run.status === "awaiting_approval" && item.run.quote_id && <button onClick={() => navigate("quotes")}>前往报价审批 <ArrowRight size={13} /></button>}<button onClick={() => navigate("runs", selectedCustomer, item.run.id)}>查看运行详情 <ArrowRight size={13} /></button></div></div><small>{formatDate(item.run.updated_at)}</small></div>) : <Empty icon={<MessageCircle size={24} />} title="开始一段会话" text="录入一条客户询价，观察 Agent 的执行过程。" />}</div><div className="chat-composer">{boot.capabilities.environment !== "production" && <div className="suggestion-row"><button onClick={() => setInquiry("Need 5,000 units of AX-200 with 20% discount, FOB Los Angeles.")}>试用：高折扣询价</button><button onClick={() => setInquiry("Please quote 1,500 units of AX-200, FOB Shanghai.")}>试用：普通报价</button></div>}<form onSubmit={submitInquiry}><textarea placeholder="输入客户询价，包含 SKU、数量和贸易条款..." value={inquiry} onChange={(event) => setInquiry(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send-button" disabled={busy || !selectedCustomer || !inquiry.trim()} title="提交询价"><Send size={18} /></button></form><small>Enter 提交 · Shift + Enter 换行 · 正式报价必须人工审批</small></div></div>
            <div className="workspace-side"><div className="panel agent-progress"><div className="panel-head"><div><h3>Agent 执行轨迹</h3><p>工具调用与业务状态可追溯</p></div><div className="agent-spark"><Sparkles size={17} /></div></div>{(selectedRun || latestCustomerRun) ? <><div className="progress-summary"><Status value={displayRun?.run.status ?? latestCustomerRun?.status ?? "queued"} /><p>{displayRun?.run.summary ?? latestCustomerRun?.summary ?? "Agent 正在领取任务..."}</p></div><div className="timeline">{(displayRun?.events ?? []).map((item) => <div className="timeline-item" key={item.id}><span className="timeline-node" /><div><strong>{stageName(item.stage)}</strong><p>{item.detail}</p><small>{formatDate(item.created_at)}</small></div></div>)}</div><button className="trace-link" onClick={() => navigate("runs", selectedCustomer, selectedRun ?? latestCustomerRun?.id)}>查看完整工具调用 <ArrowRight size={15} /></button></> : <Empty icon={<Activity size={23} />} title="等待新任务" text="发送询价后，这里会展示每一步执行记录。" />}</div>
              <div className="panel evidence-panel"><div className="panel-head"><div><h3>客户上下文</h3><p>不同来源分层使用</p></div><BookOpen size={18} /></div><div className="source-row"><div className="source-icon sql"><Database size={16} /></div><div><strong>CRM 权威事实</strong><small>{selected?.tier} 级客户 · {selected?.country}</small></div><Check size={15} /></div><div className="source-row"><div className="source-icon memory"><BrainCircuit size={16} /></div><div><strong>客户偏好记忆</strong><small>{customerDetail?.memories.filter((item) => item.status === "confirmed").length ?? 0} 条已确认</small></div><Check size={15} /></div><div className="source-row"><div className="source-icon knowledge"><BookOpen size={16} /></div><div><strong>企业知识与政策</strong><small>政策 {boot.policy?.version ?? "未知"}</small></div><Check size={15} /></div></div></div></div>
        </>}

        {page === "quotes" && <>
          <SectionHeader eyebrow="QUOTE GOVERNANCE" title="报价与审批" subtitle="所有正式报价都由人确认，价格和依据始终保持可追溯。" action={<div className="header-chip"><LockKeyhole size={16} /> 高风险动作受控</div>} />
          <div className="quote-banner"><div className="quote-banner-icon"><ShieldCheck size={22} /></div><div><strong>审批是执行边界，不是模型提示词</strong><p>{boot.capabilities.environment === "production" ? "审批后由销售从现有客户渠道人工发送，并在此登记交付；飞书仅作内部提醒。" : "销售可以创建草稿；经理或财务审批后，Worker 才能发送 Web 演示报价。"}</p></div><span>POLICY {boot.policy?.version ?? "未配置"}</span></div>
          <div className="panel quote-list">
            <div className="panel-head"><div><h3>报价记录</h3><p>共 {boot.quotes.length} 笔报价 · {pending.length} 笔待审批</p></div><span className="count-pill">{boot.quotes.length} TOTAL</span></div>
            {boot.quotes.length ? <div className="table-scroll"><table>
              <thead><tr><th>客户 / 产品</th><th>数量</th><th>单价</th><th>总金额</th><th>折扣 / 毛利</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{boot.quotes.map((quote) => <tr key={quote.id}>
                <td><div className="table-primary">{quote.customer_name}</div><div className="table-secondary">{quote.sku} · {quote.product_name}</div><div className="table-secondary">{quote.trade_term && quote.named_place ? `${quote.trade_term} ${quote.named_place}` : "历史报价 · 条款未留存"}{quote.valid_until ? ` · 有效至 ${quote.valid_until.slice(0, 10)}` : ""}</div>{quote.delivery_reference && <div className="table-secondary">人工交付：{quote.delivery_channel} · {quote.delivery_reference}</div>}{quote.customer_decision && <div className="table-secondary">客户结果：{quote.customer_decision === "accepted" ? "已接受并转订单" : "已拒绝"} · {quote.customer_response_reference}</div>}</td>
                <td>{quote.quantity.toLocaleString()} 件</td>
                <td>{formatMoney(quote.unit_price_cents)}</td>
                <td><strong className="amount">{formatMoney(quote.total_cents)}</strong></td>
                <td><div className="table-primary">{(quote.discount_bps / 100).toFixed(0)}% 折扣</div><div className="table-secondary">{quote.margin_bps == null ? "毛利仅审批人员可见" : `${(quote.margin_bps / 100).toFixed(1)}% 毛利`}</div></td>
                <td><Status value={quote.status} /></td>
                <td>{canApprove(quote) ? <div className="row-actions"><button className="action-approve" onClick={() => setApprovalModal({ quote, decision: "approved" })}>审批</button><button className="action-reject" onClick={() => setApprovalModal({ quote, decision: "rejected" })}>驳回</button></div> : boot.capabilities.environment === "production" && quote.status === "approved" && ["sales", "manager", "admin"].includes(user.role) ? <button className="action-approve" onClick={() => setDeliveryModal(quote)}>登记人工交付</button> : !quote.customer_decision && ["sent", "manual_delivery_recorded"].includes(quote.status) && ["sales", "manager", "admin"].includes(user.role) ? <button className="action-approve" onClick={() => { setResponseModal(quote); setCustomerDecision("accepted"); }}>登记客户结果</button> : <button className="icon-button table-open" onClick={() => navigate("runs", quote.customer_id, quote.run_id)}><ArrowUpRight size={18} /></button>}</td>
              </tr>)}</tbody>
            </table></div> : <Empty icon={<FileCheck2 size={25} />} title="还没有报价" text="在智能会话中发送一条包含 SKU、数量和贸易术语的询价。" />}
          </div>
          {pending.length > 0 && <div className="approval-notes">{pending.map((quote) => <div className="panel approval-note" key={quote.id}><div className="note-title"><div className="note-icon"><CircleAlert size={18} /></div><div><strong>{quote.customer_name} · 审批依据</strong><small>需{quote.required_role === "finance" ? "财务" : "经理"}审批 · 政策版本 {quote.policy_version}</small></div></div><p>{quote.approval_reason}</p><div className="citation-chips">{JSON.parse(quote.evidence_json || "[]").slice(0, 4).map((evidence: string) => <span key={evidence}>{evidence}</span>)}</div></div>)}</div>}
        </>}

        {page === "orders" && <>
          <SectionHeader eyebrow="ORDER FULFILLMENT" title="订单与履约" subtitle="客户接受获批报价后生成订单快照，持续跟踪生产、交期风险与出货凭据。" action={<div className="header-chip"><Package size={16} /> 报价到履约闭环</div>} />
          <div className="quote-banner"><div className="quote-banner-icon"><Package size={22} /></div><div><strong>订单只从客户已接受的正式报价生成</strong><p>价格、数量和贸易条款固化为订单快照；状态变更采用版本校验并写入审计日志。</p></div><span>{boot.metrics.atRiskOrders} RISK</span></div>
          <div className="panel quote-list"><div className="panel-head"><div><h3>履约订单</h3><p>{boot.orders.length} 笔订单 · {boot.metrics.activeOrders} 笔进行中</p></div><span className="count-pill">{formatMoney(boot.metrics.orderVolumeCents)} VALUE</span></div>
            {boot.orders.length ? <div className="table-scroll"><table><thead><tr><th>客户 / 产品</th><th>订单金额</th><th>贸易条款</th><th>预计出货</th><th>状态</th><th>凭据 / 风险</th><th>操作</th></tr></thead><tbody>{boot.orders.map((order) => <tr key={order.id}>
              <td><div className="table-primary">{order.customer_name}</div><div className="table-secondary">{order.sku} · {order.product_name} · {order.quantity.toLocaleString()} 件</div><div className="table-secondary">订单 {order.id.slice(0, 8).toUpperCase()} · v{order.version}</div></td>
              <td><strong className="amount">{formatMoney(order.total_cents, order.currency)}</strong><div className="table-secondary">{formatMoney(order.unit_price_cents, order.currency)} / 件</div></td>
              <td>{order.trade_term} {order.named_place}</td><td>{order.expected_ship_date.slice(0, 10)}</td><td><Status value={order.status} /></td>
              <td>{order.tracking_reference ? <><div className="table-primary">{order.tracking_reference}</div><div className="table-secondary">物流／提单编号</div></> : order.risk_note ? <div className="table-secondary">{order.risk_note}</div> : <span className="table-secondary">暂无异常</span>}</td>
              <td>{orderTransitions(order, user.role).length ? <button className="action-approve" onClick={() => openOrderUpdate(order)}>更新履约</button> : <span className="table-secondary">流程已结束</span>}</td>
            </tr>)}</tbody></table></div> : <Empty icon={<Package size={25} />} title="还没有订单" text="先完成报价交付，再在报价页登记客户接受结果。" />}
          </div>
        </>}

        {page === "runs" && <>
          <SectionHeader eyebrow="AGENT OPERATIONS" title="Agent 运行" subtitle="每次模型解析、工具调用与人工决策都留下完整轨迹。" action={displayRun && ["needs_manual_review", "failed"].includes(displayRun.run.status) && ["sales", "manager", "admin"].includes(user.role) ? <button className="button secondary" disabled={busy} onClick={retrySelectedRun}><Activity size={16} /> 重新分析</button> : <div className="header-chip"><Activity size={16} /> 实时刷新</div>} />
          <div className="runs-layout"><div className="panel runs-list"><div className="panel-head"><div><h3>运行记录</h3><p>{boot.runs.length} 次 Agent 任务</p></div><MoreHorizontal size={18} /></div>{boot.runs.length ? boot.runs.map((item) => <button className={`run-list-item ${selectedRun === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedRun(item.id)}><div className="run-icon"><Bot size={19} /></div><div><strong>{item.customer_name}</strong><small>{formatDate(item.created_at)} · {item.mode === "model" ? "LLM" : item.mode === "manual" ? "人工复核" : "Demo"}</small></div><Status value={item.status} /></button>) : <Empty icon={<Activity size={24} />} title="尚无运行记录" text="先在智能会话中发起询价。" />}</div><div className="panel run-detail"><div className="panel-head"><div><h3>执行详情</h3><p>按时间查看事件与受控工具</p></div>{displayRun && <Status value={displayRun.run.status} />}</div>{displayRun ? <><div className="run-summary"><div><span>RUN ID</span><strong>{displayRun.run.id.slice(0, 8).toUpperCase()}</strong></div><div><span>执行模式</span><strong>{displayRun.run.mode === "model" ? "模型解析" : displayRun.run.mode === "manual" ? "人工复核" : "本地演示解析"}</strong></div><div><span>当前状态</span><strong>{statusLabel[displayRun.run.status] ?? displayRun.run.status}</strong></div></div><p className="detail-summary">{displayRun.run.summary}</p><div className="detail-subhead">状态事件 <span>{displayRun.events.length}</span></div><div className="timeline detailed">{displayRun.events.map((item) => <div className="timeline-item" key={item.id}><span className="timeline-node" /><div><strong>{stageName(item.stage)}</strong><p>{item.detail}</p><small>{formatDate(item.created_at)}</small></div></div>)}</div><div className="detail-subhead">工具调用 <span>{displayRun.tools.length}</span></div><div className="tool-list">{displayRun.tools.map((tool) => <div className="tool-item" key={tool.id}><div className="tool-icon"><Command size={15} /></div><div><strong>{tool.tool_name}</strong><small>{formatDate(tool.created_at)} · {tool.risk_level}</small></div><span className={tool.status === "success" ? "tool-ok" : "tool-fail"}>{tool.status}</span></div>)}</div></> : <Empty icon={<Bot size={24} />} title="选择一条运行记录" text="查看它如何获取证据、计算报价和等待人工审批。" />}</div></div>
        </>}

        {page === "evaluation" && <>
          <SectionHeader eyebrow="QUALITY ENGINEERING" title="质量评测" subtitle="用固定用例验证金额、权限、隔离和知识有效性。" action={<button className="button primary" disabled={busy || !["manager", "finance", "admin"].includes(user.role)} onClick={executeEvaluation}><Activity size={17} /> 运行回归评测</button>} />
          <div className="eval-layout"><div className="eval-main"><div className="panel eval-hero"><div className="eval-circle"><ShieldCheck size={29} /></div><div><div className="eyebrow">GOLDEN CORPUS</div><h2>把“看起来正确”变成可验证的结果。</h2><p>固定的案例覆盖询价抽取、报价金额、起订量、权限升级、跨租户隔离和记忆治理。</p></div></div><div className="panel"><div className="panel-head"><div><h3>最新评测结果</h3><p>规则与业务边界的确定性断言</p></div>{evaluation && <span className="score-badge">{evaluation.passed} / {evaluation.total} 通过</span>}</div>{evaluation ? <div className="case-list">{evaluation.cases.map((item) => <div className="case-row" key={item.id}><div className={`case-icon ${item.passed ? "pass" : "fail"}`}>{item.passed ? <Check size={17} /> : <X size={17} />}</div><div><strong>{item.title}</strong><small>{item.detail}</small></div><span>{item.passed ? "PASS" : "FAIL"}</span></div>)}</div> : boot.evaluations.length ? <div className="historical-eval"><div className="eval-score">{boot.evaluations[0].passed}<span>/{boot.evaluations[0].total}</span></div><div><strong>最近一次评测</strong><p>{formatDate(boot.evaluations[0].created_at)} · 点击“运行回归评测”查看逐项结果</p></div></div> : <Empty icon={<ShieldCheck size={24} />} title="尚未运行评测" text="使用经理或财务角色运行首轮 Golden Corpus。" />}</div></div><div className="eval-side"><div className="panel"><div className="panel-head"><div><h3>能力连接状态</h3><p>演示模式与真实服务清晰区分</p></div><Settings2 size={17} /></div><Capability icon={<BrainCircuit size={17} />} title="模型解析" state={boot.capabilities.model === "connected" ? "已连接" : "本地规则演示"} connected={boot.capabilities.model === "connected"} /><Capability icon={<BookOpen size={17} />} title="知识检索" state={boot.capabilities.knowledge === "weknora+local" ? "WeKnora + 本地" : "本地知识库"} connected={boot.capabilities.knowledge === "weknora+local"} /><Capability icon={<Globe2 size={17} />} title="客户消息" state={boot.capabilities.environment === "production" ? "人工录入" : "Web 演示渠道"} connected={boot.capabilities.environment === "production"} /><Capability icon={<Database size={17} />} title="任务与审计" state="单机持久化" connected /></div><div className="panel eval-policy"><div className="eyebrow">ACTIVE POLICY</div><h3>{boot.policy?.title}</h3><p>销售自行折扣上限 {(boot.policy?.max_sales_discount_bps ?? 0) / 100}% · 毛利率低于 {(boot.policy?.min_margin_bps ?? 0) / 100}% 需财务复核</p><span>版本 {boot.policy?.version}</span></div></div></div>
        </>}

        {page === "audit" && <>
          <SectionHeader eyebrow="AUDIT TRAIL" title="审计日志" subtitle="谁在什么时间做了什么，重要业务动作都有据可查。" action={<div className="header-chip"><LockKeyhole size={16} /> 只读审计记录</div>} />
          <div className="panel audit-panel"><div className="panel-head"><div><h3>最近操作</h3><p>包含消息、报价、审批、记忆和评测事件</p></div><span className="count-pill">{boot.auditEvents.length} EVENTS</span></div>{boot.auditEvents.length ? <div className="audit-list">{boot.auditEvents.map((item) => <div className="audit-row" key={item.id}><div className="audit-icon"><FileText size={17} /></div><div><strong>{auditTitle(item.action)}</strong><small>{item.detail}</small></div><span>{formatDate(item.created_at)}</span></div>)}</div> : <Empty icon={<FileText size={24} />} title="尚无审计记录" text="业务动作执行后会自动留下审计事件。" />}</div>
        </>}
        {page === "setup" && ["admin", "manager"].includes(user.role) && <AdminSetup boot={boot} onSaved={() => refresh(true)} />}
        {page === "account" && <AccountSecurity user={user} />}
      </main>
    </div>
    {toast && <div className="toast" role="status"><CircleAlert size={17} />{toast}<button aria-label="关闭提示" onClick={() => setToast("")}><X size={15} /></button></div>}
    {approvalModal && <div className="modal-backdrop" onMouseDown={() => setApprovalModal(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" aria-label="关闭审批弹窗" onClick={() => setApprovalModal(null)}><X size={19} /></button>
        <div className={`modal-icon ${approvalModal.decision}`}><ShieldCheck size={23} /></div>
        <h2 id="approval-dialog-title">{approvalModal.decision === "approved" ? "确认批准报价？" : "确认驳回报价？"}</h2>
        <p>{approvalModal.quote.customer_name} · {approvalModal.quote.sku} · {formatMoney(approvalModal.quote.total_cents)}</p>
        <div className="modal-facts">
          <span>折扣 <strong>{approvalModal.quote.discount_bps / 100}%</strong></span>
          <span>毛利 <strong>{approvalModal.quote.margin_bps == null ? "不可见" : `${(approvalModal.quote.margin_bps / 100).toFixed(1)}%`}</strong></span>
          <span>政策 <strong>{approvalModal.quote.policy_version}</strong></span>
          <span>贸易条款 <strong>{approvalModal.quote.trade_term && approvalModal.quote.named_place ? `${approvalModal.quote.trade_term} ${approvalModal.quote.named_place}` : "未留存"}</strong></span>
          <span>有效期 <strong>{approvalModal.quote.valid_until?.slice(0, 10) ?? "未留存"}</strong></span>
        </div>
        <label htmlFor="approval-note">审批备注</label>
        <textarea id="approval-note" placeholder="请说明审批原因，方便后续审计" value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} />
        <div className="modal-actions"><button className="button secondary" onClick={() => setApprovalModal(null)}>取消</button><button className={`button ${approvalModal.decision === "approved" ? "primary" : "danger"}`} disabled={busy} onClick={submitApproval}>{busy ? "处理中..." : approvalModal.decision === "approved" ? "批准并发送" : "确认驳回"}</button></div>
      </div>
    </div>}
    {deliveryModal && <div className="modal-backdrop" onMouseDown={() => setDeliveryModal(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delivery-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" aria-label="关闭登记弹窗" onClick={() => setDeliveryModal(null)}><X size={19} /></button>
        <div className="modal-icon approved"><FileCheck2 size={23} /></div>
        <h2 id="delivery-dialog-title">登记人工交付</h2>
        <p>{deliveryModal.customer_name} · {deliveryModal.sku} · {formatMoney(deliveryModal.total_cents, deliveryModal.currency)}</p>
        <p>请先从现有客户渠道实际发送经批准的报价，再填写外部凭据。此登记不能证明客户已收到。</p>
        <label htmlFor="delivery-channel">发送渠道</label>
        <select id="delivery-channel" value={deliveryChannel} onChange={(event) => setDeliveryChannel(event.target.value)}><option value="email">电子邮件</option><option value="whatsapp">WhatsApp</option><option value="other">其他渠道</option></select>
        <label htmlFor="delivery-reference">外部消息／邮件编号</label>
        <input id="delivery-reference" minLength={4} maxLength={200} value={deliveryReference} onChange={(event) => setDeliveryReference(event.target.value)} placeholder="例如邮件 Message-ID" />
        <label htmlFor="delivery-note">交付说明</label>
        <textarea id="delivery-note" minLength={10} maxLength={500} value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} placeholder="记录收件人、发送时间和实际发送内容的核对结果" />
        <div className="modal-actions"><button className="button secondary" onClick={() => setDeliveryModal(null)}>取消</button><button className="button primary" disabled={busy || deliveryReference.trim().length < 4 || deliveryNote.trim().length < 10} onClick={submitManualDelivery}>确认已人工发送</button></div>
      </div>
    </div>}
    {responseModal && <div className="modal-backdrop" onMouseDown={() => setResponseModal(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="response-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" aria-label="关闭客户结果弹窗" onClick={() => setResponseModal(null)}><X size={19} /></button>
        <div className="modal-icon approved"><MessageCircle size={23} /></div><h2 id="response-dialog-title">登记客户反馈</h2>
        <p>{responseModal.customer_name} · {responseModal.sku} · {formatMoney(responseModal.total_cents, responseModal.currency)}</p>
        <p>仅记录已经从外部渠道获得的明确反馈。选择“接受”会按当前报价快照生成订单。</p>
        <label htmlFor="customer-decision">客户决定</label><select id="customer-decision" value={customerDecision} onChange={(event) => setCustomerDecision(event.target.value as "accepted" | "rejected")}><option value="accepted">接受报价并下单</option><option value="rejected">拒绝报价</option></select>
        <label htmlFor="response-channel">反馈渠道</label><select id="response-channel" value={responseChannel} onChange={(event) => setResponseChannel(event.target.value)}><option value="email">电子邮件</option><option value="whatsapp">WhatsApp</option><option value="other">其他渠道</option></select>
        <label htmlFor="response-reference">外部回复凭据</label><input id="response-reference" minLength={4} maxLength={200} value={responseReference} onChange={(event) => setResponseReference(event.target.value)} placeholder="邮件 Message-ID、WhatsApp 消息 ID 等" />
        <label htmlFor="response-note">反馈说明</label><textarea id="response-note" minLength={10} maxLength={500} value={responseNote} onChange={(event) => setResponseNote(event.target.value)} placeholder="记录客户原意、回复时间及核对情况" />
        <div className="modal-actions"><button className="button secondary" onClick={() => setResponseModal(null)}>取消</button><button className="button primary" disabled={busy || responseReference.trim().length < 4 || responseNote.trim().length < 10} onClick={submitCustomerResponse}>{customerDecision === "accepted" ? "确认并生成订单" : "确认客户拒绝"}</button></div>
      </div>
    </div>}
    {orderModal && <div className="modal-backdrop" onMouseDown={() => setOrderModal(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="order-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" aria-label="关闭订单更新弹窗" onClick={() => setOrderModal(null)}><X size={19} /></button>
        <div className="modal-icon approved"><Package size={23} /></div><h2 id="order-dialog-title">更新订单履约</h2>
        <p>{orderModal.customer_name} · {orderModal.sku} · 当前状态：{statusLabel[orderModal.status]}</p>
        <label htmlFor="order-target">目标状态</label><select id="order-target" value={orderTarget} onChange={(event) => setOrderTarget(event.target.value as SalesOrder["status"])}>{orderTransitions(orderModal, user.role).map((status) => <option value={status} key={status}>{statusLabel[status]}</option>)}</select>
        {orderTarget === "shipped" && <><label htmlFor="tracking-reference">物流／提单编号</label><input id="tracking-reference" minLength={4} maxLength={200} value={trackingReference} onChange={(event) => setTrackingReference(event.target.value)} placeholder="例如 B/L No. 或承运商追踪号" /></>}
        <label htmlFor="order-note">操作说明</label><textarea id="order-note" minLength={orderTarget === "at_risk" ? 10 : 3} maxLength={500} value={orderNote} onChange={(event) => setOrderNote(event.target.value)} placeholder={orderTarget === "at_risk" ? "说明风险原因、影响和处理计划（至少 10 字）" : "记录状态变更依据"} />
        <div className="modal-actions"><button className="button secondary" onClick={() => setOrderModal(null)}>取消</button><button className={`button ${orderTarget === "cancelled" ? "danger" : "primary"}`} disabled={busy || orderNote.trim().length < (orderTarget === "at_risk" ? 10 : 3) || (orderTarget === "shipped" && trackingReference.trim().length < 4)} onClick={submitOrderUpdate}>确认更新</button></div>
      </div>
    </div>}
  </div>;
}

function orderTransitions(order: SalesOrder, role: User["role"]): SalesOrder["status"][] {
  const normal: Record<SalesOrder["status"], SalesOrder["status"][]> = {
    confirmed: ["production", "at_risk"], production: ["at_risk", "ready_to_ship"],
    at_risk: ["production", "ready_to_ship"], ready_to_ship: ["at_risk", "shipped"],
    shipped: ["completed"], completed: [], cancelled: []
  };
  return ["manager", "admin"].includes(role) && !["shipped", "completed", "cancelled"].includes(order.status)
    ? [...normal[order.status], "cancelled"] : normal[order.status];
}

function Metric({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-label">{label}</div><strong>{value}</strong><div className="metric-detail"><ArrowUpRight size={14} />{detail}</div></div>;
}

function CustomerTable({ customers, onSelect }: { customers: Customer[]; onSelect: (id: string) => void }) {
  return <div className="table-scroll"><table><thead><tr><th>客户</th><th>市场 / 行业</th><th>等级</th><th>状态</th><th>最近互动</th><th /></tr></thead><tbody>{customers.map((customer) => <tr key={customer.id} className="clickable-row"><td><button type="button" className="table-customer-link" onClick={() => onSelect(customer.id)}><span className="table-customer"><span className="customer-avatar small">{customer.name.slice(0, 2).toUpperCase()}</span><span><strong>{customer.name}</strong><small>负责人 {customer.owner_name}</small></span></span></button></td><td>{customer.country} · {customer.industry}</td><td><span className="tier-badge">{customer.tier} 级</span></td><td><span className="customer-status"><span className="online-dot" />{customer.status}</span></td><td>{formatDate(customer.last_contact_at)}</td><td><ArrowUpRight size={17} aria-hidden="true" /></td></tr>)}</tbody></table></div>;
}

function Capability({ icon, title, state, connected }: { icon: ReactNode; title: string; state: string; connected: boolean }) {
  return <div className="capability-row"><div className="capability-icon">{icon}</div><div><strong>{title}</strong><small>{state}</small></div><span className={connected ? "capability-connected" : "capability-demo"}>{connected ? "ACTIVE" : "DEMO"}</span></div>;
}

function stageName(stage: string) {
  const names: Record<string, string> = { received: "接收消息", context: "组装上下文", extract: "提取询价", model_fallback: "模型降级", manual_review: "人工复核", manual_retry: "人工重试", manual_delivery: "待人工交付", manual_delivery_recorded: "人工交付已登记", evidence: "证据核验", pricing: "报价计算", approval: "人工审批", human_decision: "人工决策", delivered: "报价交付", validation: "业务校验", clarification: "补充信息", conflict: "证据冲突", policy_block: "规则拦截", invalidated: "报价失效", retry: "任务重试", failed: "任务失败" };
  return names[stage] ?? stage;
}

function auditTitle(action: string) {
  const names: Record<string, string> = { "message.received": "收到客户询价", "quote.draft_created": "创建报价草稿", "quote.approval_requested": "发起报价审批", "approval.approved": "审批通过", "approval.rejected": "审批驳回", "quote.sent": "正式报价已发送", "memory.candidate_added": "新增候选记忆", "memory.candidate_extracted": "提取候选偏好", "memory.confirmed": "确认客户记忆", "memory.mem0_sync_failed": "外部记忆同步失败", "evaluation.run": "运行回归评测" };
  return names[action] ?? action;
}
