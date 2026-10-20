import type { Evidence } from "./retrieval.js";
import { all } from "./db.js";
import { contentHash, lexicalScore, redactPersonalData } from "./integrity.js";
function enabled() {
    return process.env.MEM0_SYNC_ENABLED === "true" && Boolean(process.env.MEM0_API_KEY);
}
const scopedUser = (organizationId: string, customerId: string) => `${organizationId}:${customerId}`;
export async function searchMem0(organizationId: string, customerId: string, query: string): Promise<Evidence[]> {
    if (!enabled())
        return [];
    try {
        const response = await fetch("https://api.mem0.ai/v3/memories/search/", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Token ${process.env.MEM0_API_KEY}` },
            body: JSON.stringify({ query: query.slice(0, 200), limit: 50, filters: { user_id: scopedUser(organizationId, customerId) } }),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok)
            return [];
        const payload = await response.json() as {
            results?: Array<{
                id?: string;
                memory?: string;
                score?: number;
            }>;
        };
        const localHashes = new Set((await all<{
            content_hash: string | null;
            content: string;
        }>("SELECT content_hash,content FROM memories WHERE organization_id=? AND customer_id=?", organizationId, customerId)).map((item) => item.content_hash ?? contentHash(item.content)));
        const seen = new Set<string>();
        return (payload.results ?? [])
            .filter((item): item is {
            id: string;
            memory: string;
            score?: number;
        } => Boolean(item.id && item.memory))
            .map((item) => ({ item, hash: contentHash(item.memory), rank: lexicalScore(item.memory, query) * 100 + (item.score ?? 0) }))
            .filter(({ hash }) => !localHashes.has(hash) && !seen.has(hash) && Boolean(seen.add(hash)))
            .sort((a, b) => b.rank - a.rank)
            .slice(0, 10)
            .map(({ item, hash }) => ({
            id: item.id, type: "mem0" as const, title: "Mem0 检索线索", content: redactPersonalData(item.memory),
            contentHash: hash, status: "unverified", source: `mem0:${scopedUser(organizationId, customerId)}`
        }));
    }
    catch {
        return [];
    }
}
export async function syncConfirmedMemory(organizationId: string, customerId: string, content: string): Promise<"disabled" | "synced" | "failed"> {
    if (!enabled())
        return "disabled";
    try {
        const response = await fetch("https://api.mem0.ai/v3/memories/add/", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Token ${process.env.MEM0_API_KEY}` },
            body: JSON.stringify({
                messages: [{ role: "user", content }],
                user_id: scopedUser(organizationId, customerId),
                metadata: { source: "crm-confirmed-preference", content_hash: contentHash(content) }
            }),
            signal: AbortSignal.timeout(5000)
        });
        return response.ok ? "synced" : "failed";
    }
    catch {
        return "failed";
    }
}
