import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseCard, type Card } from './card.ts'
import type { Judgment } from './judge.ts'
import type { ClaimResult } from './verify.ts'
import type { Config } from './config.ts'

// Plain files on purpose: one machine, one person, and the files are easy to
// inspect, diff and hand to the training step.

export interface InvalidCard {
    file: string
    errors: string[]
}

export async function listCards(config: Config): Promise<{ cards: Card[]; invalid: InvalidCard[] }> {
    await mkdir(config.cardsDir, { recursive: true })
    const files = (await readdir(config.cardsDir)).filter((f) => f.endsWith('.json')).sort()
    const cards: Card[] = []
    const invalid: InvalidCard[] = []
    for (const file of files) {
        let raw: unknown
        try {
            raw = JSON.parse(await readFile(join(config.cardsDir, file), 'utf8'))
        } catch (error) {
            invalid.push({ file, errors: [`not JSON: ${error instanceof Error ? error.message : error}`] })
            continue
        }
        const result = parseCard(raw, basename(file, '.json'))
        if (result.ok) cards.push(result.card)
        else invalid.push({ file, errors: result.errors })
    }
    return { cards, invalid }
}

// What Nightgate concluded about one card: the judge's verdicts and the re-checked claims.
export interface Review {
    cardId: string
    judgments: Judgment[]
    claims: ClaimResult[]
    reviewedAt: string
}

function reviewFile(config: Config, cardId: string): string {
    // Card ids come from agent-written files; keep them inside the folder.
    return join(config.reviewsDir, `${cardId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export async function readReview(config: Config, cardId: string): Promise<Review | null> {
    try {
        return JSON.parse(await readFile(reviewFile(config, cardId), 'utf8')) as Review
    } catch {
        return null
    }
}

export async function writeReview(config: Config, review: Review): Promise<void> {
    await mkdir(config.reviewsDir, { recursive: true })
    await writeFile(reviewFile(config, review.cardId), JSON.stringify(review, null, 2))
}

export async function appendJsonl(file: string, row: unknown): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true })
    await appendFile(file, `${JSON.stringify(row)}\n`)
}

export async function readJsonl<T>(file: string): Promise<T[]> {
    let text: string
    try {
        text = await readFile(file, 'utf8')
    } catch {
        return []
    }
    return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T)
}
