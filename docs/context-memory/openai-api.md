# OpenAI API in cloud sessions

Pi, OpenCode and DSH reach OpenAI's official API from a Claude Code cloud
session on the maintainer's API key. The key never enters the VM. It is stored
as a network secret, and the agent proxy attaches it to requests for
`api.openai.com/v1/` after they leave the session; each host holds only a
placeholder. This replaced the ChatGPT Codex subscription on 2026-10-29.

Agents never ask for the key in chat, and never print, log or commit it.

## How the pieces fit

| Piece | Where | Contents |
| --- | --- | --- |
| Network secret | Environment settings, Network secrets | Host `api.openai.com`, path prefix `/v1/`, header `Authorization`, prefix `Bearer`, value: the key alone |
| Placeholder | The environment of each command that needs it | `OPENAI_API_KEY=proxy-injected`. No host sends a request without a non-empty key; the proxy replaces the whole `Authorization` header |

The placeholder is not a session-wide environment variable. Upstream's vitest
suite turns on end-to-end tests when it finds a provider key, and behind this
secret they would reach the paid API. The preview bench sets the placeholder
itself for `--provider openai`.

A project of its own on the OpenAI platform, with its own key and a budget,
keeps a runaway run bounded. Secrets cannot be edited: to rotate, delete the
secret and add a new one. A running session picks up the change without
restarting.

## Verify

No model runs:

```sh
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models
```

`200` means the secret is attached. `000`, with the proxy status listing a 403
for `api.openai.com`, means no secret covers the path. `401` means the
secret's value is not the key, or carries a second `Bearer`.

Then one request per host, each from an empty directory, Pi's after
`node scripts/context-memory-ops.mjs build`. On 2026-10-29 each answered `OK`
and exited 0:

```sh
OPENAI_API_KEY=proxy-injected node "$REPO/packages/coding-agent/dist/bundle/cli.js" \
  -p "Reply with exactly: OK" --model openai/gpt-6-luna --thinking low --no-session --no-extensions
```

```sh
OPENAI_API_KEY=proxy-injected opencode run -m openai/gpt-6-luna "Reply with exactly: OK"
```

```sh
OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 dsh --profile headless "Reply with exactly: OK"
```

Run OpenCode with its own `HOME` and `XDG_*` directories, and DSH with its own
`DSH_HOME`, so that neither reads or changes an everyday installation.

## Hosts

| Host | Wiring | GPT-6 Luna as the host sees it |
| --- | --- | --- |
| Pi | Reads `OPENAI_API_KEY`; model `openai/gpt-6-luna`. Preview bench: `--provider openai` | 272,000 context, 128,000 output |
| OpenCode 1.19.4 | Reads `OPENAI_API_KEY`; model `openai/gpt-6-luna` | 1,050,000 context, 922,000 input, 128,000 output, from models.dev |
| DSH 0.2.1-rc.3 | `@deepseek-ai/dsh-llm-pi-ai` resolves the key, and the default model points at it (below) | 272,000 context, 128,000 output, from its bundled `pi-ai` 1.4.0 |

DSH's `headless` profile mounts `dsh-llm-pi-ai` with no routes and starts
agents on `deepseek-official/deepseek-flash`. In that profile's
`cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
- id: agent-default-model
  config:
    provider: openai
    model: gpt-6-luna
```

Without the key DSH stops before any request with `MISSING_CREDENTIAL` for
route `openai`, which also confirms it is not falling back to DeepSeek, whose
key the proxy supplies as well.

## The 272,000-token line

OpenAI bills a GPT-6 Luna request whose input exceeds 272,000 tokens at the
long-context rate for the whole request: twice the input and cache prices and
1.5 times the output price, by Pi's catalog. Pi and DSH cap Luna's window at
that line. OpenCode does not: without a `limit.input` of its own it compacts
far past the line, near its 922,000-token input limit. Keep measured requests below 272,000 input
tokens on every host, and size capacity profiles from that line rather than
from the model's full window ([capacity profiles](context-pressure.md)).

## Rate limit

