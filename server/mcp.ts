import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { all, audit, initDatabase, one, verifyPassword } from "./db.js";
import { getActivePolicy, getCustomerProfile, listCustomers, searchCustomerMemory, searchEnterpriseKnowledge, searchProducts, type DomainActor, type Role } from "./domain.js";
import {
  createFollowUpTask, createOpportunityDraft, detectOpportunityConflicts, generateOpportunityReport,
  getOpportunity, listOpportunities, proposeOpportunityClaim
} from "./opportunities.js";

type McpUser = { id: string; organization_id: string; email: string; role: string; is_active: number; password_salt: string; password_hash: string };
initDatabase();
const email = process.env.CRM_MCP_EMAIL;
const password = process.env.CRM_MCP_PASSWORD;
if (!email || !password) throw new Error("Set CRM_MCP_EMAIL and CRM_MCP_PASSWORD before starting the MCP server");
const user = one<McpUser>("SELECT * FROM users WHERE email=?", email);
if (!user || user.is_active !== 1 || !verifyPassword(password, user.password_salt, user.password_hash)) throw new Error("MCP credentials are invalid");
const authenticatedUser = user;

function currentMcpUser() {
  const current = one<McpUser>("SELECT * FROM users WHERE id=? AND organization_id=? AND is_active=1", authenticatedUser.id, authenticatedUser.organization_id);
  if (!current) throw new Error("MCP account is disabled");
  return current;
}

function actor(): DomainActor {
  const current = currentMcpUser();
  return { id: current.id, organizationId: current.organization_id, role: current.role as Role, source: "user" };
}

const server = new McpServer({ name: "northstar-crm", version: "0.1.0" });
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

server.registerTool("list_customers", {
  title: "List CRM customers", description: "Read customers in the authenticated organization.",
  inputSchema: z.object({ query: z.string().optional() })
}, async ({ query }) => {
  const principal = actor();
  const customers = listCustomers(principal, query);
  audit(principal.organizationId, principal.id, "mcp.customers.read", "organization", principal.organizationId, query ?? "all");
  return result(customers);
});

server.registerTool("get_customer_profile", {
  title: "Read customer profile", description: "Get one CRM customer and confirmed preferences. Tenant scope is enforced by the server.",
  inputSchema: z.object({ customerId: z.string() })
}, async ({ customerId }) => {
  const principal = actor();
  try {
    const customer = getCustomerProfile(principal, customerId);
    const memories = (await searchCustomerMemory(principal, customerId, "客户偏好")).filter((memory) => memory.status === "confirmed");
    audit(principal.organizationId, principal.id, "mcp.customer.read", "customer", customerId, "profile + confirmed memories");
    return result({ customer, memories });
  } catch {
    return { isError: true, content: [{ type: "text" as const, text: "Customer not found" }] };
  }
});

server.registerTool("search_products", {
  title: "Search product catalogue", description: "Read products and list prices in the authenticated organization.",
  inputSchema: z.object({ query: z.string() })
}, async ({ query }) => {
  const principal = actor();
  const products = searchProducts(principal, query, false);
  audit(principal.organizationId, principal.id, "mcp.products.read", "organization", principal.organizationId, query);
  return result(products);
});

server.registerTool("get_quote_policy", {
  title: "Read active quote policy", description: "Get the currently published pricing policy and its version.",
  inputSchema: z.object({})
}, async () => {
  const principal = actor();
  const policy = getActivePolicy(principal);
  audit(principal.organizationId, principal.id, "mcp.policy.read", "policy", policy.id, policy.version);
  return result(policy);
});

server.registerTool("search_knowledge", {
  title: "Search enterprise knowledge", description: "Search currently published documents and optional WeKnora passages. External passages are marked unverified.",
  inputSchema: z.object({ query: z.string().min(2).max(200), sku: z.string().optional() })
}, async ({ query, sku }) => {
  const principal = actor();
  const evidence = await searchEnterpriseKnowledge(principal, query, sku);
  audit(principal.organizationId, principal.id, "mcp.knowledge.search", "organization", principal.organizationId, query);
  return result(evidence);
});

server.registerTool("search_customer_memory", {
  title: "Search customer memory", description: "Search confirmed local facts and tenant-scoped external memory for an accessible customer.",
  inputSchema: z.object({ customerId: z.string(), query: z.string().min(2).max(200) })
}, async ({ customerId, query }) => {
  const principal = actor();
  const memories = await searchCustomerMemory(principal, customerId, query);
  audit(principal.organizationId, principal.id, "mcp.memory.search", "customer", customerId, query);
  return result(memories);
});

server.registerTool("list_customer_conversations", {
  title: "List customer conversations", description: "List conversation headers for an accessible customer without exposing another sales owner's data.",
  inputSchema: z.object({ customerId: z.string() })
}, async ({ customerId }) => {
  const principal = actor();
  getCustomerProfile(principal, customerId);
  return result(all(`SELECT c.id,c.channel,c.created_at,COUNT(m.id) AS message_count,MAX(m.created_at) AS last_message_at
    FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id AND m.organization_id=c.organization_id
    WHERE c.organization_id=? AND c.customer_id=? GROUP BY c.id ORDER BY last_message_at DESC`, principal.organizationId, customerId));
});

