# Nightgate

**Your coding agents work all night. In the morning, Nightgate shows you only the decisions that are yours.**

**Demo video (1.5 min):** [docs/demo.mp4](docs/demo.mp4)

Overnight agents leave a pile of "please decide" behind. On my first supervised night there were 16 such
asks; only 6 actually needed me. The rest were things the agent could have settled with its own
recommendation. Nightgate is the gate in between: every agent writes the same report card, a Meta model
judges each ask against six kinds of decision that belong to a human, claims like "tests pass" are
re-checked, and the morning page keeps only what is yours. Every "this needed me / it didn't" you click
becomes training data for the judge, which runs locally on a DGX Spark (a shared company machine in our case).

## How it works

```
 Mac mini (agents)                      DGX Spark (local, shared)            Meta Model API
 ─────────────────                      ───────────────────────              ──────────────
 CLI Manager terminals                  Muse Glimmer 30B (GGUF, Ollama)      Muse Spark
   │ each agent writes a report card       ▲ tier 1: every ask                  ▲ tier 2: only unsure,
   ▼                                       │ (sensitive asks stop here)         │ non-sensitive asks
 ~/.nightgate/cards/*.json ──▶ judge ──────┴────────────────────────────────────┘
                                │  rule floor first: git push, prod deploy, migrations, payments
                                ▼
                       morning page (console) ──▶ your decisions ──▶ dataset ──▶ LoRA on Glimmer
                                ▲                                     (Meta-written cards only)
                       live terminal screens from CLI Manager's Control API
```

- **Report card** (`prompts/agent-card.md`) — status, claims with re-runnable evidence, asks with a recommendation.
- **Judge** (`src/judge.ts`) — six human categories: hard to undo · goes outside · database · product direction ·
  customers · account/money. A model may add work for the human but never remove a rule hit. Every unsure path
  (low confidence, model down, unparseable reply) ends at "human". Asks without a recommendation go back to the agent.
- **Evidence re-check** (`src/verify.ts`) — HTTP status and file checks always; commands only from an allowlist and
  only when `NIGHTGATE_RERUN_COMMANDS=1`, because cards are written by agents.
- **Console** (`web/`, `src/server.ts`) — terminals, morning page and learning status on one page.
- **Learning loop** (`src/dataset.ts`, `train/train_lora.py`) — your labels become chat-format SFT rows for a LoRA on
  Glimmer. Only cards written by Meta models are trained on; see [the policy](docs/decisions/0001-training-data-policy.md).

## Why Meta models

- **Muse Glimmer** is an open-weight model built for local agents. The judge reads agent output that can contain
  customer data and internal plans; tier 1 runs on our own GPU and sensitive asks never leave it.
- **Muse Spark** through the Meta Model API is the second opinion for the asks Glimmer is unsure about.
- The weights are ours to adapt: the judge learns where *this* person draws the line, not a generic one.

## Measured so far (2026-11-02)

| What | Result |
|---|---|
| Glimmer on DGX Spark (GB10, 121 GB) | `Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf` (19.7 GB) via Ollama 0.32.14, 18,858 MiB GPU memory |
| Speed per ask | ~30 s with `Reasoning strength: low` · ~70 s at the default `high` · generation ~7 tok/s |
| Probe asks | 3/3 right at `low` (production migration → database · file rename → agent · hero copy → product) |
| Example night (2 cards, 6 asks) | 103 s · 4 for the human (2 by rule, 2 by Glimmer) · 2 handled · 1 failed claim caught |

Not done yet: the Meta Model API tier has not been called, the LoRA has not been trained, and the evaluation set
from real nights is not labelled yet.

## Quick start

Requires Node 22.18+ (TypeScript runs directly, no build step).

```bash
pnpm install                       # dev tools only (typescript, @types/node)
node src/cli.ts seed               # copy the example cards into ~/.nightgate/cards
node src/cli.ts review             # judge them (needs a Glimmer endpoint, see below)
node src/cli.ts serve              # console on http://127.0.0.1:4777
```

Serve Glimmer anywhere that speaks OpenAI Chat Completions, for example Ollama:

```bash
hf download meta-models/Muse-Glimmer-30B-GGUF Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf --local-dir ./glimmer
printf 'FROM ./glimmer/Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf\nPARAMETER num_ctx 16384\n' > Modelfile
OLLAMA_HOST=127.0.0.1:11435 ollama serve &
OLLAMA_HOST=127.0.0.1:11435 ollama create muse-glimmer -f Modelfile
```

| Variable | Default | Meaning |
|---|---|---|
| `NIGHTGATE_HOME` | `~/.nightgate` | cards, reviews, decisions, training files |
| `NIGHTGATE_LOCAL_URL` / `_MODEL` | `http://127.0.0.1:11435/v1` / `muse-glimmer` | tier 1 (`off` to disable) |
| `META_API_KEY` | — | enables tier 2 (`https://api.meta.ai/v1`, `muse-spark-1.3`) |
| `NIGHTGATE_HOST` / `_PORT` | `127.0.0.1` / `4777` | console address; a non-loopback host requires `NIGHTGATE_TOKEN` |
| `NIGHTGATE_RERUN_COMMANDS` | off | `1` re-runs allowlisted evidence commands |
| `CLIM_URL` / `CLIM_TOKEN` | discovery file | CLI Manager AI Control API (read-only use) |

Open the console from another device with `http://<host>:4777/#token=<NIGHTGATE_TOKEN>`.

## What is new here

Everything in this repository was written during the hackathon (from 2026-11-02). Nightgate does not launch or
drive agents. It only **reads** sessions from [CLI Manager](https://github.com/woorichicken/CLI_manager), an existing
open-source app, through its documented local API — the same way it would read any other tool's API.

## Tests

```bash
pnpm test        # node --test, no model needed (models are faked)
pnpm typecheck
```

## License

MIT
