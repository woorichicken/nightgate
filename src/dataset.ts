import { createHash } from 'node:crypto'
import type { Ask, Card } from './card.ts'
import { HUMAN_CATEGORIES, type CategoryId } from './categories.ts'
import { buildMessages, type Judgment } from './judge.ts'

// Human decisions are the training signal. The policy for which rows may be
// trained on lives in docs/decisions/0001-training-data-policy.md; this file
// is the code that enforces it.

export interface Decision {
    cardId: string
    askId: string
    decidedAt: string
    // What the human says is true.
    label: { human: boolean; category: CategoryId }
    // What Nightgate said before the human looked, for measuring agreement.
    judge: Pick<Judgment, 'verdict' | 'category' | 'decidedBy'> | null
    ask: Ask
    card: Pick<Card, 'project' | 'status' | 'summary'> & { agentModel: string }
    note?: string
}

// Only cards written by Meta models may become training data. Cards written by
// other vendors' models (Claude, GPT, …) are kept for evaluation only: their
// terms forbid using outputs to train other models.
const TRAINABLE_SOURCE = /^(muse|llama|meta)/i
// Roughly one in five trainable rows is held out so evaluation is honest.
const HOLDOUT_BYTE = 51

export type Exclusion = 'sensitive' | 'non_meta_source'

export function exclusionFor(decision: Decision): Exclusion | null {
    if (decision.ask.sensitive) return 'sensitive'
    if (!TRAINABLE_SOURCE.test(decision.card.agentModel)) return 'non_meta_source'
    return null
}

function heldOut(decision: Decision): boolean {
    const digest = createHash('sha256').update(`${decision.cardId}/${decision.askId}`).digest()
    return digest[0] < HOLDOUT_BYTE
}

// Later decisions on the same ask replace earlier ones (the human changed their mind).
export function latestDecisions(rows: Decision[]): Decision[] {
    const byKey = new Map<string, Decision>()
    for (const row of rows) byKey.set(`${row.cardId}/${row.askId}`, row)
    return [...byKey.values()]
}

function targetReason(label: Decision['label'], note?: string): string {
    if (note) return note
    if (!label.human) return 'No owner-only category applies; the agent can proceed with its recommendation.'
    const category = HUMAN_CATEGORIES.find((c) => c.id === label.category)
    return `This is ${category ? category.label.toLowerCase() : 'an owner decision'}, so the owner must decide.`
}

export function toTrainingExample(decision: Decision): { messages: { role: string; content: string }[] } {
    const card: Card = {
        version: 1,
        id: decision.cardId,
        project: decision.card.project,
        agent: { model: decision.card.agentModel },
        status: decision.card.status,
        summary: decision.card.summary,
        did: [],
        asks: [decision.ask]
    }
    const answer = JSON.stringify({
        human: decision.label.human,
        category: decision.label.human ? decision.label.category : 'none',
        confidence: 0.95,
        reason: targetReason(decision.label, decision.note)
    })
    return { messages: [...buildMessages(decision.ask, card), { role: 'assistant', content: answer }] }
}

export interface DatasetSplit {
    train: ReturnType<typeof toTrainingExample>[]
    eval: Decision[]
    summary: { decisions: number; train: number; eval: number; excluded: Record<Exclusion, number> }
}

export function splitDataset(rows: Decision[]): DatasetSplit {
    const decisions = latestDecisions(rows)
    const split: DatasetSplit = {
        train: [],
        eval: [],
        summary: { decisions: decisions.length, train: 0, eval: 0, excluded: { sensitive: 0, non_meta_source: 0 } }
    }
    for (const decision of decisions) {
        const exclusion = exclusionFor(decision)
        if (exclusion) split.summary.excluded[exclusion] += 1
        // Excluded rows still measure the judge; they just never shape its weights.
        if (exclusion || heldOut(decision)) split.eval.push(decision)
        else split.train.push(toTrainingExample(decision))
    }
    split.summary.train = split.train.length
    split.summary.eval = split.eval.length
    return split
}
