import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { executeGitCommand, GitCommandError, type GitCommandRunner } from './git-executor.js'
import { parseWorktreeListPorcelain, scanGitWorktrees } from './worktree-scanner.js'

const root = '/work/project'
const common = '/work/project/.git'

function createRunner(worktreeOutput: string): GitCommandRunner {
  return (_cwd, args) => {
    const command = args.join(' ')
    if (command === 'rev-parse --show-toplevel') return Promise.resolve(`${root}\n`)
    if (command === 'rev-parse --path-format=absolute --git-common-dir') return Promise.resolve(`${common}\n`)
    if (command === 'worktree list --porcelain -z') return Promise.resolve(worktreeOutput)
    return Promise.reject(new Error(`Unexpected Git command: ${command}`))
  }
}

describe('parseWorktreeListPorcelain', () => {
  it('parses NUL-delimited worktrees, branch refs, detached HEAD, locks and prunable entries', () => {
    const output = [
      'worktree /work/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /work/project-feature',
      'HEAD def456',
      'branch refs/heads/feature/example',
      'locked user is reviewing',
      '',
      'worktree /work/project-detached',
      'HEAD 987654',
      'detached',
      'prunable gitdir file points to missing location',
      '',
    ].join('\0')

    expect(parseWorktreeListPorcelain(output)).toEqual([
      {
        path: '/work/project',
        head: 'abc123',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/work/project-feature',
        head: 'def456',
        branch: 'feature/example',
        detached: false,
        bare: false,
        locked: true,
        lockReason: 'user is reviewing',
        prunable: false,
      },
      {
        path: '/work/project-detached',
        head: '987654',
        detached: true,
        bare: false,
        locked: false,
        prunable: true,
        pruneReason: 'gitdir file points to missing location',
      },
    ])
  })

  it('also accepts line-delimited porcelain output', () => {
    expect(
      parseWorktreeListPorcelain('worktree /work/project\nHEAD abc123\nbranch refs/heads/main\n\n'),
    ).toEqual([
      {
        path: '/work/project',
        head: 'abc123',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ])
  })

  it('preserves spaces in worktree paths and lock reasons', () => {
    expect(
      parseWorktreeListPorcelain(
        ['worktree /work/project with spaces', 'HEAD abc123', 'locked user requested', ''].join('\0'),
      ),
    ).toEqual([
      {
        path: '/work/project with spaces',
        head: 'abc123',
        detached: false,
        bare: false,
        locked: true,
        lockReason: 'user requested',
        prunable: false,
      },
    ])
  })
})

describe('scanGitWorktrees', () => {
  it('uses the common Git directory as repository identity and returns the current worktree', async () => {
    const output = [
      'worktree /work/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /work/project-feature',
      'HEAD def456',
      'branch refs/heads/feature',
      '',
    ].join('\0')
    const runGit = createRunner(output)
    const snapshot = await scanGitWorktrees('/work/project/src', undefined, {
      runGit,
      canonicalizePath: (value) => Promise.resolve(value),
    })

    expect(snapshot).toEqual({
      rootPath: root,
      commonDirectory: common,
      repositoryId: common,
      currentWorktree: {
        path: '/work/project',
        head: 'abc123',
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      worktrees: [
        {
          path: '/work/project',
          head: 'abc123',
          branch: 'main',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/work/project-feature',
          head: 'def456',
          branch: 'feature',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        },
      ],
    })
  })

  it('scans a real repository and its linked worktree using Git porcelain output', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dsh-worktree-'))
    const mainPath = path.join(parent, 'main')
    const featurePath = path.join(parent, 'feature')
    await mkdir(mainPath)

    try {
      await executeGitCommand(mainPath, ['init', '-b', 'main'])
      await executeGitCommand(mainPath, ['config', 'user.name', 'DSH Worktree Test'])
      await executeGitCommand(mainPath, ['config', 'user.email', 'dsh-worktree@example.invalid'])
      await writeFile(path.join(mainPath, 'README.md'), 'worktree fixture\n')
      await executeGitCommand(mainPath, ['add', 'README.md'])
      await executeGitCommand(mainPath, ['commit', '-m', 'initial'])
      await executeGitCommand(mainPath, ['branch', 'feature'])
      await executeGitCommand(mainPath, ['worktree', 'add', featurePath, 'feature'])

      const snapshot = await scanGitWorktrees(featurePath)

      expect(snapshot?.rootPath).toBe(featurePath)
      expect(snapshot?.currentWorktree.branch).toBe('feature')
      expect(snapshot?.worktrees.map((worktree) => worktree.branch)).toEqual(['main', 'feature'])
      expect(snapshot?.repositoryId).toBe(path.join(mainPath, '.git'))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('returns undefined for a directory outside a Git worktree', async () => {
    const notRepository = new GitCommandError(
      ['rev-parse', '--show-toplevel'],
      Object.assign(new Error('git exited'), { code: 128 }),
      '',
      'fatal: not a git repository (or any of the parent directories): .git',
    )
    const runGit: GitCommandRunner = () => Promise.reject(notRepository)

    await expect(scanGitWorktrees('/tmp/plain-folder', undefined, { runGit })).resolves.toBeUndefined()
  })

  it('does not hide a missing Git executable or another command failure', async () => {
    const runGit: GitCommandRunner = () => Promise.reject(new Error('git executable not found'))

    await expect(scanGitWorktrees('/work/project', undefined, { runGit })).rejects.toThrow(
      'git executable not found',
    )
  })

  it('rejects an incomplete worktree listing rather than inventing a current worktree', async () => {
    const runGit = createRunner('worktree /work/other\0HEAD abc123\0branch refs/heads/other\0\0')

    await expect(
      scanGitWorktrees('/work/project', undefined, {
        runGit,
        canonicalizePath: (value) => Promise.resolve(value),
      }),
    ).rejects.toThrow('did not include the current repository root')
  })
})
