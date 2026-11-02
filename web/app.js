// Nightgate console. Plain browser JS, no build step.
// Everything shown here (card text, terminal screens) is written by agents, so
// it only ever goes into the page through textContent — never innerHTML.

const SCREEN_POLL_MS = 2000
const SESSIONS_POLL_MS = 5000
const MORNING_POLL_MS = 4000
const SCREEN_LINES = 120

const CATEGORY_LABELS = {
  irreversible: 'Hard to undo',
  external_publish: 'Goes outside',
  db_schema_data: 'Database',
  product_direction: 'Product direction',
  customer_ops: 'Customers',
  account_risk: 'Account / money',
  none: 'Agent can decide'
}

// A token in the URL fragment (#token=…) never reaches server logs; keep it for this tab only.
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token')
if (fragmentToken) {
  sessionStorage.setItem('nightgate-token', fragmentToken)
  history.replaceState(null, '', location.pathname)
}
const token = sessionStorage.getItem('nightgate-token')

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || response.status)
  return body
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const $ = (id) => document.getElementById(id)
const labelled = new Set()
let activeSession = null

// ---------------------------------------------------------------- terminals

async function refreshSessions() {
  const list = $('sessions')
  try {
    const data = await api('/api/sessions')
    setChip('clim', data.available ? 'CLI Manager connected' : 'CLI Manager off', data.available)
    list.replaceChildren(
      ...(data.available
        ? data.sessions.map((s) =>
            el(
              'li',
              { class: s.id === activeSession?.id ? 'active' : '', onclick: () => selectSession(s) },
              el('span', {}, s.name || s.id.slice(0, 8)),
              el('span', { class: `state ${s.awaitingInput ? 'waiting' : ''}` }, s.awaitingInput ? 'waiting for you' : s.state)
            )
          )
        : [el('li', { class: 'empty' }, data.error)])
    )
  } catch (error) {
    list.replaceChildren(el('li', { class: 'empty' }, String(error.message)))
  }
}

function selectSession(session) {
  activeSession = session
  $('screen-head').textContent = `${session.name || session.id} · ${session.cwd || ''}`
  refreshScreen()
  refreshSessions()
}

async function refreshScreen() {
  if (!activeSession) return
  const screen = $('screen')
  const stuckToBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 8
  try {
    const { lines } = await api(`/api/sessions/${activeSession.id}/screen?lines=${SCREEN_LINES}`)
    screen.textContent = lines.join('\n')
    if (stuckToBottom) screen.scrollTop = screen.scrollHeight
  } catch (error) {
    screen.textContent = `(screen unavailable: ${error.message})`
  }
}

// ---------------------------------------------------------------- morning page

async function decide(item, human, node) {
  try {
    await api('/api/decisions', {
      method: 'POST',
      body: JSON.stringify({
        cardId: item.cardId,
        askId: item.askId,
        human,
        // "Actually mine" on a handled item has no category yet; product direction is
        // the most common miss, and the human can relabel later.
        category: human ? (item.category === 'none' ? 'product_direction' : item.category) : 'none'
      })
    })
    labelled.add(`${item.cardId}/${item.askId}`)
    node.querySelector('.actions').replaceChildren(el('span', { class: 'labelled' }, human ? 'Saved: needed me' : 'Saved: agent could decide'))
    refreshTraining()
  } catch (error) {
    alertInline(node, error.message)
  }
}

function alertInline(node, message) {
  node.querySelector('.actions').append(el('span', { class: 'labelled' }, `error: ${message}`))
}

function itemNode(item, kind) {
  const key = `${item.cardId}/${item.askId}`
  const node = el(
    'div',
    { class: `item ${kind}` },
    el(
      'div',
      { class: 'meta' },
      el('span', { class: 'cat' }, kind === 'back' ? 'Sent back: no recommendation' : CATEGORY_LABELS[item.category] || item.category),
      el('span', {}, item.project || item.cardId),
      el('span', {}, `by ${item.decidedBy}${item.decidedBy === 'rule' ? '' : ` · ${Math.round(item.confidence * 100)}%`}`),
      el('span', {}, `written by ${item.agentModel}`)
    ),
    el('div', { class: 'q' }, item.question),
    el('div', { class: 'rec' }, 'Agent recommends: ', el('b', {}, item.recommendation || '(nothing)')),
    item.reason ? el('div', { class: 'rec' }, `Why: ${item.reason}`) : null,
    el('div', { class: 'actions' })
  )
  const actions = node.querySelector('.actions')
  if (typeof item.humanLabel === 'boolean') {
    actions.append(el('span', { class: 'labelled' }, item.humanLabel ? 'You said: needed me' : 'You said: agent could decide'))
  } else if (labelled.has(key)) {
    actions.append(el('span', { class: 'labelled' }, 'Saved'))
  } else if (kind === 'agent') {
    actions.append(el('button', { class: 'btn primary', onclick: () => decide(item, true, node) }, 'Actually mine'))
    actions.append(el('button', { class: 'btn', onclick: () => decide(item, false, node) }, 'Right, agent decides'))
  } else {
    actions.append(el('button', { class: 'btn primary', onclick: () => decide(item, true, node) }, 'Yes, this needed me'))
    actions.append(el('button', { class: 'btn', onclick: () => decide(item, false, node) }, 'Agent could have decided'))
  }
  if (item.sessionId) {
    actions.append(el('button', { class: 'btn', onclick: () => selectSession({ id: item.sessionId, name: item.sessionName }) }, 'Show terminal'))
  }
  return node
}