server.registerTool("get_conversation_messages", {
  title: "Read conversation messages", description: "Read a bounded message history after checking tenant and customer ownership.",
  inputSchema: z.object({ conversationId: z.string(), limit: z.number().int().min(1).max(100).default(50) })
}, async ({ conversationId, limit }) => {
  const principal = actor();
  const conversation = one<{ customer_id: string }>("SELECT customer_id FROM conversations WHERE id=? AND organization_id=?", conversationId, principal.organizationId);
  if (!conversation) throw new Error("Conversation not found");
  getCustomerProfile(principal, conversation.customer_id);
  return result(all("SELECT id,direction,body,external_id,created_at FROM messages WHERE conversation_id=? AND organization_id=? ORDER BY created_at DESC LIMIT ?", conversationId, principal.organizationId, limit));
});

server.registerTool("list_customer_quotes", {
  title: "List customer quotes", description: "List quote commercial terms. Cost and margin fields are never returned by this tool.",
  inputSchema: z.object({ customerId: z.string() })
}, async ({ customerId }) => {
  const principal = actor();
  getCustomerProfile(principal, customerId);
  return result(all(`SELECT q.id,q.product_id,p.sku,q.quantity,q.currency,q.unit_price_cents,q.total_cents,q.discount_bps,
    q.status,q.version,q.trade_term,q.named_place,q.valid_until,q.created_at,q.updated_at
    FROM quotes q JOIN products p ON p.id=q.product_id AND p.organization_id=q.organization_id
    WHERE q.organization_id=? AND q.customer_id=? ORDER BY q.created_at DESC LIMIT 100`, principal.organizationId, customerId));
});

server.registerTool("get_quote", {
  title: "Read quote", description: "Read one accessible quote without cost or margin fields.",
  inputSchema: z.object({ quoteId: z.string() })
}, async ({ quoteId }) => {
  const principal = actor();
  const quote = one<{ customer_id: string }>(`SELECT q.id,q.customer_id,q.product_id,p.sku,q.quantity,q.currency,q.unit_price_cents,q.total_cents,
    q.discount_bps,q.status,q.version,q.policy_id,q.policy_version,q.evidence_json,q.trade_term,q.named_place,q.valid_until,q.created_at,q.updated_at
    FROM quotes q JOIN products p ON p.id=q.product_id AND p.organization_id=q.organization_id WHERE q.id=? AND q.organization_id=?`, quoteId, principal.organizationId);
  if (!quote) throw new Error("Quote not found");
  getCustomerProfile(principal, quote.customer_id);
  return result(quote);
});

server.registerTool("list_opportunities", {
  title: "List opportunities", description: "List opportunities within the authenticated user's tenant and ownership scope.",
  inputSchema: z.object({ customerId: z.string().optional() })
}, async ({ customerId }) => result(listOpportunities(actor(), customerId)));

server.registerTool("get_opportunity", {
  title: "Read opportunity", description: "Read an opportunity, its field evidence, conflicts, reports and follow-up tasks.",
  inputSchema: z.object({ opportunityId: z.string() })
}, async ({ opportunityId }) => result(getOpportunity(actor(), opportunityId)));

server.registerTool("create_opportunity_draft", {
  title: "Create opportunity draft", description: "Create a draft opportunity only; this does not approve a quote or contact a customer.",
  inputSchema: z.object({ customerId: z.string(), title: z.string().trim().min(2).max(160), currency: z.string().length(3).default("USD") })
}, async ({ customerId, title, currency }) => result(createOpportunityDraft(actor(), customerId, title, currency.toUpperCase())));

server.registerTool("propose_opportunity_claim", {
  title: "Propose opportunity field", description: "Add a sourced field candidate. Conflicting values remain visible for human resolution.",
  inputSchema: z.object({
    opportunityId: z.string(), fieldName: z.string(), value: z.unknown(), confidence: z.number().min(0).max(1),
    sourceType: z.enum(["crm", "message", "memory", "knowledge", "model"]), sourceId: z.string(),
    sourceVersion: z.string().optional(), sourceContent: z.string().max(4000).optional()
  })
}, async (input) => result(proposeOpportunityClaim(actor(), input)));

server.registerTool("detect_opportunity_conflicts", {
  title: "Detect opportunity conflicts", description: "Detect different sourced values for the same opportunity field.",
  inputSchema: z.object({ opportunityId: z.string() })
}, async ({ opportunityId }) => result(detectOpportunityConflicts(actor(), opportunityId)));

server.registerTool("generate_opportunity_report", {
  title: "Generate opportunity report", description: "Generate a deterministic evidence-linked report; unresolved conflicts force human review.",
  inputSchema: z.object({ opportunityId: z.string() })
}, async ({ opportunityId }) => result(generateOpportunityReport(actor(), opportunityId)));

server.registerTool("create_follow_up_task", {
  title: "Create follow-up task", description: "Create an internal follow-up task. Sales users may only assign tasks to themselves.",
  inputSchema: z.object({ opportunityId: z.string(), title: z.string().trim().min(2).max(200), assigneeId: z.string(), dueAt: z.string().datetime().optional() })
}, async ({ opportunityId, title, assigneeId, dueAt }) => result(createFollowUpTask(actor(), opportunityId, title, assigneeId, dueAt)));

server.registerTool("list_follow_up_tasks", {
  title: "List follow-up tasks", description: "List follow-up tasks for an accessible opportunity.",
  inputSchema: z.object({ opportunityId: z.string() })
}, async ({ opportunityId }) => result(getOpportunity(actor(), opportunityId).tasks));

await server.connect(new StdioServerTransport());
