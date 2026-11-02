#!/usr/bin/env node
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { splitDataset, type Decision } from './dataset.ts'
import { evaluate } from './evaluate.ts'
import { buildMorning, reviewCard } from './morning.ts'
import { startServer } from './server.ts'
import { listCards, readJsonl, readReview, writeReview, type Review } from './store.ts'

const USAGE = `nightgate <command>

  serve            start the console (default http://127.0.0.1:4777)
  review [--force] judge every new card (or all with --force) and re-check claims
  morning          print the morning page
  dataset          split human decisions into train.jsonl / eval.jsonl
  eval             replay the judge over eval.jsonl and write eval-latest.json
  seed             copy examples/cards into $NIGHTGATE_HOME/cards (for a demo)`

const config = loadConfig()
const [command, ...args] = process.argv.slice(2)

async function reviews(cardIds: string[]): Promise<Map<string, Review>> {
    const map = new Map<string, Review>()
    for (const id of cardIds) {
        const review = await readReview(config, id)
        if (review) map.set(id, review)
    }
    return map
}

async function printMorning(): Promise<void> {
    const { cards, invalid } = await listCards(config)
    const page = buildMorning(cards, await reviews(cards.map((c) => c.id)))
    console.log(`Cards: ${page.cards} · for you: ${page.human.length} · handled by agents: ${page.handled.length} · sent back: ${page.sentBack.length}`)
    for (const item of page.human) {
        console.log(`\n[${item.category}] ${item.project ?? item.cardId} — ${item.question}`)
        console.log(`  agent recommends: ${item.recommendation || '(nothing)'}`)
        console.log(`  why you: ${item.reason} (${item.decidedBy})`)
    }
    const { verified, failed, unchecked } = page.claims
    console.log(`\nClaims: ${verified} verified · ${failed} failed · ${unchecked} unchecked`)
    for (const claim of page.failedClaims) console.log(`  ✗ ${claim.project ?? claim.cardId}: ${claim.what} — ${claim.detail}`)
    if (page.unreviewedCards.length) console.log(`\nNot reviewed yet: ${page.unreviewedCards.join(', ')}`)
    for (const bad of invalid) console.log(`\nInvalid card ${bad.file}: ${bad.errors.join('; ')}`)
}

async function main(): Promise<void> {
    switch (command) {
        case 'serve': {
            startServer(config)
            console.log(`Nightgate console on http://${config.host}:${config.port}`)
            console.log(`  local judge:  ${config.local ? `${config.local.model} @ ${config.local.baseUrl}` : 'off'}`)
            console.log(`  remote judge: ${config.remote ? `${config.remote.model} @ ${config.remote.baseUrl}` : 'off (no META_API_KEY)'}`)
            return
        }
        case 'review': {
            const force = args.includes('--force')
            const { cards } = await listCards(config)
            const existing = await reviews(cards.map((c) => c.id))
            for (const card of cards) {
                if (!force && existing.has(card.id)) continue
                const started = Date.now()
                const review = await reviewCard(card, { local: config.local, remote: config.remote }, { rerunCommands: config.rerunCommands })
                await writeReview(config, review)
                console.log(`reviewed ${card.id} (${card.asks.length} asks) in ${Math.round((Date.now() - started) / 1000)}s`)
            }
            return printMorning()
        }
        case 'morning':
            return printMorning()
        case 'dataset': {
            const split = splitDataset(await readJsonl<Decision>(config.decisionsFile))
            await mkdir(config.trainingDir, { recursive: true })
            await writeFile(join(config.trainingDir, 'train.jsonl'), split.train.map((r) => JSON.stringify(r)).join('\n') + '\n')
            await writeFile(join(config.trainingDir, 'eval.jsonl'), split.eval.map((r) => JSON.stringify(r)).join('\n') + '\n')
            await writeFile(join(config.trainingDir, 'dataset.json'), JSON.stringify(split.summary, null, 2))
            console.log(JSON.stringify(split.summary))
            return
        }
        case 'eval': {
            const rows = await readJsonl<Decision>(join(config.trainingDir, 'eval.jsonl'))
            const report = await evaluate(rows, { local: config.local, remote: config.remote })
            await mkdir(config.trainingDir, { recursive: true })
            await writeFile(join(config.trainingDir, 'eval-latest.json'), JSON.stringify(report, null, 2))
            console.log(
                `eval: ${report.total} asks · missed human ${report.missedHuman}/${report.humanTotal} · recall ${report.recall.toFixed(2)} · precision ${report.precision.toFixed(2)}`
            )
            return
        }
        case 'seed': {
            const source = join(import.meta.dirname, '..', 'examples', 'cards')
            await mkdir(config.cardsDir, { recursive: true })
            for (const file of await readdir(source)) await copyFile(join(source, file), join(config.cardsDir, file))
            console.log(`copied example cards into ${config.cardsDir}`)
            return
        }
        default:
            console.log(USAGE)
            process.exitCode = command ? 1 : 0
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
