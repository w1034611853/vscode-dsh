/** Host-only location facts from the runtime's official worktree service. */
export interface SessionLocation {
  readonly directory: string
  readonly checkout:
    | { readonly state: 'pending' | 'none' | 'failed' }
    | {
        readonly state: 'ready'
        readonly root: string
        readonly branch: string | null
        readonly linked: boolean
      }
}
export interface SessionLocationRepository {
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<SessionLocation>
}
