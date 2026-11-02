// A report card is the one shape every overnight agent writes when it stops.
// Agents write it as JSON to $NIGHTGATE_HOME/cards/<id>.json (see prompts/agent-card.md).
// We read files instead of scraping the terminal: screen lines wrap at the
// terminal width, so JSON printed to a terminal does not survive the trip.

export type CardStatus = 'done' | 'partial' | 'blocked'

export type Evidence =
    | { kind: 'command'; cmd: string; cwd?: string; expectExit?: number }
    | { kind: 'http'; url: string; expectStatus?: number }
    | { kind: 'file'; path: string }

export interface Claim {
    what: string
    evidence: Evidence[]
}

export interface Ask {
    id: string
    question: string
    recommendation: string
    context?: string
    // Sensitive asks (customer data, secrets) are judged by the local model only.
    sensitive?: boolean
}

export interface Card {
    version: 1
    id: string
    project?: string
    session?: { id?: string; name?: string }
    // Which model produced this card. Decides whether it may become training data
    // (docs/decisions/0001-training-data-policy.md).
    agent: { harness?: string; model: string }
    status: CardStatus
    summary: string
    did: Claim[]
    asks: Ask[]
    writtenAt?: string
}

export type ParseResult = { ok: true; card: Card } | { ok: false; errors: string[] }

const STATUSES: readonly CardStatus[] = ['done', 'partial', 'blocked']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function parseEvidence(raw: unknown, where: string, errors: string[]): Evidence | null {
    if (!isRecord(raw)) {
        errors.push(`${where}: evidence must be an object`)
        return null
    }
    if (raw.kind === 'command' && text(raw.cmd)) {
        return {
            kind: 'command',
            cmd: text(raw.cmd),
            ...(text(raw.cwd) ? { cwd: text(raw.cwd) } : {}),
            ...(typeof raw.expectExit === 'number' ? { expectExit: raw.expectExit } : {})
        }
    }
    if (raw.kind === 'http' && text(raw.url)) {
        return {
            kind: 'http',
            url: text(raw.url),
            ...(typeof raw.expectStatus === 'number' ? { expectStatus: raw.expectStatus } : {})
        }
    }
    if (raw.kind === 'file' && text(raw.path)) {
        return { kind: 'file', path: text(raw.path) }
    }
    errors.push(`${where}: unknown evidence ${JSON.stringify(raw).slice(0, 80)}`)
    return null
}

// fallbackId is the file name, so a card without an id still has a stable key.
export function parseCard(raw: unknown, fallbackId: string): ParseResult {
    const errors: string[] = []
    if (!isRecord(raw)) return { ok: false, errors: ['card must be a JSON object'] }

    const agent = isRecord(raw.agent) ? raw.agent : {}
    const model = text(agent.model)
    if (!model) errors.push('agent.model is required (which model wrote this card?)')

    const status = text(raw.status) as CardStatus
    if (!STATUSES.includes(status)) errors.push(`status must be one of ${STATUSES.join('|')}`)

    const did: Claim[] = []
    const rawDid = Array.isArray(raw.did) ? raw.did : []
    rawDid.forEach((item, i) => {
        if (!isRecord(item) || !text(item.what)) {
            errors.push(`did[${i}].what is required`)
            return
        }
        const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
            .map((e, j) => parseEvidence(e, `did[${i}].evidence[${j}]`, errors))
            .filter((e): e is Evidence => e !== null)
        did.push({ what: text(item.what), evidence })
    })

    const asks: Ask[] = []
    const rawAsks = Array.isArray(raw.asks) ? raw.asks : []
    rawAsks.forEach((item, i) => {
        if (!isRecord(item) || !text(item.question)) {
            errors.push(`asks[${i}].question is required`)
            return
        }
        asks.push({
            id: text(item.id) || `a${i + 1}`,
            question: text(item.question),
            // An empty recommendation is allowed here on purpose: the judge sends
            // such asks back to the agent instead of waking the human.
            recommendation: text(item.recommendation),
            ...(text(item.context) ? { context: text(item.context) } : {}),
            ...(item.sensitive === true ? { sensitive: true } : {})
        })
    })

    if (errors.length > 0) return { ok: false, errors }

    const session = isRecord(raw.session) ? raw.session : null
    return {
        ok: true,
        card: {
            version: 1,
            id: text(raw.id) || fallbackId,
            ...(text(raw.project) ? { project: text(raw.project) } : {}),
            ...(session ? { session: { id: text(session.id) || undefined, name: text(session.name) || undefined } } : {}),
            agent: { model, ...(text(agent.harness) ? { harness: text(agent.harness) } : {}) },
            status,
            summary: text(raw.summary),
            did,
            asks,
            ...(text(raw.writtenAt) ? { writtenAt: text(raw.writtenAt) } : {})
        }
    }
}
