import { realpathSync } from 'node:fs'
import path from 'node:path'
import {
  type LegacyTemporaryWorkspaceReference,
  type StoredTemporaryWorkspace,
} from '../backend/temporary-workspace.js'
import { isTemporaryWorkspaceOwnershipToken } from '../backend/temporary-workspace-ownership.js'
import { isAbsoluteFilePath } from '../backend/runtime-paths.js'

export function readStoredTemporaryWorkspace(value: unknown): StoredTemporaryWorkspace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = record.id
  const workspacePath = record.path
  const ownershipToken = record.ownershipToken
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof workspacePath !== 'string' ||
    workspacePath.trim() === '' ||
    !isAbsoluteFilePath(workspacePath) ||
    !isTemporaryWorkspaceOwnershipToken(ownershipToken)
  )
    return undefined
  return { id, path: workspacePath, ownershipToken }
}

export function readLegacyTemporaryWorkspace(value: unknown): LegacyTemporaryWorkspaceReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'ownershipToken')) return undefined
  const id = record.id
  const workspacePath = record.path
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof workspacePath !== 'string' ||
    workspacePath.trim() === '' ||
    !isAbsoluteFilePath(workspacePath)
  )
    return undefined
  return { id, path: workspacePath }
}

/**
 * Translate a Windows WSL UNC path to the POSIX path visible to the current
 * WSL extension host. The distribution name must match exactly (case-insensitive)
 * so a path from another WSL distribution is never treated as local.
 */
export function wslUncPathToPosix(
  value: string,
  distroName = process.env.WSL_DISTRO_NAME,
): string | undefined {
  if (distroName === undefined || distroName.trim() === '') return undefined
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/iu.exec(value)
  if (match === null || match[1]?.toLowerCase() !== distroName.toLowerCase()) return undefined
  const relative = match[2] ?? ''
  if (relative.includes('\0')) return undefined
  const segments = relative.split(/[\\/]+/u).filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/** Return the path spelling that the current extension host can access. */
export function toCurrentHostWorkspacePath(value: string): string {
  if (process.platform !== 'linux') return value
  return wslUncPathToPosix(value) ?? value
}

export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const hostPath = toCurrentHostWorkspacePath(value)
    const resolved = path.normalize(path.resolve(hostPath))
    let canonical = resolved
    try {
      canonical = realpathSync.native(resolved)
    } catch {
      // A workspace can be published before a remote/virtual path is
      // readable locally. The normalized spelling remains the safe fallback.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  return normalize(left) === normalize(right)
}
