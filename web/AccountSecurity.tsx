import { useState, type FormEvent } from "react";
import { api, type User } from "./api";

export default function AccountSecurity({ user }: { user: User }) {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    if (newPassword !== confirmation) { setNotice("两次输入的新密码不一致"); return; }
    setBusy(true); setNotice("");
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      form.reset(); setNotice("密码已更新，其他会话已撤销");
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }
  return <section className="admin-setup"><div className="section-heading"><div><div className="eyebrow">ACCOUNT SECURITY</div><h1>账户安全</h1><p>{user.email} · 仅使用自己的账号操作报价与审批。</p></div></div>
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    <form className="panel admin-form account-form" onSubmit={(event) => void changePassword(event)}>
      <h3>修改密码</h3><p>新密码至少 16 位。修改后其他设备的登录会话立即失效。</p>
      <label>当前密码<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
      <label>新密码<input name="newPassword" type="password" required minLength={16} maxLength={128} autoComplete="new-password" /></label>
      <label>重复新密码<input name="confirmation" type="password" required minLength={16} maxLength={128} autoComplete="new-password" /></label>
      <button className="button primary" disabled={busy}>更新密码</button>
    </form>
  </section>;
}
