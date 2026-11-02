import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCard, type Ask, type Card } from '../src/card.ts'
import { judgeAsk, parseVerdict, ruleHit } from '../src/judge.ts'
import type { ChatFn, ModelEndpoint } from '../src/model.ts'

const local: ModelEndpoint = { name: 'glimmer-local', baseUrl: 'http://local', model: 'muse-glimmer', local: true }
const remote: ModelEndpoint = { name: 'muse-spark-remote', baseUrl: 'http://remote', model: 'muse-spark-1.3', local: false }

const card: Card = {
    version: 1,
    id: 'c1',
    project: 'standup',
    agent: { model: 'muse-spark-1.3' },
    status: 'done',
    summary: '',
    did: [],
    asks: []
}

function ask(question: string, recommendation = 'Do it.', extra: Partial<Ask> = {}): Ask {
    return { id: 'a1', question, recommendation, ...extra }
}

// A fake model that answers per endpoint and records who was asked.
function fakeChat(answers: Record<string, string | Error>): { chat: ChatFn; calls: string[] } {
    const calls: string[] = []
    const chat: ChatFn = async (endpoint) => {
        calls.push(endpoint.name)
        const answer = answers[endpoint.name]
        if (answer instanceof Error) throw answer
        if (answer === undefined) throw new Error('no answer configured')
        return answer
    }
    return { chat, calls }
}

const AGENT_SURE = '{"human": false, "category": "none", "confidence": 0.9, "reason": "refactor"}'
const AGENT_UNSURE = '{"human": false, "category": "none", "confidence": 0.4, "reason": "not sure"}'
const HUMAN_DB = '{"human": true, "category": "db_schema_data", "confidence": 0.9, "reason": "schema"}'

test('rule floor sends pushes to the human without calling a model', async () => {
    const { chat, calls } = fakeChat({})
    const judgment = await judgeAsk(ask('Should I git push the docs branch?'), card, { local, remote, chat })
    assert.equal(judgment.verdict, 'human')
    assert.equal(judgment.category, 'external_publish')
    assert.equal(judgment.decidedBy, 'rule')
    assert.deepEqual(calls, [])
})

test('rule floor stays narrow: renaming a file is not a rule hit', () => {
    assert.equal(ruleHit(ask('Rename utils.ts to format.ts?')), null)
    assert.equal(ruleHit(ask('Run migration 0042 on production?')), 'db_schema_data')
    assert.equal(ruleHit(ask('Deploy the release to production now?')), 'external_publish')
})

test('a confident local "agent" answer is final', async () => {
    const { chat, calls } = fakeChat({ 'glimmer-local': AGENT_SURE })
    const judgment = await judgeAsk(ask('Rename utils.ts?'), card, { local, remote, chat })
    assert.equal(judgment.verdict, 'agent')
    assert.equal(judgment.decidedBy, 'local')
    assert.deepEqual(calls, ['glimmer-local'])
})

test('an unsure local answer escalates to the remote model', async () => {
    const { chat, calls } = fakeChat({ 'glimmer-local': AGENT_UNSURE, 'muse-spark-remote': HUMAN_DB })
    const judgment = await judgeAsk(ask('Add an index to orders?'), card, { local, remote, chat })
    assert.equal(judgment.verdict, 'human')
    assert.equal(judgment.decidedBy, 'remote')
    assert.deepEqual(calls, ['glimmer-local', 'muse-spark-remote'])
})

test('sensitive asks never leave the local model, and unsure means human', async () => {
    const { chat, calls } = fakeChat({ 'glimmer-local': AGENT_UNSURE, 'muse-spark-remote': AGENT_SURE })
    const judgment = await judgeAsk(ask('Reply to the customer ticket?', 'Send the draft', { sensitive: true }), card, {
        local,
        remote,
        chat
    })
    assert.deepEqual(calls, ['glimmer-local'])
    assert.equal(judgment.verdict, 'human')
    assert.equal(judgment.decidedBy, 'fallback')
})

test('when every model fails the ask goes to the human', async () => {
    const { chat } = fakeChat({ 'glimmer-local': new Error('ECONNREFUSED'), 'muse-spark-remote': new Error('500') })
    const judgment = await judgeAsk(ask('Bump the lint rule?'), card, { local, remote, chat })
    assert.equal(judgment.verdict, 'human')
    assert.equal(judgment.decidedBy, 'fallback')
    assert.equal(judgment.tiers.length, 2)
})

test('an agent-decidable ask without a recommendation is sent back', async () => {
    const { chat } = fakeChat({ 'glimmer-local': AGENT_SURE })
    const judgment = await judgeAsk(ask('Add a loading skeleton?', ''), card, { local, chat })
    assert.equal(judgment.verdict, 'sent_back')
    assert.equal(judgment.missingRecommendation, true)
})

test('a human ask without a recommendation still reaches the human', async () => {
    const { chat } = fakeChat({ 'glimmer-local': HUMAN_DB })
    const judgment = await judgeAsk(ask('Drop the legacy column?', ''), card, { local, chat })
    assert.equal(judgment.verdict, 'human')
    assert.equal(judgment.missingRecommendation, true)
})

test('parseVerdict reads JSON wrapped in prose and prefers the safer field', () => {
    assert.deepEqual(parseVerdict('Sure:\n```json\n' + AGENT_SURE + '\n```'), {
        human: false,
        category: 'none',
        confidence: 0.9,
        reason: 'refactor'
    })
    // human=false but a human category: treat as human.
    assert.equal(parseVerdict('{"human": false, "category": "account_risk", "confidence": 0.8}')?.human, true)
    assert.equal(parseVerdict('{"human": true, "category": "made_up"}'), null)
    assert.equal(parseVerdict('no json here'), null)
})

test('parseCard rejects cards that do not say which model wrote them', () => {
    const result = parseCard({ status: 'done', asks: [] }, 'x')
    assert.equal(result.ok, false)
    const good = parseCard({ status: 'done', agent: { model: 'muse-spark-1.3' }, asks: [{ question: 'Q?' }] }, 'x')
    assert.equal(good.ok, true)
    if (good.ok) {
        assert.equal(good.card.id, 'x')
        assert.equal(good.card.asks[0].id, 'a1')
        assert.equal(good.card.asks[0].recommendation, '')
    }
})
