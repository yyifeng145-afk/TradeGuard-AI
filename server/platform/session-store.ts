import { randomBytes } from "node:crypto";
import { redisClient } from "./redis.js";
export type RedisSession = {
    userId: string;
    organizationId: string;
    csrfToken: string;
};
const key = (token: string) => `crm:session:${token}`;
const userKey = (userId: string) => `crm:user-sessions:${userId}`;
export async function createRedisSession(session: RedisSession, ttlSeconds = 28800) {
    const token = randomBytes(32).toString("base64url");
    const redis = await redisClient();
    await redis.multi()
        .set(key(token), JSON.stringify(session), { EX: ttlSeconds, NX: true })
        .sAdd(userKey(session.userId), token)
        .expire(userKey(session.userId), ttlSeconds)
        .exec();
    return token;
}
export async function getRedisSession(token: string) {
    const value = await (await redisClient()).get(key(token));
    if (!value)
        return undefined;
    try {
        return JSON.parse(value) as RedisSession;
    }
    catch {
        await deleteRedisSession(token);
        return undefined;
    }
}
export async function deleteRedisSession(token: string) {
    const redis = await redisClient();
    const value = await redis.get(key(token));
    const session = value ? safeSession(value) : undefined;
    const batch = redis.multi().del(key(token));
    if (session) batch.sRem(userKey(session.userId), token);
    await batch.exec();
}
function safeSession(value: string) {
    try { return JSON.parse(value) as RedisSession; } catch { return undefined; }
}
export async function revokeUserSessions(userId: string, exceptToken?: string) {
    const redis = await redisClient();
    const tokens = await redis.sMembers(userKey(userId));
    const revoked = tokens.filter((token) => token !== exceptToken);
    if (revoked.length) await redis.del(revoked.map(key));
    if (exceptToken) {
        await redis.del(userKey(userId));
        await redis.sAdd(userKey(userId), exceptToken);
        const ttl = await redis.ttl(key(exceptToken));
        if (ttl > 0) await redis.expire(userKey(userId), ttl);
    } else {
        await redis.del(userKey(userId));
    }
}
