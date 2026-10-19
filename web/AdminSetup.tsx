import { useEffect, useState, type FormEvent } from "react";
import { api, type Bootstrap } from "./api";

type TeamUser = { id: string; name: string; email: string; role: string; is_active: number };
type Notification = { id: string; kind: string; target_id: string; status: string; attempt: number; last_error: string | null; created_at: string };

export default function AdminSetup({ boot, onSaved }: { boot: Bootstrap; onSaved: () => Promise<void> }) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [resolutionNote, setResolutionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const admin = boot.user.role === "admin";

  async function loadUsers() {
    try { setUsers(await api<TeamUser[]>("/api/admin/users")); }
    catch (error) { setNotice(String(error)); }
  }
  async function loadNotifications() {
    try { setNotifications(await api<Notification[]>("/api/admin/notifications")); }
    catch (error) { setNotice(String(error)); }
  }
  useEffect(() => { void loadUsers(); void loadNotifications(); }, []);

  async function resolveNotification(item: Notification, action: "confirmed_sent" | "retry") {
    if (resolutionNote.trim().length < 10) { setNotice("请先填写至少 10 字的人工核对说明"); return; }
    setBusy(true); setNotice("");
    try {
      await api(`/api/admin/notifications/${item.id}/resolve`, { method: "POST", body: JSON.stringify({ action, note: resolutionNote }) });
      setResolutionNote(""); setNotice("飞书提醒状态已更新"); await loadNotifications();
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function disableUser(target: TeamUser) {
    setBusy(true); setNotice("");
    try {
      await api(`/api/admin/users/${target.id}/disable`, { method: "POST" });
      setNotice("账号已停用，现有会话已撤销");
      await Promise.all([loadUsers(), onSaved()]);
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function transferCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setNotice("");
    try {
      await api(`/api/customers/${data.get("customerId")}/owner`, { method: "PATCH", body: JSON.stringify({ ownerId: data.get("ownerId") }) });
      setNotice("客户负责人已更新"); await onSaved(); form.reset();
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>, path: string, transform: (data: FormData) => unknown, success: string) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setNotice("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(transform(new FormData(form))) });
      form.reset();
      setNotice(success);
      await Promise.all([loadUsers(), onSaved()]);
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  }

  return <section className="admin-setup">
    <div className="section-heading"><div><div className="eyebrow">TEAM CONFIGURATION</div><h1>团队与基础资料</h1><p>先建立人员、客户、产品和报价政策，再处理真实询价。新增政策会使旧政策停止生效。</p></div></div>
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    <div className="admin-grid">
      {admin && <form className="panel admin-form" onSubmit={(event) => void submit(event, "/api/admin/users", (data) => ({
        name: data.get("name"), email: data.get("email"), role: data.get("role"), password: data.get("password")
      }), "团队成员已创建")}>
        <h3>新增团队成员</h3><p>请使用独立账号；密码至少 16 位。</p>
        <label>姓名<input name="name" required minLength={2} maxLength={80} /></label>
        <label>邮箱<input name="email" type="email" required /></label>
        <label>角色<select name="role" required><option value="sales">销售</option><option value="manager">经理</option><option value="finance">财务</option><option value="auditor">审计</option><option value="admin">管理员</option></select></label>
        <label>初始密码<input name="password" type="password" required minLength={16} maxLength={128} autoComplete="new-password" /></label>
        <button className="button primary" disabled={busy}>创建成员</button>
      </form>}
      <form className="panel admin-form" onSubmit={(event) => void submit(event, "/api/customers", (data) => ({
        name: data.get("name"), country: data.get("country"), industry: data.get("industry"),
        tier: data.get("tier"), ownerId: data.get("ownerId"), description: data.get("description")
      }), "客户档案已创建")}>
        <h3>新增客户</h3><p>销售仅能查看自己负责的客户。</p>
        <label>客户名称<input name="name" required minLength={2} /></label>
        <div className="admin-form-row"><label>国家／地区<input name="country" required minLength={2} /></label><label>行业<input name="industry" required minLength={2} /></label></div>
        <div className="admin-form-row"><label>等级<select name="tier"><option>A</option><option>B</option><option>C</option></select></label>
          <label>负责人<select name="ownerId" required defaultValue=""><option value="" disabled>请选择</option>{users.filter((user) => user.is_active === 1 && ["sales", "manager", "admin"].includes(user.role)).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label></div>
        <label>备注<textarea name="description" maxLength={1000} /></label>
        <button className="button primary" disabled={busy || !users.length}>创建客户</button>
      </form>
      <form className="panel admin-form" onSubmit={(event) => void transferCustomer(event)}>
        <h3>移交客户负责人</h3><p>停用员工账号前，必须先移交其客户。</p>
        <label>客户<select name="customerId" required defaultValue=""><option value="" disabled>请选择客户</option>{boot.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · 当前 {customer.owner_name}</option>)}</select></label>
        <label>新负责人<select name="ownerId" required defaultValue=""><option value="" disabled>请选择新负责人</option>{users.filter((user) => user.is_active === 1 && ["sales", "manager", "admin"].includes(user.role)).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <button className="button primary" disabled={busy || !boot.customers.length}>移交客户</button>
      </form>
      <form className="panel admin-form" onSubmit={(event) => void submit(event, "/api/products", (data) => ({
        sku: data.get("sku"), name: data.get("name"), category: data.get("category"), currency: data.get("currency"),
        listPriceCents: Math.round(Number(data.get("listPrice")) * 100), costCents: Math.round(Number(data.get("cost")) * 100),
        moq: Number(data.get("moq")), leadDays: Number(data.get("leadDays")), description: data.get("description")
      }), "产品已创建")}>
        <h3>新增产品与价格</h3><p>成本只在管理接口和服务端使用，不向销售的产品列表返回。</p>
        <div className="admin-form-row"><label>SKU<input name="sku" required pattern="[A-Za-z0-9-]{2,30}" /></label><label>名称<input name="name" required minLength={2} /></label></div>
        <div className="admin-form-row"><label>品类<input name="category" required minLength={2} /></label><label>币种<input name="currency" defaultValue="USD" required maxLength={3} /></label></div>
        <div className="admin-form-row"><label>标价<input name="listPrice" type="number" required min="0.01" step="0.01" /></label><label>成本<input name="cost" type="number" required min="0" step="0.01" /></label></div>
        <div className="admin-form-row"><label>MOQ<input name="moq" type="number" required min="1" step="1" /></label><label>交期／天<input name="leadDays" type="number" required min="0" max="365" step="1" /></label></div>
        <label>产品说明<textarea name="description" maxLength={2000} /></label>
        <button className="button primary" disabled={busy}>创建产品</button>
      </form>
      {admin && <form className="panel admin-form" onSubmit={(event) => void submit(event, "/api/policies", (data) => ({
        title: data.get("title"), version: data.get("version"),
        maxSalesDiscountBps: Math.round(Number(data.get("maxSalesDiscount")) * 100),
        minMarginBps: Math.round(Number(data.get("minMargin")) * 100), body: data.get("body")
      }), "新报价政策已发布")}>
        <h3>发布报价政策</h3><p>修改政策会使未发送的旧报价失效，请先与财务核对。</p>
        <div className="admin-form-row"><label>标题<input name="title" required minLength={3} /></label><label>版本<input name="version" required /></label></div>
        <div className="admin-form-row"><label>销售折扣上限 %<input name="maxSalesDiscount" type="number" required min="0" max="99" step="0.01" /></label>
          <label>财务复核毛利率 %<input name="minMargin" type="number" required min="0" max="99" step="0.01" /></label></div>
        <label>政策正文<textarea name="body" required minLength={10} maxLength={4000} /></label>
        <button className="button primary" disabled={busy}>发布新政策</button>
      </form>}
      <form className="panel admin-form" onSubmit={(event) => void submit(event, "/api/knowledge", (data) => ({
        title: data.get("title"), version: data.get("version"), productSku: data.get("productSku") || null, body: data.get("body")
      }), "知识文档已发布")}>
        <h3>发布企业知识</h3><p>产品文档必须绑定 SKU；通用贸易政策可不绑定。请勿上传未经核实的客户资料。</p>
        <div className="admin-form-row"><label>文档标题<input name="title" required minLength={3} /></label><label>版本<input name="version" required /></label></div>
        <label>关联产品<select name="productSku" defaultValue=""><option value="">通用文档</option>{boot.products.map((product) => <option key={product.id} value={product.sku}>{product.sku} · {product.name}</option>)}</select></label>
        <label>正文<textarea name="body" required minLength={20} maxLength={20000} /></label>
        <button className="button primary" disabled={busy}>发布知识</button>
      </form>
    </div>
    <div className="panel admin-form admin-notification-panel">
      <h3>团队账号状态</h3>
      {users.map((member) => <div className="admin-notification-row" key={member.id}><div><strong>{member.name} · {member.role}</strong><small>{member.email} · {member.is_active ? "启用" : "已停用"}</small></div>
        {admin && member.is_active === 1 && member.id !== boot.user.id && <button type="button" className="button secondary" disabled={busy} onClick={() => void disableUser(member)}>停用账号</button>}
      </div>)}
    </div>
    <div className="panel admin-form admin-notification-panel">
      <h3>飞书内部提醒状态</h3><p>超时可能已由飞书接收；状态不确定时先核对群消息，再决定标记已发送或人工重试。</p>
      {admin && <label>人工核对说明<textarea value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} minLength={10} maxLength={500} placeholder="说明已检查的群消息和处理决定" /></label>}
      {notifications.length ? notifications.map((item) => <div className="admin-notification-row" key={item.id}>
        <div><strong>{item.kind}</strong><small>{item.target_id} · {item.status} · 尝试 {item.attempt} 次</small>{item.last_error && <small>{item.last_error}</small>}</div>
        {admin && ["uncertain", "failed"].includes(item.status) && <div className="admin-notification-actions"><button type="button" disabled={busy} onClick={() => void resolveNotification(item, "confirmed_sent")}>已核实送达</button><button type="button" disabled={busy} onClick={() => void resolveNotification(item, "retry")}>人工重试</button></div>}
      </div>) : <p>暂无飞书提醒记录。</p>}
    </div>
  </section>;
}
