export const TITLE_GENERATION_SYSTEM_PROMPT = `You are a specialist in summarizing conversations into short titles.
Given the first user message and optionally the first assistant response, generate a concise title (3-7 words) that captures the main topic.
Rules:
- Be specific, not generic ("Fix React useEffect bug" not "Code help")
- No punctuation at the end
- No quotes around the title
- Output ONLY the title, nothing else`;

export function buildTitlePrompt(userMessage: string, assistantMessage?: string): string {
  const truncatedUser = userMessage.slice(0, 500);
  const parts = [`User: ${truncatedUser}`];
  if (assistantMessage) {
    parts.push(`Assistant: ${assistantMessage.slice(0, 500)}`);
  }
  return parts.join("\n\n") + "\n\nGenerate a short title for this conversation:";
}

export function parseTitle(text: string): string | null {
  const cleaned = text.trim().replace(/^["']|["']$/g, "").replace(/[.!?]$/, "").trim();
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned.slice(0, 50);
}

export const FOLDER_SUGGESTION_SYSTEM_PROMPT = `You categorize conversations into folders.

Given a conversation title, preview, and a list of existing folder names, decide where to place it.

**Rules**:
1. If it fits an existing folder, respond: EXISTING: <folder name>
2. If no folder fits, suggest a new one: NEW: <short category name>
3. New folder names should be 1-3 words, general enough to hold multiple conversations (e.g., "Code Review", "Research", "DevOps", "Data Analysis").
4. Do NOT create overly specific folders. Prefer broad categories.

**Output**: Return ONLY one line: either "EXISTING: <name>" or "NEW: <name>". Nothing else.`;

export function buildFolderPrompt(title: string, preview: string, folders: string[]): string {
  const folderList = folders.length > 0
    ? folders.map(f => `- ${f}`).join("\n")
    : "(no existing folders)";
  return `Title: ${title}\nPreview: ${preview}\n\nExisting folders:\n${folderList}\n\nWhich folder should this conversation go in?`;
}

export function parseFolderSuggestion(text: string): { type: "existing" | "new"; folderName: string } {
  const trimmed = text.trim();
  const existingMatch = trimmed.match(/^EXISTING:\s*(.+)$/i);
  if (existingMatch) {
    return { type: "existing", folderName: existingMatch[1].trim() };
  }
  const newMatch = trimmed.match(/^NEW:\s*(.+)$/i);
  if (newMatch) {
    return { type: "new", folderName: newMatch[1].trim() };
  }
  return { type: "new", folderName: trimmed.substring(0, 30) };
}
