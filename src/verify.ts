import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { Claim, Evidence } from './card.ts'

// "Tests pass" and "deploy returns 200" are claims until we re-check them.
// Commands come from agent-written cards, so re-running them is off by default
// and limited to an allowlist of read-only or test commands without shell tricks.

export type CheckState = 'verified' | 'failed' | 'skipped'

export interface CheckResult {
    evidence: Evidence
    state: CheckState
    detail: string
}

export interface ClaimResult {
    what: string
    state: 'verified' | 'failed' | 'unchecked'
    checks: CheckResult[]
}

const ALLOWED_COMMANDS: RegExp[] = [
    /^(pnpm|npm|yarn) (run )?(test|typecheck|lint|build)( [\w:./=-]+)*$/,
    /^git (status|log|diff|show)( [\w:./=@~^-]+)*$/,
    /^(node|pnpm exec) [\w./-]+\.test\.[cm]?[jt]s$/
]
// Even an allowlisted prefix must not chain into something else.
const SHELL_META = /[;&|`$<>\\\n]/

const COMMAND_TIMEOUT_MS = 10 * 60_000
const HTTP_TIMEOUT_MS = 10_000

export function commandAllowed(cmd: string): boolean {
    return !SHELL_META.test(cmd) && ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd))
}

export interface VerifyOptions {
    rerunCommands: boolean
    fetchFn?: typeof fetch
    runCommand?: (cmd: string, cwd?: string) => Promise<number>
}

function runViaShell(cmd: string, cwd?: string): Promise<number> {
    return new Promise((resolve) => {
        execFile('/bin/sh', ['-c', cmd], { cwd, timeout: COMMAND_TIMEOUT_MS }, (error) => {
            if (!error) return resolve(0)
            resolve(typeof error.code === 'number' ? error.code : 1)
        })
    })
}

export async function checkEvidence(evidence: Evidence, options: VerifyOptions): Promise<CheckResult> {
    if (evidence.kind === 'file') {
        try {
            await access(evidence.path)
            return { evidence, state: 'verified', detail: 'file exists' }
        } catch {
            return { evidence, state: 'failed', detail: 'file not found' }
        }
    }

    if (evidence.kind === 'http') {
        const expected = evidence.expectStatus ?? 200
        try {
            const response = await (options.fetchFn ?? fetch)(evidence.url, {
                method: 'GET',
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
            })
            const ok = response.status === expected
            return { evidence, state: ok ? 'verified' : 'failed', detail: `HTTP ${response.status} (expected ${expected})` }
        } catch (error) {
            return { evidence, state: 'failed', detail: `request failed: ${error instanceof Error ? error.message : error}` }
        }
    }

    if (!options.rerunCommands) {
        return { evidence, state: 'skipped', detail: 'command re-run is off (NIGHTGATE_RERUN_COMMANDS=1)' }
    }
    if (!commandAllowed(evidence.cmd)) {
        return { evidence, state: 'skipped', detail: 'command is not on the re-run allowlist' }
    }
    const expected = evidence.expectExit ?? 0
    const code = await (options.runCommand ?? runViaShell)(evidence.cmd, evidence.cwd)
    return { evidence, state: code === expected ? 'verified' : 'failed', detail: `exit ${code} (expected ${expected})` }
}

export async function verifyClaim(claim: Claim, options: VerifyOptions): Promise<ClaimResult> {
    const checks: CheckResult[] = []
    for (const evidence of claim.evidence) checks.push(await checkEvidence(evidence, options))
    const state = checks.some((c) => c.state === 'failed')
        ? 'failed'
        : checks.length > 0 && checks.every((c) => c.state === 'verified')
          ? 'verified'
          : 'unchecked'
    return { what: claim.what, state, checks }
}
