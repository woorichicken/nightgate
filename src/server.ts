import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { isCategoryId } from './categories.ts'
import { ClimUnavailable, listSessions, readScreen } from './clim.ts'
import type { Config } from './config.ts'
import { latestDecisions, splitDataset, type Decision } from './dataset.ts'
import { buildMorning, reviewCard, type MorningItem } from './morning.ts'
import { appendJsonl, listCards, readJsonl, readReview, writeReview, type Review } from './store.ts'

// The console: one page that puts the live CLI Manager terminals, the morning
// page and the training status side by side. It runs on the box that runs the
// agents (a Mac mini for us) and is viewed from any browser on the tailnet.

const WEB_DIR = join(import.meta.dirname, '..', 'web')
const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const MAX_SCREEN_LINES = 200
const MAX_BODY_BYTES = 64 * 1024

interface ReviewProgress {
    running: boolean
    done: number
    total: number
    current?: string
    error?: string
}

function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_BODY_BYTES) throw new Error('body too large')
        chunks.push(chunk as Buffer)
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function isLoopback(host: string): boolean {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function startServer(config: Config) {
    // The API exposes terminal screens. Never serve it beyond this machine without a token.
    if (!isLoopback(config.host) && !config.token) {
        throw new Error(`NIGHTGATE_HOST=${config.host} needs NIGHTGATE_TOKEN (the console shows terminal screens)`)
    }

    const progress: ReviewProgress = { running: false, done: 0, total: 0 }

    async function loadReviews(cardIds: string[]): Promise<Map<string, Review>> {
        const reviews = new Map<string, Review>()
        for (const id of cardIds) {
            const review = await readReview(config, id)
            if (review) reviews.set(id, review)
        }
        return reviews
    }

    async function runReviews(force: boolean): Promise<void> {
        const { cards } = await listCards(config)
        const reviews = await loadReviews(cards.map((c) => c.id))
        const todo = force ? cards : cards.filter((c) => !reviews.has(c.id))
        Object.assign(progress, { running: true, done: 0, total: todo.length, current: undefined, error: undefined })
        try {
            for (const card of todo) {
                progress.current = card.id
                const review = await reviewCard(
                    card,
                    { local: config.local, remote: config.remote },
                    { rerunCommands: config.rerunCommands }
                )
                await writeReview(config, review)
                progress.done += 1
            }
        } catch (error) {
            progress.error = error instanceof Error ? error.message : String(error)
        } finally {
            progress.running = false
            progress.current = undefined
        }
    }

    async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
            try {
                return send(res, 200, { available: true, sessions: await listSessions() })
            } catch (error) {
                if (error instanceof ClimUnavailable) return send(res, 200, { available: false, error: error.message })
                throw error
            }
        }

        const screen = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/screen$/)
        if (req.method === 'GET' && screen) {
            const lines = Math.min(MAX_SCREEN_LINES, Number(url.searchParams.get('lines') || 80))
            return send(res, 200, { lines: await readScreen(screen[1], lines) })
        }

        if (req.method === 'GET' && url.pathname === '/api/morning') {
            const { cards, invalid } = await listCards(config)
            const page = buildMorning(cards, await loadReviews(cards.map((c) => c.id)))
            // Show which asks the human already labelled, so a reload does not ask twice.
            const labels = new Map(
                latestDecisions(await readJsonl<Decision>(config.decisionsFile)).map((d) => [`${d.cardId}/${d.askId}`, d.label.human])
            )
            const withLabel = (items: MorningItem[]) => items.map((item) => ({ ...item, humanLabel: labels.get(`${item.cardId}/${item.askId}`) }))
            return send(res, 200, {
                page: { ...page, human: withLabel(page.human), sentBack: withLabel(page.sentBack), handled: withLabel(page.handled) },
                invalid,
                review: progress
            })
        }

        if (req.method === 'POST' && url.pathname === '/api/review') {
            if (progress.running) return send(res, 409, { error: 'a review is already running', review: progress })
            const body = (await readBody(req)) as { force?: boolean }
            void runReviews(body.force === true)
            return send(res, 202, { review: progress })
        }

        if (req.method === 'POST' && url.pathname === '/api/decisions') {
            const body = (await readBody(req)) as Record<string, unknown>
            const human = body.human === true
            const category = human ? body.category : 'none'
            if (typeof body.cardId !== 'string' || typeof body.askId !== 'string' || !isCategoryId(category)) {
                return send(res, 400, { error: 'need cardId, askId, human and (when human) a category' })
            }
            const { cards } = await listCards(config)
            const card = cards.find((c) => c.id === body.cardId)
            const ask = card?.asks.find((a) => a.id === body.askId)
            if (!card || !ask) return send(res, 404, { error: 'unknown card or ask' })
            const judgment = (await readReview(config, card.id))?.judgments.find((j) => j.askId === ask.id)
            const decision: Decision = {
                cardId: card.id,
                askId: ask.id,
                decidedAt: new Date().toISOString(),
                label: { human, category },
                judge: judgment
                    ? { verdict: judgment.verdict, category: judgment.category, decidedBy: judgment.decidedBy }
                    : null,
                ask,
                card: { project: card.project, status: card.status, summary: card.summary, agentModel: card.agent.model },
                ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {})
            }
            await appendJsonl(config.decisionsFile, decision)
            return send(res, 201, { decision })
        }

        if (req.method === 'GET' && url.pathname === '/api/training') {
            const split = splitDataset(await readJsonl<Decision>(config.decisionsFile))
            const readOptional = async (name: string) => {
                try {
                    return JSON.parse(await readFile(join(config.trainingDir, name), 'utf8')) as unknown
                } catch {
                    return null
                }
            }
            return send(res, 200, {
                dataset: split.summary,
                lastEval: await readOptional('eval-latest.json'),
                lastRun: await readOptional('run-latest.json'),
                models: { local: config.local?.model ?? null, remote: config.remote?.model ?? null }
            })
        }

        return send(res, 404, { error: 'not found' })
    }

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://nightgate.local')
        try {
            if (req.method === 'GET' && STATIC[url.pathname]) {
                const file = STATIC[url.pathname]
                res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/plain' })
                return res.end(await readFile(join(WEB_DIR, file)))
            }
            if (url.pathname.startsWith('/api/')) {
                if (config.token && req.headers.authorization !== `Bearer ${config.token}`) {
                    return send(res, 401, { error: 'token required' })
                }
                return await handleApi(req, res, url)
            }
            send(res, 404, { error: 'not found' })
        } catch (error) {
            send(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    })

    server.listen(config.port, config.host)
    return server
}
