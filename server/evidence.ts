import { one, now } from "./db.js";
import { contentHash } from "./integrity.js";

export type EvidenceQuote = {
  organization_id: string;
  customer_id: string;
  product_id: string;
  policy_id: string;
  policy_version: string;
  evidence_json: string;
};

export function knowledgeEvidenceRef(id: string, version: string, hash: string) {
  return `knowledge:${id}@${version}#${hash}`;
}

export function validateQuoteEvidence(organizationId: string, quote: EvidenceQuote): string | undefined {
  let references: unknown;
  try { references = JSON.parse(quote.evidence_json); }
  catch { return "报价证据格式损坏"; }
  if (!Array.isArray(references) || !references.every((item) => typeof item === "string")) return "报价证据格式无效";
  if (!references.includes(`SQL:product:${quote.product_id}`)) return "产品证据缺失";
  if (!references.includes(`SQL:policy:${quote.policy_id}@${quote.policy_version}`)) return "报价政策证据缺失";

  for (const reference of references as string[]) {
    if (reference.startsWith("memory:")) {
      const memoryId = reference.slice("memory:".length);
      const memory = one("SELECT id FROM memories WHERE id=? AND organization_id=? AND customer_id=? AND status='confirmed'", memoryId, organizationId, quote.customer_id);
      if (!memory) return `客户记忆 ${memoryId} 已撤回或变更`;
    }
    if (reference.startsWith("knowledge:")) {
      const match = reference.match(/^knowledge:([^@#]+)@([^#]+)#([a-f0-9]{64})$/);
      if (!match) return "知识引用缺少可校验的版本或内容指纹";
      const document = one<{ body: string; content_hash: string | null }>(
        "SELECT body,content_hash FROM knowledge_documents WHERE id=? AND organization_id=? AND version=? AND status='published' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)",
        match[1], organizationId, match[2], now(), now()
      );
      if (!document) return `知识文档 ${match[1]} 已撤回、过期或改版`;
      const currentHash = contentHash(document.body);
      if (currentHash !== match[3] || (document.content_hash && document.content_hash !== currentHash)) return `知识文档 ${match[1]} 内容指纹已变化`;
    }
  }
  return undefined;
}
