import type { Ask, Card } from './card.ts'
import { HUMAN_CATEGORIES, isCategoryId, type CategoryId } from './categories.ts'
import { chatCompletion, type ChatFn, type ChatMessage, type ModelEndpoint } from './model.ts'

// The judge decides, per ask, whether the human must see it in the morning.
// Design goal: never miss a human decision. Every unsure path ends in "human".
//
//   rule floor ──hit──▶ human (no model call)
//        │ miss
//   local model (Muse Glimmer on our own box)
//        │ human ──────────────▶ human  (a model may add work for the human, never remove it)
//        │ agent, confident ───▶ agent
//        │ agent, unsure / error
//   remote model (Muse Spark via Meta API) — skipped for sensitive asks
//        │ answer ─────────────▶ that answer
//        │ error / not allowed ▶ human

export type Verdict = 'human' | 'agent' | 'sent_back'
export type DecidedBy = 'rule' | 'local' | 'remote' | 'fallback'

export interface TierTrace {
    endpoint: string
    category?: CategoryId
    confidence?: number
    error?: string
}

export interface Judgment {
    cardId: string
    askId: string
    verdict: Verdict
    category: CategoryId
    confidence: number
    reason: string
    decidedBy: DecidedBy
    missingRecommendation: boolean
    tiers: TierTrace[]
    judgedAt: string
}

export interface JudgeOptions {
    local?: ModelEndpoint
    remote?: ModelEndpoint
    // Below this, an "agent may proceed" answer from the local model is escalated.
    confidenceFloor?: number
    reasoning?: ReasoningStrength
    chat?: ChatFn
    now?: () => Date
}

const DEFAULT_CONFIDENCE_FLOOR = 0.75

// Narrow on purpose: these are phrases where being wrong is expensive.
// Broad words ("delete", "change") would flood the morning page.
const RULES: { category: CategoryId; pattern: RegExp }[] = [
    { category: 'external_publish', pattern: /\bgit push\b|\bpush (to )?(origin|main|master)\b|푸시/i },
    { category: 'external_publish', pattern: /\b(deploy|release|promote)\b[^.\n]{0,40}\b(prod|production)\b|프로덕션|운영\s*배포/i },
    { category: 'irreversible', pattern: /force[- ]?push|reset --hard|\brm -rf\b|drop (database|schema)/i },
    { category: 'db_schema_data', pattern: /\bmigrations?\b|\b(alter|drop|truncate) table\b|마이그레이션|운영\s*(DB|데이터)/i },
    { category: 'account_risk', pattern: /\b(payment|billing|credit card|paid plan)\b|결제|유료\s*플랜/i }
]

export function ruleHit(ask: Ask): CategoryId | null {
    const haystack = `${ask.question}\n${ask.recommendation}\n${ask.context ?? ''}`
    return RULES.find((rule) => rule.pattern.test(haystack))?.category ?? null
}

export type ReasoningStrength = 'low' | 'medium' | 'high'

// Muse Glimmer always reasons first; its chat template reads this line from the
// system prompt. On a DGX Spark (GB10, Q4_K_XL GGUF via Ollama) "low" took ~30 s
// per ask and "high" (the default) ~70 s, with the same answers on our probes.
export const DEFAULT_REASONING: ReasoningStrength = 'low'

export function buildMessages(ask: Ask, card: Card, reasoning: ReasoningStrength = DEFAULT_REASONING): ChatMessage[] {
    const categories = HUMAN_CATEGORIES.map((c) => `- ${c.id}: ${c.label} (${c.hint})`).join('\n')
    const system = [
        `Reasoning strength: ${reasoning}.`,
        'You triage questions that an overnight coding agent left for its human owner.',
        'Decide whether the owner must personally decide this ask, or whether the agent may go ahead with its own recommendation.',
        'The owner must decide ONLY if the ask falls into one of these categories:',
        categories,
        'If none fits, use category "none". Questions about code style, refactoring, test strategy or file layout inside the repo are usually "none".',
        'Reply with JSON only, no prose:',
        '{"human": true|false, "category": "<one id above or none>", "confidence": <0..1>, "reason": "<one sentence>"}'
    ].join('\n')
    const user = [
        card.project ? `Project: ${card.project}` : null,
        `Agent status: ${card.status}`,
        card.summary ? `Agent summary: ${card.summary}` : null,
        `Ask: ${ask.question}`,
        `Agent recommendation: ${ask.recommendation || '(none given)'}`,
        ask.context ? `Context: ${ask.context}` : null
    ]
        .filter(Boolean)
        .join('\n')
    return [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ]
}

