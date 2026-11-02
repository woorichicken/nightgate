import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Read-only client for CLI Manager's AI Control API (local REST, token required).
// Nightgate does not launch or drive agents itself; it only watches the terminals
// CLI Manager already shows, so the console can put a screen next to each card.
// API contract: https://github.com/woorichicken/CLI_manager/blob/main/docs/architecture/control-api.md

export interface ClimSession {
    id: string
    name: string
    state: string
    awaitingInput: boolean
    command?: string
    cwd?: string
    workspaceName?: string
}

interface Discovery {
    url: string
    token: string
}

const DISCOVERY_FILE = join(homedir(), '.climanager', 'control-api.json')
const REQUEST_TIMEOUT_MS = 5_000

async function discover(env: NodeJS.ProcessEnv): Promise<Discovery | null> {
    if (env.CLIM_URL && env.CLIM_TOKEN) return { url: env.CLIM_URL.replace(/\/$/, ''), token: env.CLIM_TOKEN }
    try {
        const data = JSON.parse(await readFile(DISCOVERY_FILE, 'utf8')) as Partial<Discovery>
        return data.url && data.token ? { url: data.url.replace(/\/$/, ''), token: data.token } : null
    } catch {
        return null
    }
}

export class ClimUnavailable extends Error {}

async function get<T>(path: string, env: NodeJS.ProcessEnv): Promise<T> {
    const found = await discover(env)
    if (!found) throw new ClimUnavailable('CLI Manager AI Control API is off (no discovery file, no CLIM_URL/CLIM_TOKEN)')
    let response: Response
    try {
        response = await fetch(found.url + path, {
            headers: { Authorization: `Bearer ${found.token}`, 'X-Client-Name': 'nightgate' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
    } catch (error) {
        throw new ClimUnavailable(`cannot reach CLI Manager at ${found.url}: ${error instanceof Error ? error.message : error}`)
    }
    if (!response.ok) throw new Error(`CLI Manager ${response.status} on ${path}`)
    return (await response.json()) as T
}

export async function listSessions(env: NodeJS.ProcessEnv = process.env): Promise<ClimSession[]> {
    // Current app versions return a bare array; accept a wrapped list too.
    const payload = await get<ClimSession[] | { sessions: ClimSession[] }>('/v1/sessions', env)
    const sessions = Array.isArray(payload) ? payload : payload.sessions
    // Pass on only what the console shows; session memos can hold private notes.
    return sessions.map(({ id, name, state, awaitingInput, command, cwd, workspaceName }) => ({
        id,
        name,
        state,
        awaitingInput,
        command,
        cwd,
        workspaceName
    }))
}

export async function readScreen(id: string, lines: number, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const payload = await get<{ lines: string[] }>(`/v1/sessions/${encodeURIComponent(id)}/output?lines=${lines}`, env)
    return payload.lines
}
