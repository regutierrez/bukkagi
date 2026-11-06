import { LocalStorage } from "@raycast/api";
import type { Activity, Source, Usage } from "./api";

export type TurnStatus = "running" | "done" | "stopped" | "error";

export type Turn = {
  id: string;
  question: string;
  model: string; // "" means Kagi's default model
  search: boolean;
  effort: string; // "" means the model's default
  /** The branch this turn was sent on; undefined for the first turn of a thread. Retry resends it. */
  parentBranch?: string;
  status: TurnStatus;
  activities: Activity[];
  sources: Source[];
  text: string;
  usage?: Usage;
  error?: string;
  startedAt: number;
  endedAt?: number;
};

export type Thread = {
  id: string;
  title: string;
  /** Kagi branch from the latest `thread` event; sent back so follow-ups continue the same Kagi thread. */
  branch?: string;
  url?: string;
  turns: Turn[];
  updatedAt: number;
};

const KEY = "threads";
const MAX_THREADS = 50;

export async function loadThreads(): Promise<Thread[]> {
  const raw = await LocalStorage.getItem<string>(KEY);
  const threads = raw ? (JSON.parse(raw) as Thread[]) : [];
  // A turn saved while streaming ended when the command closed.
  return threads.map((th) => ({
    ...th,
    turns: th.turns.map((t) => (t.status === "running" ? { ...t, status: "stopped" } : t)),
  }));
}

export async function saveThreads(threads: Thread[]): Promise<void> {
  const kept = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
  await LocalStorage.setItem(KEY, JSON.stringify(kept));
}

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** How many times the answer cites source n. The proxy writes citations as [[n]](url). */
export function citationCount(text: string, n: number): number {
  return text.split(`[[${n}]](`).length - 1;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line such as "2 searches · 4 sources", used once answer text has started. */
export function stepSummary(turn: Turn): string {
  if (!turn.search) return "Answered without web search";
  const searches = turn.activities.filter((a) => a.type === "search").length;
  const parts = [count(searches, "search", "searches"), count(turn.sources.length, "source", "sources")];
  if (turn.status === "stopped") parts.unshift("Stopped");
  return parts.join(" · ");
}

function activityLine(a: Activity): string {
  const mark = { running: "◌", completed: "✓", failed: "✕", cancelled: "–" }[a.status];
  const label = a.type === "search" ? "Searching" : a.type === "thinking" ? "Thinking" : a.type;
  return `${mark} ${label}: ${a.text}`;
}

/** While text streams, an unclosed ``` fence would turn the rest of the pane into code; close it. */
function closeOpenFence(text: string): string {
  const fences = text.match(/^\s*(```|~~~)/gm) ?? [];
  return fences.length % 2 === 1 ? `${text}\n\`\`\`` : text;
}

export function turnMarkdown(turn: Turn, withSourceList: boolean): string {
  const out = [`### ${turn.question}`];
  const working = turn.status === "running" && !turn.text;

  if (working) {
    const lines = turn.activities.map(activityLine);
    if (lines.length === 0) lines.push(turn.search ? "◌ Searching the web…" : "◌ Thinking…");
    out.push(lines.join("  \n"));
  } else if (turn.activities.length > 0 || turn.sources.length > 0 || !turn.search) {
    out.push(`_${stepSummary(turn)}_`);
  }

  if (turn.text) out.push(turn.status === "running" ? closeOpenFence(turn.text) : turn.text);
  if (turn.status === "stopped") out.push("_Stopped. ⌘R asks again._");
  if (turn.status === "error") out.push(`**Answer failed:** ${turn.error ?? "unknown error"}  \n_⌘R retries._`);

  if (withSourceList && turn.sources.length > 0) {
    out.push("---", turn.sources.map((s) => `${s.n}. [${s.title}](${s.url}) · ${domain(s.url)}`).join("\n"));
  }
  return out.join("\n\n");
}

/** The answer with a numbered source list, for Copy with Sources. */
export function answerWithSources(turn: Turn): string {
  const list = turn.sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join("\n");
  return list ? `${turn.text}\n\nSources:\n${list}` : turn.text;
}
