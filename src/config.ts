import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelEndpoint } from './model.ts'

export interface Config {
    home: string
    cardsDir: string
    reviewsDir: string
    decisionsFile: string
    trainingDir: string
    local?: ModelEndpoint
    remote?: ModelEndpoint
    host: string
    port: number
    token?: string
    rerunCommands: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const home = env.NIGHTGATE_HOME || join(homedir(), '.nightgate')

    // Tier 1: Muse Glimmer on hardware we run (Ollama/llama.cpp, OpenAI-compatible).
    const local: ModelEndpoint | undefined =
        env.NIGHTGATE_LOCAL_URL === 'off'
            ? undefined
            : {
                  name: 'glimmer-local',
                  baseUrl: env.NIGHTGATE_LOCAL_URL || 'http://127.0.0.1:11435/v1',
                  model: env.NIGHTGATE_LOCAL_MODEL || 'muse-glimmer',
                  local: true
              }

    // Tier 2: Muse Spark through the Meta Model API. Off unless a key is present.
    const remoteKey = env.META_API_KEY || env.MODEL_API_KEY
    const remote: ModelEndpoint | undefined = remoteKey
        ? {
              name: 'muse-spark-remote',
              baseUrl: env.NIGHTGATE_REMOTE_URL || 'https://api.meta.ai/v1',
              // muse-wonder is not offered in every region; muse-spark is.
              model: env.NIGHTGATE_REMOTE_MODEL || 'muse-spark-1.3',
              apiKey: remoteKey,
              local: false
          }
        : undefined

    return {
        home,
        cardsDir: join(home, 'cards'),
        reviewsDir: join(home, 'reviews'),
        decisionsFile: join(home, 'decisions.jsonl'),
        trainingDir: join(home, 'training'),
        local,
        remote,
        host: env.NIGHTGATE_HOST || '127.0.0.1',
        port: Number(env.NIGHTGATE_PORT || 4777),
        token: env.NIGHTGATE_TOKEN || undefined,
        rerunCommands: env.NIGHTGATE_RERUN_COMMANDS === '1'
    }
}
