import { randomBytes } from "node:crypto";
import { isProduction } from "./config.js";
import { id, initDatabase, one, passwordHash, run, transaction } from "./db.js";

if (!isProduction()) throw new Error("仅生产模式允许初始化正式管理员");
const email = process.env.CRM_BOOTSTRAP_EMAIL?.trim().toLowerCase();
const password = process.env.CRM_BOOTSTRAP_PASSWORD;
const organization = process.env.CRM_BOOTSTRAP_ORGANIZATION?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 16 || !organization) {
  throw new Error("请设置 CRM_BOOTSTRAP_EMAIL、至少 16 位的 CRM_BOOTSTRAP_PASSWORD 和 CRM_BOOTSTRAP_ORGANIZATION");
}
initDatabase();
transaction(() => {
  if (one("SELECT id FROM users LIMIT 1")) throw new Error("数据库已有用户，拒绝重复初始化管理员");
  const organizationId = id();
  const userId = id();
  const salt = randomBytes(16).toString("hex");
  run("INSERT INTO organizations(id,name) VALUES(?,?)", organizationId, organization);
  run("INSERT INTO users(id,organization_id,name,email,role,password_salt,password_hash) VALUES(?,?,?,?,?,?,?)",
    userId, organizationId, "系统管理员", email, "admin", salt, passwordHash(password, salt));
});
console.log(`正式管理员 ${email} 已创建。请立即清除一次性初始化环境变量。`);
