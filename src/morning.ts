import type { Card } from './card.ts'
import type { CategoryId } from './categories.ts'
import { judgeCard, type DecidedBy, type JudgeOptions } from './judge.ts'
import type { Review } from './store.ts'
import { verifyClaim, type VerifyOptions } from './verify.ts'

// The morning page: only what the human must decide, everything else folded
// into counts. This is the whole point of Nightgate.

export async function reviewCard(card: Card, judge: JudgeOptions, verify: VerifyOptions): Promise<Review> {
    const judgments = await judgeCard(card, judge)
    const claims = []
    for (const claim of card.did) claims.push(await verifyClaim(claim, verify))
    return { cardId: card.id, judgments, claims, reviewedAt: new Date().toISOString() }
}

export interface MorningItem {
    cardId: string
    askId: string
    project?: string
    sessionId?: string
    sessionName?: string
    agentModel: string
    question: string
    recommendation: string
    category: CategoryId
    reason: string
    decidedBy: DecidedBy
    confidence: number
    missingRecommendation: boolean
}

export interface FailedClaim {
    cardId: string
    project?: string
    what: string
    detail: string
}

export interface MorningPage {
    cards: number
    blockedCards: string[]
    human: MorningItem[]
    sentBack: MorningItem[]
    // Folded on the page, but listed so the human can flag a miss ("this was mine").
    handled: MorningItem[]
    unreviewedCards: string[]
    claims: { verified: number; failed: number; unchecked: number }
    failedClaims: FailedClaim[]
}

export function buildMorning(cards: Card[], reviews: Map<string, Review>): MorningPage {
    const page: MorningPage = {
        cards: cards.length,
        blockedCards: cards.filter((c) => c.status === 'blocked').map((c) => c.id),
        human: [],
        sentBack: [],
        handled: [],
        unreviewedCards: [],
        claims: { verified: 0, failed: 0, unchecked: 0 },
        failedClaims: []
    }

    for (const card of cards) {
        const review = reviews.get(card.id)
        if (!review) {
            page.unreviewedCards.push(card.id)
            continue
        }
        for (const judgment of review.judgments) {
            const ask = card.asks.find((a) => a.id === judgment.askId)
            if (!ask) continue
            const item: MorningItem = {
                cardId: card.id,
                askId: ask.id,
                project: card.project,
                sessionId: card.session?.id,
                sessionName: card.session?.name,
                agentModel: card.agent.model,
                question: ask.question,
                recommendation: ask.recommendation,
                category: judgment.category,
                reason: judgment.reason,
                decidedBy: judgment.decidedBy,
                confidence: judgment.confidence,
                missingRecommendation: judgment.missingRecommendation
            }
            if (judgment.verdict === 'human') page.human.push(item)
            else if (judgment.verdict === 'sent_back') page.sentBack.push(item)
            else page.handled.push(item)
        }
        for (const claim of review.claims) {
            page.claims[claim.state] += 1
            if (claim.state === 'failed') {
                const detail = claim.checks.find((c) => c.state === 'failed')?.detail ?? ''
                page.failedClaims.push({ cardId: card.id, project: card.project, what: claim.what, detail })
            }
        }
    }
    return page
}
