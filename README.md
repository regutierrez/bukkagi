# Ask Kagi

A Raycast extension for web answers from Kagi Assistant, through the
[kagi-openai-proxy](https://github.com/regutierrez/kagi-openai-proxy) `POST /v1/ask` stream.
It shows search steps, sources and streamed answers, and supports follow-ups in the same Kagi thread.

## Install

Raycast cannot install extensions from GitHub, so install it as a development extension:

```bash
git clone git@github.com:regutierrez/raycast-ask-kagi.git
cd raycast-ask-kagi
npm install
npm run dev   # registers "Ask Kagi" in Raycast; Ctrl-C afterwards, the command stays
```

On first run, set **Proxy URL** (default `https://kagi.esquie.pael.dev`) and **Proxy API Key**.

To update: `git pull && npm install && npm run dev`.

## Keys

| Key | Action |
| --- | --- |
| ↵ | Ask (or follow up in the open thread) |
| ⌘↵ | Ask without web search |
| ⌘. | Stop the answer |
| ⌘R | Retry or regenerate |
| ⌥↑ / ⌥↓ | Jump to the previous or next question, skipping sources |
| ⌘F | Show the selected answer full width (Esc to go back) |
| ⌘N | New thread |
| ⌘P | Model and web search dropdown |
| ⌘E | Reasoning effort |

## Testing without Kagi

`node mock/server.mjs` starts a fake proxy on `http://localhost:8787` (API key `mock`).
Questions containing `fail`, `busy` or `slow` test the error, 429 and stop paths.