On 2026-11-01 the maintainer's organization allowed GPT-6 Luna 2,000,000 tokens per
minute. Every request counts its whole context, cached tokens included, so two
sessions near 220,000 tokens that each send a request every few seconds pass the
limit within a minute. OpenAI then ends the turn with a rate-limit error inside a
successful stream, and Pi does not retry it. Run long sessions one at a time, or
space their requests so that their contexts sum to less than the limit each minute.

## Prompt cache

Pi's OpenAI provider sends the session's ID as `prompt_cache_key`, and the
preview's session writer sends the same ID. Luna's cache runs in OpenAI's
implicit mode with a 30-minute lifetime: a request that names no lifetime gets
`ttl: "30m"` from the server, and `PI_CACHE_RETENTION=long` asks for the same
30 minutes explicitly. Pi never asks for the 12-hour lifetime, which is priced
apart. Checked on 2026-10-29 from the `prompt_cache_options` OpenAI echoes.

The implicit cache serves a request only when it continues an earlier request:
the same items, then more. Two requests that share a long opening and differ
after it do not share a cache; on 2026-10-29 the second of two such requests
wrote all 5,101 shared tokens again. A compaction reads the session's cache
because the writer's request is the session's last request with the closing
instruction added, and only when the system prompt sits where the session's
own requests put it. Pi 1.4.0 records the system prompt in the transcript; in
a session begun before 1.4.0 its first record sits mid-history and Pi sends no
leading prompt. A writer that added one at the head read nothing: on a 150,000
token session the writer read 0 tokens before the fix and 150,145 after it,
at a quarter of the cost.

The preview bench measures this with `--cache session`, which runs each cut's
warm-up turn on the session itself, so that the writer continues it as a
session's last turn. `--cache warm` warms a copy and suits providers that
match any shared prefix, such as DeepSeek; with Luna it reads nothing.

Neither OpenCode's nor DSH's own compaction reads the session's cache.
OpenCode sends the conversation as one rewritten text and DSH replays it with
the system prompt first, so on 2026-10-29 each of their summary requests wrote
its 126,000 to 195,000 tokens to the cache again.

Catalog prices are estimates, not invoices; usage and cache reads come from
OpenAI's own counts.

## Host runs

`scripts/context-memory-host-run.mjs` takes the official OpenCode 1.19.4 or
DSH 0.2.1-rc.3 through fixture P5 with the Slice retrieval plugin and the
capacity profile of a 200k or 272k route. The user pastes every command's
output and the host's own model replies, so native compaction runs at the
profile's line: 150,000 or 204,000 tokens. After two compactions the run asks
P5's questions in one message, then four exact log timestamps from early
outputs, which native summaries rarely keep: those come back through
`context_history` or stay unknown. A message that would bring a request to
262,000 tokens is not sent; when a compaction is due first, a short `Status?`
lets it run.

```sh
npm install --prefix "$OPENCODE_STOCK" --save-exact --ignore-scripts --no-audit --no-fund opencode-ai@1.19.4
npm install --prefix "$DSH_STOCK" --save-exact --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.3
node scripts/context-memory-adapters-check.mjs
node --experimental-strip-types scripts/context-memory-host-run.mjs \
  --host opencode --route 200k --provider loopback \
  --host-root "$OPENCODE_STOCK" --package-dir .artifacts/host-adapters/opencode \
  --output-dir "$OUT"
```

`--provider loopback` answers from a local stand-in for the Responses API and
spends nothing; it checks the wiring, not the model. `--provider openai` needs
`--max-requests`, `--max-minutes` and `--max-cost-usd`, approved by the
maintainer before the first request; the request and cost limits also hold
inside a turn, checked every five seconds against the usage the host has
reported, so a call already in flight can still finish above them. Neither
host records usage for the call an abort cuts off. The script gives each run
its own `HOME` and XDG directories or `DSH_HOME` under the output directory.
`report.json` holds each model call's usage, the compactions with their
pauses, the retrieval calls and both scores; `turns.jsonl` holds the replies.
