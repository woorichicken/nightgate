import type { Card } from './card.ts'
import type { Decision } from './dataset.ts'
import { judgeAsk, type DecidedBy, type JudgeOptions } from './judge.ts'

// Replays the judge over human-labelled asks. The number that matters most is
// missedHuman: an ask the human had to decide that the judge let the agent take.

export interface EvalReport {
    total: number
    humanTotal: number
    missedHuman: number
    falseHuman: number
    sentBack: number
    recall: number
    precision: number
    byDecidedBy: Partial<Record<DecidedBy, number>>
    misses: { cardId: string; askId: string; question: string }[]
    model: { local?: string; remote?: string }
    ranAt: string
}

export async function evaluate(rows: Decision[], options: JudgeOptions): Promise<EvalReport> {
    const report: EvalReport = {
        total: rows.length,
        humanTotal: 0,
        missedHuman: 0,
        falseHuman: 0,
        sentBack: 0,
        recall: 1,
        precision: 1,
        byDecidedBy: {},
        misses: [],
        model: { local: options.local?.model, remote: options.remote?.model },
        ranAt: new Date().toISOString()
    }
    let truePositive = 0
    let predictedHuman = 0

    for (const row of rows) {
        const card: Card = {
            version: 1,
            id: row.cardId,
            project: row.card.project,
            agent: { model: row.card.agentModel },
            status: row.card.status,
            summary: row.card.summary,
            did: [],
            asks: [row.ask]
        }
        const judgment = await judgeAsk(row.ask, card, options)
        report.byDecidedBy[judgment.decidedBy] = (report.byDecidedBy[judgment.decidedBy] ?? 0) + 1
        if (judgment.verdict === 'sent_back') report.sentBack += 1

        const saidHuman = judgment.verdict === 'human'
        if (saidHuman) predictedHuman += 1
        if (row.label.human) {
            report.humanTotal += 1
            if (saidHuman) truePositive += 1
            else {
                report.missedHuman += 1
                report.misses.push({ cardId: row.cardId, askId: row.askId, question: row.ask.question })
            }
        } else if (saidHuman) {
            report.falseHuman += 1
        }
    }

    report.recall = report.humanTotal === 0 ? 1 : truePositive / report.humanTotal
    report.precision = predictedHuman === 0 ? 1 : truePositive / predictedHuman
    return report
}
