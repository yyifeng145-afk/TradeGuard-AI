import { readFileSync } from "node:fs";
const secretVariables = [
    "MODEL_API_KEY", "FEISHU_BOT_WEBHOOK", "FEISHU_BOT_SECRET",
    "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "MEM0_API_KEY",
    "WEKNORA_API_KEY", "CRM_METRICS_TOKEN"
    , "DATABASE_URL", "REDIS_URL"
] as const;
export function loadRuntimeSecrets(env: NodeJS.ProcessEnv = process.env) {
    for (const name of secretVariables) {
        if (env[name])
            continue;
        const path = env[`${name}_FILE`];
        if (!path)
            continue;
        const value = readFileSync(path, "utf8").trim();
        if (!value)
            throw new Error(`${name}_FILE 指向的密钥文件为空`);
        env[name] = value;
    }
}
export function isProduction(env: NodeJS.ProcessEnv = process.env) {
    return env.APP_ENV === "production";
}
export function assertRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env) {
    loadRuntimeSecrets(env);
    if (env.APP_ENV && !["development", "test", "production"].includes(env.APP_ENV)) {
        throw new Error("APP_ENV 必须为 development、test 或 production");
    }
    if (!isProduction(env))
        return;
    if (!env.DATABASE_URL?.startsWith("postgresql://") && !env.DATABASE_URL?.startsWith("postgres://")) {
        throw new Error("生产模式必须配置 PostgreSQL DATABASE_URL");
    }
    if (!env.REDIS_URL?.startsWith("redis://") && !env.REDIS_URL?.startsWith("rediss://")) {
        throw new Error("生产模式必须配置 REDIS_URL");
    }
    if (env.CRM_DB_PATH)
        throw new Error("生产模式禁止配置 CRM_DB_PATH；SQLite 只能作为离线迁移源");
    if (!env.CRM_PUBLIC_URL || !env.CRM_PUBLIC_URL.startsWith("https://")) {
        throw new Error("生产模式必须配置 HTTPS CRM_PUBLIC_URL");
    }
    if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_NAME) {
        throw new Error("生产模式必须配置模型服务；模型故障时任务转人工，不使用演示解析器");
    }
    if (!/^https:\/\//.test(env.MODEL_BASE_URL) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(env.MODEL_BASE_URL)) {
        throw new Error("生产模型地址必须使用 HTTPS，或仅指向本机模型服务");
    }
    if (env.FEISHU_BOT_WEBHOOK && !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(env.FEISHU_BOT_WEBHOOK)) {
        throw new Error("FEISHU_BOT_WEBHOOK 必须是飞书官方机器人 HTTPS 地址");
    }
    if (env.FEISHU_BOT_WEBHOOK && !env.FEISHU_BOT_SECRET) {
        throw new Error("生产模式启用飞书通知时必须配置 FEISHU_BOT_SECRET 签名密钥");
    }
    if (!env.CRM_METRICS_TOKEN || env.CRM_METRICS_TOKEN.length < 32) {
        throw new Error("生产模式必须配置至少 32 字符的 CRM_METRICS_TOKEN");
    }
}
