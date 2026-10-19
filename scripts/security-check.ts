export {};

const base = (process.env.SECURITY_BASE_URL ?? "").replace(/\/$/, "");
const email = process.env.SECURITY_TEST_EMAIL ?? "";
const password = process.env.SECURITY_TEST_PASSWORD ?? "";
if (!base.startsWith("https://") || !email || !password) throw new Error("设置 HTTPS SECURITY_BASE_URL、SECURITY_TEST_EMAIL 和 SECURITY_TEST_PASSWORD");

const health = await fetch(`${base}/api/health`);
if (!health.ok) throw new Error(`health 返回 ${health.status}`);
const requiredHeaders: Record<string, RegExp> = {
  "strict-transport-security": /max-age=/i,
  "content-security-policy": /default-src 'self'/i,
  "x-content-type-options": /nosniff/i,
  "x-frame-options": /DENY/i
};
for (const [name, pattern] of Object.entries(requiredHeaders)) {
  if (!pattern.test(health.headers.get(name) ?? "")) throw new Error(`缺少或错误的安全响应头：${name}`);
}
const internal = await fetch(`${base}/internal/metrics`);
if (internal.status !== 404) throw new Error(`公网内部指标路径应返回 404，实际为 ${internal.status}`);
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`专用安全测试账号登录失败：${login.status}`);
const cookie = login.headers.get("set-cookie") ?? "";
for (const expected of ["HttpOnly", "Secure", "SameSite=Lax"]) if (!cookie.includes(expected)) throw new Error(`会话 Cookie 缺少 ${expected}`);
const csrfProbe = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie.split(";")[0] } });
if (csrfProbe.status !== 403) throw new Error(`无 CSRF Token 的写请求应返回 403，实际为 ${csrfProbe.status}`);
console.log(JSON.stringify({ ok: true, base, headers: Object.keys(requiredHeaders), internalPathHidden: true, secureCookie: true, csrfBlocked: true }, null, 2));
