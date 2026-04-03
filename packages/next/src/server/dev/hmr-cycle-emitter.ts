/**
 * Event emitter for HMR build cycles.
 *
 * The hot reloader emits `building` when compilation starts and `built` when
 * it finishes (with or without errors). Subscribers (like the SSE events
 * endpoint) receive every cycle result as it happens.
 */
import type { CompilationError } from './hot-reloader-types'

export interface HmrBuildResult {
  hash: string
  errors: ReadonlyArray<CompilationError>
  warnings: ReadonlyArray<CompilationError>
  updatedModules: ReadonlyArray<string>
  durationMs: number
}

type BuildListener = (result: HmrBuildResult) => void

let buildingStartTime: number | undefined
const listeners = new Set<BuildListener>()

export function emitHmrBuilding(): void {
  buildingStartTime = Date.now()
}

export function emitHmrBuilt(
  result: Omit<HmrBuildResult, 'durationMs'>,
  durationMs?: number
): void {
  const elapsed =
    durationMs ??
    (buildingStartTime != null ? Date.now() - buildingStartTime : 0)
  buildingStartTime = undefined

  const fullResult: HmrBuildResult = { ...result, durationMs: elapsed }
  for (const listener of listeners) {
    listener(fullResult)
  }
}

/**
 * Subscribe to all future HMR build results.
 * Returns an unsubscribe function.
 */
export function subscribe(listener: BuildListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
