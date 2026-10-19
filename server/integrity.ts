import { createHash } from "node:crypto";

export function normalizeContent(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function contentHash(value: string) {
  return createHash("sha256").update(normalizeContent(value), "utf8").digest("hex");
}

export function redactPersonalData(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g, "[PHONE]");
}

export function lexicalScore(value: string, query: string) {
  const words = normalizeContent(query).toLowerCase().match(/[a-z0-9-]{2,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
  const haystack = normalizeContent(value).toLowerCase();
  return words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
}
