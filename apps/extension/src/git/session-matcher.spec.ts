import { describe, expect, it } from 'vitest'

import type { GitRepositorySnapshot, GitWorktree } from './worktree-scanner.js'
import { matchSessionsToWorktrees } from './session-matcher.js'
import type { WorktreeSessionSummary } from './session-matcher.js'

const main: GitWorktree = {
  path: '/work/project',
  head: 'aaa111',
  branch: 'main',
  detached: false,
  bare: false,
  locked: false,
  prunable: false,
}
const feature: GitWorktree = {
  path: '/work/project-feature',
  head: 'bbb222',
  branch: 'feature/agent',
  detached: false,
  bare: false,
  locked: false,
  prunable: false,
}
const nested: GitWorktree = {
  path: '/work/project-feature/nested',
  head: 'ccc333',
  detached: true,
  bare: false,
  locked: false,
  prunable: false,
}
const prunable: GitWorktree = {
  path: '/work/project-prunable',
  head: 'ddd444',
  branch: 'old-feature',
  detached: false,
  bare: false,
  locked: false,
  prunable: true,
}
const repository: GitRepositorySnapshot = {
  rootPath: feature.path,
  commonDirectory: '/work/project/.git',
  repositoryId: '/work/project/.git',
  currentWorktree: feature,
  worktrees: [main, feature, nested, prunable],
}

function session(
  id: string,
  cwd: string | undefined,
  updatedAt = '2026-11-19T10:00:00.000Z',
): WorktreeSessionSummary {
  return {
    id,
    workspaceId: `dsh-workspace-${id}`,
    title: `Session ${id}`,
    status: 'idle',
    updatedAt,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

describe('matchSessionsToWorktrees', () => {
  it('matches Sessions by effective cwd across sibling worktrees, not DSH workspace IDs', () => {
    const sessions = [
      session('main-session', '/work/project/src'),
      session('feature-session', '/work/project-feature/src'),
      session('outside-session', '/work/project-feature-copy/src'),
      session('missing-cwd', undefined),
    ]

    expect(matchSessionsToWorktrees(repository, sessions)).toEqual([
      {
        session: sessions[1],
        worktree: feature,
        relationship: 'current-worktree',
        relativeCwd: 'src',
      },
      {
        session: sessions[0],
        worktree: main,
        relationship: 'sibling-worktree',
        relativeCwd: 'src',
      },
    ])
  })

  it('chooses the most specific worktree when roots are nested', () => {
    const sessions = [session('nested-session', '/work/project-feature/nested/lib')]

    expect(matchSessionsToWorktrees(repository, sessions)).toEqual([
      {
        session: sessions[0],
        worktree: nested,
        relationship: 'sibling-worktree',
        relativeCwd: 'lib',
      },
    ])
  })

  it('does not match prunable worktrees or paths that only share a prefix', () => {
    const sessions = [
      session('prunable-session', '/work/project-prunable/src'),
      session('prefix-session', '/work/project-featured/src'),
    ]

    expect(matchSessionsToWorktrees(repository, sessions)).toEqual([])
  })

  it('maps a WSL UNC Session cwd through the current host path adapter', () => {
    const sessions = [session('wsl-session', '\\\\wsl.localhost\\Ubuntu-24.04\\work\\project\\src')]
    const result = matchSessionsToWorktrees(repository, sessions, {
      toHostPath: (value) =>
        value.startsWith('\\\\wsl.localhost\\Ubuntu-24.04')
          ? value.replace('\\\\wsl.localhost\\Ubuntu-24.04', '').replaceAll('\\', '/')
          : value,
      canonicalizePath: (value) => value,
    })

    expect(result).toEqual([
      {
        session: sessions[0],
        worktree: main,
        relationship: 'sibling-worktree',
        relativeCwd: 'src',
      },
    ])
  })

  it('orders current-worktree sessions before sibling sessions and newer sessions first', () => {
    const sessions = [
      session('sibling-old', '/work/project', '2026-11-18T10:00:00.000Z'),
      session('current-old', '/work/project-feature', '2026-11-17T10:00:00.000Z'),
      session('sibling-new', '/work/project', '2026-11-19T10:00:00.000Z'),
      session('current-new', '/work/project-feature', '2026-11-18T10:00:00.000Z'),
    ]

    expect(matchSessionsToWorktrees(repository, sessions).map((match) => match.session.id)).toEqual([
      'current-new',
      'current-old',
      'sibling-new',
      'sibling-old',
    ])
  })
})
