import { execFile } from 'node:child_process'

/** One bounded Git subprocess invocation. */
export const GIT_COMMAND_TIMEOUT_MS = 5_000
export const GIT_COMMAND_MAX_BUFFER_BYTES = 1_048_576

export class GitCommandError extends Error {
  public readonly exitCode: number | undefined
  public readonly systemCode: string | undefined

  public constructor(
    public readonly args: readonly string[],
    error: Error & { readonly code?: number | string },
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super('Git command failed.', { cause: error })
    this.name = 'GitCommandError'
    this.exitCode = typeof error.code === 'number' ? error.code : undefined
    this.systemCode = typeof error.code === 'string' ? error.code : undefined
  }
}

/** Injectable command boundary for deterministic scanner tests. */
export type GitCommandRunner = (cwd: string, args: readonly string[], signal?: AbortSignal) => Promise<string>

/**
 * Run Git without a shell. Arguments are passed as an argv array, output and
 * execution time are bounded, and cancellation terminates the child process.
 */
export function executeGitCommand(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  return new Promise<string>((resolve, reject) => {
    const options = {
      cwd,
      encoding: 'utf8' as const,
      windowsHide: true,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }
    execFile('git', [...args], options, (error, stdout, stderr) => {
      if (signal?.aborted === true) {
        reject(error ?? new Error('Git command cancelled.'))
        return
      }
      if (error !== null) {
        reject(new GitCommandError(args, error, stdout, stderr))
        return
      }
      resolve(stdout)
    })
  })
}

/** A missing repository is an ordinary scan result, not a connection failure. */
export function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return /not a git repository|must be run in a work tree/iu.test(error.stderr)
}
