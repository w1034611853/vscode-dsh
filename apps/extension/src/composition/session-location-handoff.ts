import { sameWorkspacePath } from './workspace-state.js'

/** A recent native navigation may request re-verifying Desktop pairing in the destination workspace. */
export function isDesktopLocationHandoff(
  value: unknown,
  origin: string,
  folders: readonly string[],
  now: number,
): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pending = value as Record<string, unknown>
  return (
    pending.source === 'session-location' &&
    pending.desktopPairing === true &&
    pending.origin === origin &&
    typeof pending.sessionId === 'string' &&
    pending.sessionId.length > 0 &&
    typeof pending.path === 'string' &&
    typeof pending.time === 'number' &&
    Number.isFinite(pending.time) &&
    pending.time <= now &&
    now - pending.time <= 300_000 &&
    folders.some((folder) => sameWorkspacePath(folder, pending.path as string))
  )
}
