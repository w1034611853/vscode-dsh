import { realpathSync } from 'node:fs'
import path from 'node:path'

import type { SessionSummary } from '@dsh-vscode/domain'

import { toCurrentHostWorkspacePath } from '../composition/workspace-state.js'
import type { GitRepositorySnapshot, GitWorktree } from './worktree-scanner.js'

export type WorktreeSessionSummary = Pick<
  SessionSummary,
  'id' | 'workspaceId' | 'title' | 'status' | 'updatedAt' | 'cwd'
>

export interface WorktreeSessionMatch {
  readonly session: WorktreeSessionSummary
  readonly worktree: GitWorktree
  readonly relationship: 'current-worktree' | 'sibling-worktree'
  /** '.' when the Session cwd is exactly the worktree root. */
  readonly relativeCwd: string
}

export interface WorktreeSessionMatcherOptions {
  /** Override host path conversion in tests or a specialized remote host. */
  readonly toHostPath?: (value: string) => string
  /** Override realpath resolution in tests. */
  readonly canonicalizePath?: (value: string) => string
}

/**
 * Associate Session summaries with worktrees by the Session's effective cwd.
 *
 * DSH workspace IDs are deliberately not used: they identify DSH registry
 * entries, not Git repositories. Sessions without a cwd, and sessions whose
 * cwd is outside every live worktree, are not guessed into this repository.
 */
export function matchSessionsToWorktrees(
  repository: GitRepositorySnapshot,
  sessions: readonly WorktreeSessionSummary[],
  options: WorktreeSessionMatcherOptions = {},
): readonly WorktreeSessionMatch[] {
  const toHostPath = options.toHostPath ?? toCurrentHostWorkspacePath
  const canonicalize = options.canonicalizePath ?? canonicalizeLocalPath
  const worktrees = repository.worktrees
    .filter((worktree) => !worktree.bare && !worktree.prunable)
    .map((worktree) => ({
      worktree,
      root: canonicalize(toHostPath(worktree.path)),
    }))
    .sort((left, right) => right.root.length - left.root.length)

  const currentRoot = canonicalize(toHostPath(repository.currentWorktree.path))
  const matches: WorktreeSessionMatch[] = []

  for (const session of sessions) {
    if (session.cwd === undefined || session.cwd.trim() === '') continue
    const hostCwd = toHostPath(session.cwd)
    if (!path.isAbsolute(hostCwd)) continue
    const cwd = canonicalize(hostCwd)
    const owner = worktrees.find(({ root }) => isWithinDirectory(root, cwd))
    if (owner === undefined) continue

    const relative = path.relative(owner.root, cwd)
    matches.push({
      session,
      worktree: owner.worktree,
      relationship: samePath(owner.root, currentRoot) ? 'current-worktree' : 'sibling-worktree',
      relativeCwd: relative === '' ? '.' : relative,
    })
  }

  return matches.sort((left, right) => {
    if (left.relationship !== right.relationship) return left.relationship === 'current-worktree' ? -1 : 1
    const updated = Date.parse(right.session.updatedAt) - Date.parse(left.session.updatedAt)
    if (Number.isFinite(updated) && updated !== 0) return updated
    return left.session.id.localeCompare(right.session.id)
  })
}

function canonicalizeLocalPath(value: string): string {
  const absolute = path.resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    // A cold Session may refer to a directory that has been removed. It is
    // still safe to compare its normalized spelling, but it cannot match a
    // different worktree through a basename or branch-name heuristic.
    return absolute
  }
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b
}
