import { all, now } from "./db.js";
import { contentHash, lexicalScore } from "./integrity.js";

export type Evidence = {
  id: string;
  type: "sql" | "memory" | "knowledge" | "weknora" | "mem0";
  title: string;
  content: string;
  version?: string;
  status?: string;
  source?: string;
  contentHash?: string;
};

type MemoryRow = { id: string; content: string; content_hash: string | null; status: string; confidence: number; source_message_id: string | null };
type DocumentRow = { id: string; title: string; body: string; content_hash: string | null; version: string; status: string };

export function configuredKnowledgeBase(organizationId: string): string | undefined {
  try {
    const mapping = JSON.parse(process.env.WEKNORA_KNOWLEDGE_BASE_MAP || "{}") as Record<string, unknown>;
    const value = mapping[organizationId];
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export function customerMemories(organizationId: string, customerId: string): Evidence[] {
  return all<MemoryRow>(
    "SELECT id,content,content_hash,status,confidence,source_message_id FROM memories WHERE organization_id=? AND customer_id=? AND status IN ('confirmed','candidate') ORDER BY confidence DESC",
    organizationId, customerId
  ).map((memory) => ({
    id: memory.id,
    type: "memory",
    title: memory.status === "confirmed" ? "已确认客户偏好" : "待核实客户偏好",
    content: memory.content,
    status: memory.status,
    source: memory.source_message_id ?? "自动提取",
    contentHash: memory.content_hash ?? contentHash(memory.content)
  }));
}

export async function searchKnowledge(organizationId: string, query: string, productSku?: string): Promise<Evidence[]> {
  const current = now();
  const documents = all<DocumentRow>(
    "SELECT id,title,body,content_hash,version,status FROM knowledge_documents WHERE organization_id=? AND status='published' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) AND (? IS NULL OR product_sku IS NULL OR product_sku=?)",
    organizationId, current, current, productSku ?? null, productSku ?? null
  );
  const local = documents
    .map((doc) => ({ doc, rank: lexicalScore(`${doc.title} ${doc.body}`, query) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3)
    .map(({ doc }) => ({ id: doc.id, type: "knowledge" as const, title: doc.title, content: doc.body, version: doc.version, status: doc.status, contentHash: doc.content_hash ?? contentHash(doc.body) }));

  const url = process.env.WEKNORA_BASE_URL;
  const key = process.env.WEKNORA_API_KEY;
  // External knowledge bases must be mapped per tenant. Never use a global KB for every organization.
  const kbId = configuredKnowledgeBase(organizationId);
  if (!url || !key || !kbId) return local;
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/api/v1/knowledge-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ query, knowledge_base_id: kbId, match_count: 3 }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return local;
    const result = await response.json() as { data?: Array<{ id: string; content: string; knowledge_title?: string; knowledge_id?: string }> };
    const external = (result.data ?? []).map((hit) => ({
      id: hit.id,
      type: "weknora" as const,
      title: hit.knowledge_title ?? "WeKnora 检索片段",
      content: hit.content,
      status: "unverified",
      source: hit.knowledge_id,
      contentHash: contentHash(hit.content)
    }));
    return [...local, ...external];
  } catch {
    return local;
  }
}
