import { realpath } from 'node:fs/promises'
import path from 'node:path'

import { executeGitCommand, isNotGitRepositoryError } from './git-executor.js'
import type { GitCommandRunner } from './git-executor.js'

export interface GitWorktree {
  /** Canonical absolute path to the worktree root. */
  readonly path: string
  /** HEAD commit when Git reports one. */
  readonly head?: string
  /** Local branch name, without the refs/heads/ prefix. */
  readonly branch?: string
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason?: string
  readonly prunable: boolean
  readonly pruneReason?: string
}

export interface GitRepositorySnapshot {
  /** Canonical absolute path returned by rev-parse --show-toplevel. */
  readonly rootPath: string
  /** Canonical absolute common Git directory shared by linked worktrees. */
  readonly commonDirectory: string
  /** Stable within the current host: normalized canonical common-directory path. */
  readonly repositoryId: string
  readonly currentWorktree: GitWorktree
  readonly worktrees: readonly GitWorktree[]
}

export interface GitWorktreeScannerOptions {
  readonly runGit?: GitCommandRunner
  readonly canonicalizePath?: (value: string) => Promise<string>
}

/**
 * Discover every worktree that shares the current checkout's Git common
 * directory. A non-Git folder returns undefined; missing Git or execution
 * failures remain errors so callers can distinguish them from an empty repo.
 */
export async function scanGitWorktrees(
  directory: string,
  signal?: AbortSignal,
  options: GitWorktreeScannerOptions = {},
): Promise<GitRepositorySnapshot | undefined> {
  signal?.throwIfAborted()
  const runGit = options.runGit ?? executeGitCommand
  let commandResults: [string, string, string]
  try {
    commandResults = await Promise.all([
      runGit(directory, ['rev-parse', '--show-toplevel'], signal),
      runGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
      runGit(directory, ['worktree', 'list', '--porcelain', '-z'], signal),
    ])
  } catch (error) {
    if (isNotGitRepositoryError(error)) return undefined
    throw error
  }
  signal?.throwIfAborted()
  const [rootOutput, commonOutput, worktreeOutput] = commandResults

  const rootValue = removeOneLineEnding(rootOutput)
  const commonValue = removeOneLineEnding(commonOutput)
  if (rootValue === '' || commonValue === '') throw new Error('Git returned an empty repository path.')

  const canonicalize = options.canonicalizePath ?? canonicalizeExistingPath
  const [rootPath, commonDirectory] = await Promise.all([canonicalize(rootValue), canonicalize(commonValue)])
  signal?.throwIfAborted()

  const records = parseWorktreeListPorcelain(worktreeOutput)
  if (records.length === 0) throw new Error('Git returned no worktrees for a non-bare working directory.')

  const worktrees = await Promise.all(
    records.map(async (record): Promise<GitWorktree> => ({
      path: await canonicalize(record.path),
      ...(record.head === undefined ? {} : { head: record.head }),
      ...(record.branch === undefined ? {} : { branch: record.branch }),
      detached: record.detached,
      bare: record.bare,
      locked: record.lockReason !== undefined || record.locked,
      ...(record.lockReason === undefined ? {} : { lockReason: record.lockReason }),
      prunable: record.pruneReason !== undefined || record.prunable,
      ...(record.pruneReason === undefined ? {} : { pruneReason: record.pruneReason }),
    })),
  )
  signal?.throwIfAborted()

  const currentWorktree = worktrees.find((worktree) => sameCanonicalPath(worktree.path, rootPath))
  if (currentWorktree === undefined)
    throw new Error('Git worktree listing did not include the current repository root.')

  return {
    rootPath,
    commonDirectory,
    repositoryId: repositoryPathIdentity(commonDirectory),
    currentWorktree,
    worktrees,
  }
}

interface ParsedWorktreeRecord {
  readonly path: string
  readonly head?: string
  readonly branch?: string
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason?: string
  readonly prunable: boolean
  readonly pruneReason?: string
}

/** Parse both Git's NUL-delimited -z output and its line-delimited porcelain form. */
export function parseWorktreeListPorcelain(output: string): readonly ParsedWorktreeRecord[] {
  const separator = output.includes('\0') ? '\0' : '\n'
  const fields = output.split(separator)
  const records: ParsedWorktreeRecord[] = []
  let current:
    | {
        path?: string
        head?: string
        branch?: string
        detached: boolean
        bare: boolean
        locked: boolean
        lockReason?: string
        prunable: boolean
        pruneReason?: string
      }
    | undefined

  const finish = (): void => {
    if (current?.path !== undefined && current.path !== '') {
      records.push({
        path: current.path,
        ...(current.head === undefined ? {} : { head: current.head }),
        ...(current.branch === undefined ? {} : { branch: current.branch }),
        detached: current.detached,
        bare: current.bare,
        locked: current.locked,
        ...(current.lockReason === undefined ? {} : { lockReason: current.lockReason }),
        prunable: current.prunable,
        ...(current.pruneReason === undefined ? {} : { pruneReason: current.pruneReason }),
      })
    }
    current = undefined
  }

  for (const field of fields) {
    if (field === '') {
      finish()
      continue
    }
    if (field.startsWith('worktree ')) {
      if (current?.path !== undefined) finish()
      current = {
        path: field.slice('worktree '.length),
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (current === undefined) continue

    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch ')) {
      const branch = field.slice('branch '.length)
      current.branch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
    } else if (field === 'detached') current.detached = true
    else if (field === 'bare') current.bare = true
    else if (field === 'locked' || field.startsWith('locked ')) {
      current.locked = true
      const reason = field.slice('locked'.length).trim()
      if (reason !== '') current.lockReason = reason
    } else if (field === 'prunable' || field.startsWith('prunable ')) {
      current.prunable = true
      const reason = field.slice('prunable'.length).trim()
      if (reason !== '') current.pruneReason = reason
    }
  }
  finish()
  return records
}

async function canonicalizeExistingPath(value: string): Promise<string> {
  const absolute = path.resolve(value)
  try {
    return await realpath(absolute)
  } catch {
    // A prunable worktree may no longer exist. Retain its normalized spelling
    // so it can be shown diagnostically, but it will not be used for matching.
    return absolute
  }
}

function removeOneLineEnding(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b
}

function repositoryPathIdentity(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}