function count(value, label) {
  return el('span', {}, el('b', {}, value), label)
}

async function refreshMorning() {
  try {
    const { page, invalid, review } = await api('/api/morning')
    $('counts').replaceChildren(
      count(page.human.length, 'for you'),
      count(page.handled.length, 'handled by agents'),
      count(page.sentBack.length, 'sent back'),
      count(page.cards, 'cards')
    )
    $('human').replaceChildren(
      ...(page.human.length
        ? page.human.map((item) => itemNode(item, 'human'))
        : [el('div', { class: 'empty' }, page.unreviewedCards.length ? 'Cards waiting for review.' : 'Nothing needs you. Go back to sleep.')])
    )
    $('sent-back-title').textContent = `Sent back to agents (${page.sentBack.length})`
    $('sent-back').replaceChildren(...page.sentBack.map((item) => itemNode(item, 'back')))
    $('handled-title').textContent = `Handled by agents (${page.handled.length}) — flag anything that was yours`
    $('handled').replaceChildren(...page.handled.map((item) => itemNode(item, 'agent')))

    const { verified, failed, unchecked } = page.claims
    $('claims').replaceChildren(
      el('div', {}, `Claims re-checked: ${verified} verified · ${failed} failed · ${unchecked} not checked`),
      ...page.failedClaims.map((c) => el('div', { class: 'bad' }, `✗ ${c.project || c.cardId}: ${c.what} — ${c.detail}`)),
      page.unreviewedCards.length ? el('div', {}, `Not reviewed yet: ${page.unreviewedCards.join(', ')}`) : null,
      ...invalid.map((bad) => el('div', { class: 'bad' }, `Invalid card ${bad.file}: ${bad.errors.join('; ')}`))
    )
    $('review-btn').disabled = review.running
    $('review-progress').textContent = review.running
      ? `judging ${review.done}/${review.total} cards (${review.current})…`
      : review.error
        ? `last review failed: ${review.error}`
        : ''
  } catch (error) {
    $('counts').replaceChildren(el('span', { class: 'empty' }, error.message))
  }
}

$('review-btn').addEventListener('click', async () => {
  $('review-btn').disabled = true
  try {
    await api('/api/review', { method: 'POST', body: '{}' })
  } catch (error) {
    $('review-progress').textContent = error.message
  }
  refreshMorning()
})

// ---------------------------------------------------------------- training

function setChip(id, text, ok) {
  let chip = document.querySelector(`[data-chip="${id}"]`)
  if (!chip) {
    chip = el('span', { 'data-chip': id })
    $('chips').append(chip)
  }
  chip.className = `chip ${ok ? 'ok' : 'off'}`
  chip.textContent = text
}

function kv(pairs) {
  return el('dl', { class: 'kv' }, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))
}

async function refreshTraining() {
  try {
    const t = await api('/api/training')
    setChip('local', t.models.local ? `judge: ${t.models.local} (local)` : 'local judge off', Boolean(t.models.local))
    setChip('remote', t.models.remote ? `escalate: ${t.models.remote}` : 'no Meta API key', Boolean(t.models.remote))
    const d = t.dataset
    const blocks = [
      el('h3', { class: 'hint' }, 'Your decisions'),
      kv([
        ['labelled', d.decisions],
        ['trainable', `${d.train} (written by Meta models)`],
        ['eval only', `${d.eval} (held out, other vendors, or sensitive)`],
        ['excluded', `${d.excluded.non_meta_source} other-vendor · ${d.excluded.sensitive} sensitive`]
      ])
    ]
    if (t.lastEval) {
      blocks.push(
        el('h3', { class: 'hint' }, 'Last evaluation'),
        kv([
          ['missed', `${t.lastEval.missedHuman} of ${t.lastEval.humanTotal} human asks`],
          ['recall', t.lastEval.recall.toFixed(2)],
          ['precision', t.lastEval.precision.toFixed(2)],
          ['judge', t.lastEval.model.local || '-'],
          ['ran', t.lastEval.ranAt]
        ])
      )
    }
    if (t.lastRun) {
      blocks.push(
        el('h3', { class: 'hint' }, 'Last LoRA run'),
        kv(Object.entries(t.lastRun).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]))
      )
    }
    $('training').replaceChildren(...blocks)
  } catch (error) {
    $('training').replaceChildren(el('div', { class: 'empty' }, error.message))
  }
}

refreshSessions()
refreshMorning()
refreshTraining()
setInterval(refreshSessions, SESSIONS_POLL_MS)
setInterval(refreshScreen, SCREEN_POLL_MS)
setInterval(refreshMorning, MORNING_POLL_MS)
