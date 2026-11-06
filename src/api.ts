import { getPreferenceValues } from "@raycast/api";

// Wire types of the proxy's POST /v1/ask stream (see the proxy README, "/v1/ask").
export type ThreadEvent = { conversation: string; branch: string; turn: string; url: string };
export type Activity = { id: string; type: string; text: string; status: "running" | "completed" | "failed" | "cancelled" };
export type Source = { n: number; url: string; title: string; snippet: string; favicon?: string; published_at?: string };
export type Usage = { model: string; model_version?: string; input_tokens: number; output_tokens: number; cost_usd?: number };
export type StreamError = { type: string; code: string; message: string };

export type AskRequest = {
  query: string;
  model?: string;
  search: boolean;
  reasoning_effort?: string;
  branch?: string;
};

export type AskHandlers = {
  thread(e: ThreadEvent): void;
  title(title: string): void;
  activity(a: Activity): void;
  source(s: Source): void;
  text(delta: string): void;
  done(u: Usage): void;
  error(e: StreamError): void;
};

export type Model = { id: string; reasoning_efforts?: string[]; reasoning_effort_default?: string };

/** An HTTP error from the proxy before the stream started, such as 401 or 429 proxy_busy. */
export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function endpoint(path: string): { url: string; headers: Record<string, string> } {
  const { proxyUrl, apiKey } = getPreferenceValues<Preferences>();
  return {
    url: proxyUrl.replace(/\/+$/, "") + path,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  };
}

async function proxyError(res: Response): Promise<ProxyError> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    return new ProxyError(res.status, body.error?.code ?? "", body.error?.message ?? res.statusText);
  } catch {
    return new ProxyError(res.status, "", `${res.status} ${res.statusText}`);
  }
}

export async function fetchModels(): Promise<Model[]> {
  const { url, headers } = endpoint("/v1/models");
  const res = await fetch(url, { headers });
  if (!res.ok) throw await proxyError(res);
  const body = (await res.json()) as { data: Model[] };
  return body.data;
}

/**
 * Sends one question and calls a handler for each SSE event, in order.
 * Resolves when the stream ends. Abort the signal to cancel: the proxy then cancels the Kagi turn.
 */
export async function ask(req: AskRequest, on: AskHandlers, signal: AbortSignal): Promise<void> {
  const { url, headers } = endpoint("/v1/ask");
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(req), signal });
  if (!res.ok || !res.body) throw await proxyError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      dispatch(frame, on);
    }
  }
}

function dispatch(frame: string, on: AskHandlers) {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // keepalive comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return;
  const payload = JSON.parse(data.join("\n"));
  switch (event) {
    case "thread":
      return on.thread(payload);
    case "title":
      return on.title(payload.title);
    case "activity":
      return on.activity(payload);
    case "source":
      return on.source(payload);
    case "text":
      return on.text(payload.delta);
    case "done":
      return on.done(payload);
    case "error":
      return on.error(payload);
  }
}
