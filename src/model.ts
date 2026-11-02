// One client for both tiers. llama.cpp's llama-server (Muse Glimmer on our own
// box) and the Meta Model API (https://api.meta.ai/v1) both speak OpenAI
// Chat Completions, so the judge does not care which one answers.

export interface ModelEndpoint {
    name: string
    baseUrl: string
    model: string
    apiKey?: string
    // Local endpoints may see sensitive asks; remote ones never do.
    local: boolean
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export type ChatFn = (endpoint: ModelEndpoint, messages: ChatMessage[]) => Promise<string>

const DEFAULT_TIMEOUT_MS = 120_000
// Muse models reason before answering; leave room so the JSON is not cut off.
const DEFAULT_MAX_TOKENS = 4096

export async function chatCompletion(
    endpoint: ModelEndpoint,
    messages: ChatMessage[],
    { timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = DEFAULT_MAX_TOKENS } = {}
): Promise<string> {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {})
        },
        body: JSON.stringify({ model: endpoint.model, messages, max_tokens: maxTokens, temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const body = await response.text()
    if (!response.ok) {
        throw new Error(`${endpoint.name} ${response.status}: ${body.slice(0, 300)}`)
    }
    const payload = JSON.parse(body) as { choices?: { message?: { content?: string } }[] }
    return stripThinking(payload.choices?.[0]?.message?.content ?? '')
}

// Some servers inline the reasoning as <think>…</think> in content.
export function stripThinking(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}
