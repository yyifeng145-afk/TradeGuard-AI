import { createHash } from "node:crypto";
import { isProduction } from "./config.js";
import { redisClient } from "./platform/redis.js";

const WINDOW_MS = 15 * 60 * 1000;
const useIpLimit = () => !isProduction() || Boolean(process.env.CRM_TRUSTED_PROXY_CIDRS);
const digest = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
const rateKey = (scope: "email" | "ip", identity: string) => `crm:login:${scope}:${digest(identity)}`;

async function currentCount(scope: "email" | "ip", identity: string) {
  return Number((await redisClient()).get(rateKey(scope, identity)) ?? 0);
}

export async function assertLoginAllowed(email: string, ip: string) {
  const [emailAttempts, ipAttempts] = await Promise.all([
    currentCount("email", email),
    useIpLimit() ? currentCount("ip", ip) : Promise.resolve(0),
  ]);
  if (emailAttempts >= 5 || ipAttempts >= 20) {
    throw Object.assign(new Error("登录尝试过多，请 15 分钟后重试"), { statusCode: 429 });
  }
}

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export async function recordFailedLogin(email: string, ip: string) {
  const redis = await redisClient();
  const keys = [rateKey("email", email), ...(useIpLimit() ? [rateKey("ip", ip)] : [])];
  await Promise.all(keys.map((key) => redis.eval(incrementScript, { keys: [key], arguments: [String(WINDOW_MS)] })));
}

export async function clearSuccessfulLogin(email: string) {
  await (await redisClient()).del(rateKey("email", email));
}
