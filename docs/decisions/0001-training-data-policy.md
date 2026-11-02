# 0001 — What may train the judge

Status: accepted (2026-11-02)

## Context

Nightgate learns from the human's morning decisions: "this needed me" / "the agent could have decided".
Each decision is attached to an ask that an overnight agent wrote. Those agents are often Claude Code or
Codex running on Anthropic or OpenAI models, and both vendors' terms restrict using their outputs to
train other models:

- Anthropic Usage Policy: "Use outputs to train an AI model (e.g., "model scraping" or "model distillation")
  without prior authorization from Anthropic" is prohibited.
- OpenAI Terms of Use: you may not "use Output to develop models that compete with OpenAI".

Even when the label is the human's own, the input text of the example is still the vendor model's output.

## Decision

1. **Training rows** come only from cards whose `agent.model` is a Meta model (`muse*`, `llama*`, `meta*`).
   During the hackathon we run the overnight agents on the Meta Model API (Claude Code pointed at
   `api.meta.ai`), so these nights produce trainable rows.
2. **Cards from other vendors are evaluation only.** They measure the judge (did it miss a human decision?)
   but never shape its weights. `src/dataset.ts` enforces this; `splitDataset` reports how many rows were
   excluded and why.
3. **Asks marked `sensitive`** (customer data, secrets) are never trained on and are judged only by the local
   model; they never reach the remote Meta API.
4. About one in five trainable rows is held out by a stable hash so the evaluation stays honest.

## Consequences

- The first nights' Claude/Codex history is a ready evaluation set, not a training set.
- The training set grows only as fast as we run nights on Meta models. That is slower, and it is the price of
  staying inside every vendor's terms.
- Whether evaluation-only use of other vendors' outputs is acceptable is our reading of the terms, not a
  ruling. If that reading changes, delete those rows from `decisions.jsonl`; nothing else depends on them.
