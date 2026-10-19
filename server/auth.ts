import { now, one, run, transaction } from "./db.js";
import { isProduction } from "./config.js";

const WINDOW_MS = 15 * 60 * 1000;
const useIpLimit = () => !isProduction() || Boolean(process.env.CRM_TRUSTED_PROXY_CIDRS);

function currentCount(scope: string, identity: string) {
  const row = one<{ window_started_at: string; attempt_count: number }>(
    "SELECT window_started_at,attempt_count FROM login_attempts WHERE scope=? AND identity=?",
    scope, identity
  );
  if (!row || Date.now() - Date.parse(row.window_started_at) >= WINDOW_MS) return 0;
  return row.attempt_count;
}

export function assertLoginAllowed(email: string, ip: string) {
  if (currentCount("email", email) >= 5 || (useIpLimit() && currentCount("ip", ip) >= 20)) {
    throw Object.assign(new Error("登录尝试过多，请 15 分钟后重试"), { statusCode: 429 });
  }
}

export function recordFailedLogin(email: string, ip: string) {
  transaction(() => {
    for (const [scope, identity] of useIpLimit() ? [["email", email], ["ip", ip]] : [["email", email]]) {
      const count = currentCount(scope, identity);
      const stamp = now();
      if (count === 0) {
        run("INSERT INTO login_attempts(scope,identity,window_started_at,attempt_count) VALUES(?,?,?,1) ON CONFLICT(scope,identity) DO UPDATE SET window_started_at=excluded.window_started_at,attempt_count=1", scope, identity, stamp);
      } else {
        run("UPDATE login_attempts SET attempt_count=attempt_count+1 WHERE scope=? AND identity=?", scope, identity);
      }
    }
  });
}

export function clearSuccessfulLogin(email: string) {
  run("DELETE FROM login_attempts WHERE scope='email' AND identity=?", email);
}