export interface ModelVerdict {
    human: boolean
    category: CategoryId
    confidence: number
    reason: string
}

// Models wrap JSON in prose or code fences now and then; take the outermost object.
export function parseVerdict(content: string): ModelVerdict | null {
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    let raw: unknown
    try {
        raw = JSON.parse(content.slice(start, end + 1))
    } catch {
        return null
    }
    if (typeof raw !== 'object' || raw === null) return null
    const value = raw as Record<string, unknown>
    if (!isCategoryId(value.category)) return null
    const confidence = typeof value.confidence === 'number' ? Math.min(1, Math.max(0, value.confidence)) : 0
    // If the two fields disagree, the safer reading wins.
    const human = value.human === true || value.category !== 'none'
    return {
        human,
        category: value.category,
        confidence,
        reason: typeof value.reason === 'string' ? value.reason.trim() : ''
    }
}

async function askTier(
    endpoint: ModelEndpoint,
    messages: ChatMessage[],
    chat: ChatFn,
    tiers: TierTrace[]
): Promise<ModelVerdict | null> {
    try {
        const verdict = parseVerdict(await chat(endpoint, messages))
        if (!verdict) {
            tiers.push({ endpoint: endpoint.name, error: 'unparseable reply' })
            return null
        }
        tiers.push({ endpoint: endpoint.name, category: verdict.category, confidence: verdict.confidence })
        return verdict
    } catch (error) {
        tiers.push({ endpoint: endpoint.name, error: error instanceof Error ? error.message : String(error) })
        return null
    }
}

export async function judgeAsk(ask: Ask, card: Card, options: JudgeOptions): Promise<Judgment> {
    const chat = options.chat ?? ((endpoint, messages) => chatCompletion(endpoint, messages))
    const floor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
    const tiers: TierTrace[] = []
    const missingRecommendation = ask.recommendation === ''

    const finish = (
        verdict: 'human' | 'agent',
        category: CategoryId,
        confidence: number,
        reason: string,
        decidedBy: DecidedBy
    ): Judgment => ({
        cardId: card.id,
        askId: ask.id,
        // An ask the agent could settle alone but left without a recommendation goes
        // back to the agent, not to the human.
        verdict: verdict === 'agent' && missingRecommendation ? 'sent_back' : verdict,
        category,
        confidence,
        reason,
        decidedBy,
        missingRecommendation,
        tiers,
        judgedAt: (options.now?.() ?? new Date()).toISOString()
    })

    const ruleCategory = ruleHit(ask)
    if (ruleCategory) return finish('human', ruleCategory, 1, `matched the ${ruleCategory} safety rule`, 'rule')

    const messages = buildMessages(ask, card, options.reasoning)
    const remoteAllowed = Boolean(options.remote) && ask.sensitive !== true

    const local = options.local ? await askTier(options.local, messages, chat, tiers) : null
    if (local?.human) return finish('human', local.category, local.confidence, local.reason, 'local')
    if (local && local.confidence >= floor) return finish('agent', 'none', local.confidence, local.reason, 'local')

    if (remoteAllowed && options.remote) {
        const remote = await askTier(options.remote, messages, chat, tiers)
        if (remote) {
            return finish(remote.human ? 'human' : 'agent', remote.category, remote.confidence, remote.reason, 'remote')
        }
    }

    const why = local
        ? `local model unsure (${local.confidence.toFixed(2)} < ${floor}) and no remote check`
        : 'no model answered'
    return finish('human', local?.category ?? 'none', local?.confidence ?? 0, `${why}; defaulting to human`, 'fallback')
}

export async function judgeCard(card: Card, options: JudgeOptions): Promise<Judgment[]> {
    const judgments: Judgment[] = []
    // Sequential: the local box serves one request at a time anyway.
    for (const ask of card.asks) judgments.push(await judgeAsk(ask, card, options))
    return judgments
}
