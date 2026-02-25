import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import type { ContextMessage, ContextStats } from "@claude-agent-runner/shared";

// --- Internal types ---

interface JsonlRecord {
  uuid: string;
  parentUuid: string | null;
  type: string;
  message?: any;
  content?: any;
  subtype?: string;
  timestamp?: string;
  [key: string]: any;
}

// --- Low-level JSONL I/O ---

export function readJsonl(path: string): JsonlRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const records: JsonlRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines (same as CLI behavior)
    }
  }
  return records;
}

export function writeJsonl(path: string, records: JsonlRecord[]): void {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

// --- Chain reconstruction ---

/**
 * Build an ordered conversation chain from JSONL records by walking
 * BACKWARD from the most recent leaf, following parentUuid links.
 * This matches how the CLI reconstructs context on resume.
 *
 * The JSONL is a tree (multiple branches from tool calls, sidechains).
 * The CLI finds the leaf (most recent non-sidechain record with no
 * children) and walks backward to the root to build the linear chain.
 */
export function buildChain(records: JsonlRecord[]): JsonlRecord[] {
  if (records.length === 0) return [];

  const byUuid = new Map<string, JsonlRecord>();
  const hasChildren = new Set<string>();

  for (const r of records) {
    if (!r.uuid) continue;
    byUuid.set(r.uuid, r);
    if (r.parentUuid) {
      hasChildren.add(r.parentUuid);
    }
  }

  // Find leaf nodes: records whose uuid is not any other record's parentUuid
  // Filter to non-sidechain records for the main conversation
  const leaves = records.filter(
    (r) => r.uuid && !hasChildren.has(r.uuid) && !r.isSidechain,
  );

  if (leaves.length === 0) {
    // Fallback: try all leaves including sidechains
    const allLeaves = records.filter((r) => r.uuid && !hasChildren.has(r.uuid));
    if (allLeaves.length === 0) return [];
    leaves.push(...allLeaves);
  }

  // Pick the most recent leaf (last in file order, which is chronological)
  const leaf = leaves[leaves.length - 1];

  // Walk backward from leaf to root
  const chain: JsonlRecord[] = [];
  let current: JsonlRecord | undefined = leaf;
  const visited = new Set<string>();

  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    chain.unshift(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }

  return chain;
}

// --- Public API ---

/**
 * Read a session JSONL and return the ordered conversation chain,
 * filtered to user/assistant/system messages only.
 */
export function readSessionChain(jsonlPath: string): ContextMessage[] {
  const records = readJsonl(jsonlPath);
  const chain = buildChain(records);
  return chain
    .filter((r) => r.type === "user" || r.type === "assistant" || r.type === "system")
    .map((r) => ({
      uuid: r.uuid,
      parentUuid: r.parentUuid,
      type: r.type as "user" | "assistant" | "system",
      content: r.message ?? r.content ?? null,
      timestamp: r.timestamp,
    }));
}

/**
 * Remove a message from the JSONL by UUID.
 * Re-points any children of the removed message to its parent.
 */
export function removeMessage(jsonlPath: string, targetUuid: string): void {
  const records = readJsonl(jsonlPath);
  const target = records.find((r) => r.uuid === targetUuid);
  if (!target) throw new Error(`Message ${targetUuid} not found`);

  const targetParent = target.parentUuid ?? null;
  const updated = records
    .filter((r) => r.uuid !== targetUuid)
    .map((r) => {
      if (r.parentUuid === targetUuid) {
        return { ...r, parentUuid: targetParent };
      }
      return r;
    });

  writeJsonl(jsonlPath, updated);
}

/**
 * Inject a new message into the JSONL session chain.
 * If afterUuid is provided, inserts after that message (re-linking the chain).
 * Otherwise appends at the tail of the chain.
 * Returns the UUID of the injected message.
 */
export function injectMessage(
  jsonlPath: string,
  content: string,
  role: "user" | "system",
  afterUuid?: string,
): string {
  const records = readJsonl(jsonlPath);
  const newUuid = randomUUID();

  let parentUuid: string | null = null;

  if (afterUuid) {
    const afterIdx = records.findIndex((r) => r.uuid === afterUuid);
    if (afterIdx === -1) throw new Error(`After-UUID ${afterUuid} not found`);
    parentUuid = afterUuid;

    // Re-point existing children of afterUuid to point to newUuid
    for (let i = 0; i < records.length; i++) {
      if (records[i].parentUuid === afterUuid) {
        records[i] = { ...records[i], parentUuid: newUuid };
      }
    }
  } else {
    // Find chain tail — a record whose uuid is not any other record's parentUuid
    const chain = buildChain(records);
    if (chain.length > 0) {
      parentUuid = chain[chain.length - 1].uuid;
    }
  }

  const newRecord: JsonlRecord = {
    uuid: newUuid,
    parentUuid,
    isSidechain: false,
    type: role === "system" ? "system" : "user",
    ...(role === "system"
      ? { subtype: "injected", content }
      : { message: { role: "user", content } }),
    timestamp: new Date().toISOString(),
  };

  records.push(newRecord);
  writeJsonl(jsonlPath, records);
  return newUuid;
}

/**
 * Keep only the last N user/assistant turn pairs in the conversation.
 * Removes everything before them and sets the first kept record's
 * parentUuid to null (making it the new root).
 */
export function truncateToLastN(jsonlPath: string, n: number): void {
  const records = readJsonl(jsonlPath);
  const chain = buildChain(records);

  // Identify conversational messages (user + assistant)
  const conversational = chain.filter(
    (r) => r.type === "user" || r.type === "assistant",
  );

  const keepCount = n * 2; // user + assistant per turn
  if (conversational.length <= keepCount) return; // nothing to trim

  // Find the UUIDs to keep
  const keepFrom = conversational.length - keepCount;
  const keepUuids = new Set(conversational.slice(keepFrom).map((r) => r.uuid));

  // Also keep system messages that appear within the kept range
  const firstKeptUuid = conversational[keepFrom].uuid;
  const firstKeptIdx = chain.findIndex((r) => r.uuid === firstKeptUuid);
  for (let i = firstKeptIdx; i < chain.length; i++) {
    keepUuids.add(chain[i].uuid);
  }

  const kept = records.filter((r) => keepUuids.has(r.uuid));

  // Set the first kept record's parentUuid to null (new root)
  if (kept.length > 0) {
    const firstKept = kept.find((r) => r.uuid === firstKeptUuid);
    if (firstKept) {
      firstKept.parentUuid = null;
    }
  }

  writeJsonl(jsonlPath, kept);
}

/**
 * Get statistics about the current context without returning full content.
 */
export function getContextStats(jsonlPath: string): ContextStats {
  const records = readJsonl(jsonlPath);
  const chain = buildChain(records);

  const typeBreakdown: Record<string, number> = {};
  for (const r of chain) {
    typeBreakdown[r.type] = (typeBreakdown[r.type] || 0) + 1;
  }

  const conversational = chain.filter(
    (r) => r.type === "user" || r.type === "assistant",
  );
  const turnCount = Math.floor(conversational.length / 2);

  // Rough token estimate: ~4 chars per token
  const totalChars = chain.reduce((acc, r) => {
    const content = JSON.stringify(r.message ?? r.content ?? "");
    return acc + content.length;
  }, 0);

  return {
    message_count: chain.length,
    turn_count: turnCount,
    type_breakdown: typeBreakdown,
    estimated_tokens: Math.ceil(totalChars / 4),
  };
}
