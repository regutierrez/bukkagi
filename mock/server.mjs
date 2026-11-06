// Mock of the proxy's /v1/models and /v1/ask, following the README's event format.
// Questions containing "fail" end with an error event; "busy" returns 429 proxy_busy.
import http from "node:http";

const PORT = 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const models = [
  { id: "ki_quick", reasoning_efforts: [], reasoning_effort_default: "" },
  { id: "glm-5-3-flash", reasoning_efforts: ["low", "medium", "high", "max"], reasoning_effort_default: "max" },
];

const sources = [
  { n: 1, url: "https://en.wikipedia.org/wiki/Paris", title: "Paris - Wikipedia", snippet: "Paris is the capital and largest city of France, with an estimated population of 2,087,577 residents in January 2025." },
  { n: 2, url: "https://www.insee.fr/fr/statistiques/2011101?geo=COM-75056", title: "Populations légales 2023 - Paris", snippet: "Commune de Paris (75056): population municipale 2 087 577 habitants.", published_at: "2025-12-30" },
  { n: 3, url: "https://www.institutparisregion.fr/", title: "Île-de-France in figures 2026", snippet: "The Île-de-France region has 12.4 million inhabitants, about 18% of the population of metropolitan France." },
];

function answerFor(q, turn) {
  if (turn > 1) return `The Paris metropolitan area has about **13.2 million** people [[2]](${sources[1].url}). That makes it the largest urban area in the EU [[3]](${sources[2].url}).`;
  return `The city of Paris has about **2.09 million** residents [[1]](${sources[0].url}) [[2]](${sources[1].url}). The wider Île-de-France region has about **12.4 million** [[3]](${sources[2].url}).

| Area | Population | Source |
|---|---:|---|
| City of Paris | 2.09 M | [[2]](${sources[1].url}) |
| Île-de-France | 12.4 M | [[3]](${sources[2].url}) |

\`\`\`mermaid
flowchart TD
  P[City of Paris] --> R[Île-de-France]
\`\`\`

\`\`\`ts
const share = 2.09 / 12.4; // ≈ 0.17
\`\`\`

The city’s population has fallen slowly since 2011 [[2]](${sources[1].url}).`;
}

const turns = new Map(); // branch -> turn count

http
  .createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer mock") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key", type: "auth", code: "invalid_api_key" } }));
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: models }));
    }
    if (req.url !== "/v1/ask" || req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    let body = "";
    for await (const c of req) body += c;
    const q = JSON.parse(body);
    console.log("ask", JSON.stringify(q));
    if (q.query.includes("busy")) {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Another turn is running", type: "rate_limit", code: "proxy_busy" } }));
    }

    let closed = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        closed = true;
        console.log("client closed: cancel turn");
      }
    });
    const branch = q.branch ?? `branch-${Date.now()}`;
    const turn = (turns.get(branch) ?? 0) + 1;
    turns.set(branch, turn);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-kagi-thread": "conv-1" });
    const slow = q.query.includes("slow") ? 5 : 1;
    const send = async (event, data, wait = 0) => {
      if (closed) throw new Error("closed");
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (wait) await sleep(wait * slow);
    };
    try {
      await send("thread", { conversation: "conv-1", branch, turn: `turn-${turn}`, url: "https://assistant.kagi.com/chat/conv-1" });
      if (turn === 1) await send("title", { title: "Population of Paris" });
      const use = turn === 1 ? sources : [sources[1], sources[2]].map((s, i) => ({ ...s, n: i + 2 }));
      if (q.search !== false) {
        await send("activity", { id: "a1", type: "search", text: q.query, status: "running" }, 900);
        res.write(": keepalive\n\n");
        await send("activity", { id: "a1", type: "search", text: q.query, status: "completed" });
        await send("activity", { id: "a2", type: "search", text: "Paris population 2026 INSEE", status: "running" }, 600);
        for (const s of use) await send("source", s, 350);
        await send("activity", { id: "a2", type: "search", text: "Paris population 2026 INSEE", status: "completed" }, 300);
      } else {
        await send("activity", { id: "t1", type: "thinking", text: "Recalling census figures", status: "completed" }, 600);
      }
      const text = answerFor(q.query, turn);
      for (let i = 0; i < text.length; i += 6) await send("text", { delta: text.slice(i, i + 6) }, 25);
      if (q.query.includes("fail")) {
        await send("error", { type: "upstream_error", code: "kagi_stream_failed", message: "Kagi closed the stream unexpectedly." });
      } else {
        await send("done", { model: q.model || "ki_quick", input_tokens: 812, output_tokens: 214 });
      }
      res.end();
    } catch {
      /* client went away */
    }
  })
  .listen(PORT, () => console.log(`mock proxy on http://localhost:${PORT}`));
