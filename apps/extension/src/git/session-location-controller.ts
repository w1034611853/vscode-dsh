import * as vscode from 'vscode'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { effectiveSessionDirectory, type DshBackend, type SessionLocation } from '@dsh-vscode/domain'
import type { BackendService } from '@dsh-vscode/application'
import type { SessionNavigation } from '../composition/session-navigation.js'
import { hasLocalWorkspaceAuthority } from '../view/session-workspace-scope.js'
import { sameWorkspacePath, toCurrentHostWorkspacePath } from '../composition/workspace-state.js'
import { WORKSPACE_HANDOFF } from '../composition/workspace-browser.js'
import { executeGitCommand, GitCommandError } from './git-executor.js'

interface Dependencies {
  readonly backendService: Pick<BackendService, 'requireBackend'>
  readonly sessionNavigation: SessionNavigation
  readonly context: Pick<vscode.ExtensionContext, 'globalState'>
}
const OPEN = '打开目录并继续'
const clean = (value: string): string => value.replace(/[\r\n\t]/gu, ' ').replaceAll('$(', '(')

/** Native VS Code surface: absolute paths never enter the Webview protocol. */
export class SessionLocationController implements vscode.Disposable {
  private readonly bar = vscode.window.createStatusBarItem(
    'dsh.sessionLocation',
    vscode.StatusBarAlignment.Left,
    10001,
  )
  private readonly lifetime = new AbortController()
  private running: { backend: DshBackend; id: string; controller: AbortController } | undefined
  private readonly subscription: vscode.Disposable
  private disposed = false

  constructor(private readonly deps: Dependencies) {
    this.bar.name = 'DSH 会话目录与分支'
    this.bar.command = 'dsh.openSessionDirectory'
    this.subscription = deps.sessionNavigation.onDidChange((change) => {
      if (change === 'selection' || change === 'connection') this.refresh()
    })
    this.refresh()
  }

  refresh(): void {
    if (this.disposed) return
    let backend: DshBackend | undefined
    try {
      backend = this.deps.backendService.requireBackend()
    } catch {
      /* Not connected yet. */
    }
    const id = this.deps.sessionNavigation.activeSessionId
    if (
      backend === undefined ||
      !vscode.workspace.isTrusted ||
      !hasLocalWorkspaceAuthority(backend.connection)
    ) {
      this.running?.controller.abort()
      this.running = undefined
      this.bar.hide()
      return
    }
    if (id !== undefined && this.running?.id === id && this.running.backend === backend) return
    this.running?.controller.abort()
    this.running = undefined
    this.bar.backgroundColor = undefined
    this.bar.text = '$(folder-opened) DSH: 定位会话'
    this.bar.tooltip = '选择 DSH 会话，打开其当前执行目录并继续原会话'
    this.bar.show()
    if (id !== undefined) this.watch(backend, id)
  }

  private watch(backend: DshBackend, id: string): void {
    this.running?.controller.abort()
    const run = { backend, id, controller: new AbortController() }
    this.running = run
    const signal = run.controller.signal
    const source = backend.sessionLocation
    if (source === undefined) {
      this.bar.text = '$(warning) DSH: 当前版本不支持目录状态'
      return
    }
    this.bar.text = '$(sync~spin) DSH: 正在读取目录'
    void (async (): Promise<void> => {
      let previous: string | undefined
      let revision = 0
      while (!signal.aborted) {
        try {
          for await (const location of source.follow(id, signal)) {
            if (signal.aborted || this.running !== run) return
            this.render(location)
            const frameRevision = ++revision
            if (location.checkout.state === 'failed') {
              void readLocalBranch(location.directory, signal).then((branch) => {
                if (
                  branch !== undefined &&
                  !signal.aborted &&
                  this.running === run &&
                  revision === frameRevision
                )
                  this.render(location, branch)
              })
            }
            if (previous !== undefined && !sameWorkspacePath(previous, location.directory)) {
              const from = toCurrentHostWorkspacePath(previous)
              const to = toCurrentHostWorkspacePath(location.directory)
              void vscode.window
                .showWarningMessage(`DSH 会话执行目录已变化：\n${clean(from)} → ${clean(to)}`, OPEN)
                .then((choice) => {
                  if (choice === OPEN && this.running === run && !signal.aborted) void this.open(id)
                })
            }
            previous = location.directory
          }
        } catch {
          /* Optional official plugin unavailable or stream disconnected. */
        }
        if (signal.aborted || this.running !== run) return
        revision++
        this.bar.text = '$(warning) DSH: 目录状态不可用'
        this.bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
        this.bar.tooltip =
          '请在 DSH 插件中启用官方 Change requests & worktrees。连接恢复后自动重试；点击仍会重新核实会话目录。'
        await delay(5000, undefined, { signal }).catch(() => undefined)
      }
    })()
  }

  private render(location: SessionLocation, localBranch?: string): void {
    const local = toCurrentHostWorkspacePath(location.directory)
    const current =
      vscode.workspace.workspaceFolders?.some((folder) => sameWorkspacePath(local, folder.uri.fsPath)) ===
      true
    const branch =
      localBranch ??
      (location.checkout.state === 'ready'
        ? (location.checkout.branch ?? 'detached HEAD')
        : location.checkout.state === 'none'
          ? '非 Git 目录'
          : location.checkout.state === 'pending'
            ? '读取分支中'
            : '分支不可用')
    this.bar.text = `${current ? '$(folder-opened)' : '$(warning)'} DSH: ${clean(path.basename(local) || local)} · ${clean(branch)}`
    this.bar.tooltip = `DSH 会话默认执行目录（官方 Forge）\n${clean(local)}\n分支：${clean(branch)}${localBranch === undefined ? '' : '（当前 Extension Host 的 Git 只读查询）'}\n${current ? '当前 VS Code 文件夹' : '与当前 VS Code 文件夹不同'}\n点击打开此目录并继续原会话。已有 Shell 可能保留自己的目录。`
    this.bar.backgroundColor = current ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
    this.bar.show()
  }

  async choose(): Promise<void> {
    try {
      const backend = this.deps.backendService.requireBackend()
      if (!vscode.workspace.isTrusted || !hasLocalWorkspaceAuthority(backend.connection)) throw new Error()
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)])
      const page = await backend.sessions.list({}, signal)
      const archived = new Set(await backend.workspaces.listArchivedSessionIds(signal))
      const selected = await vscode.window.showQuickPick(
        page.items
          .filter((item) => !item.blank && item.origin !== 'subagent' && !archived.has(item.id))
          .map((item) => ({
            label: item.title || item.id,
            id: item.id,
            description: '打开当前执行目录并续聊',
            detail:
              effectiveSessionDirectory(item) === undefined
                ? '目录待核实'
                : clean(toCurrentHostWorkspacePath(effectiveSessionDirectory(item)!)),
          })),
        { title: 'DSH: 定位会话并继续', matchOnDetail: true },
      )
      if (!selected || this.disposed || backend !== this.deps.backendService.requireBackend()) return
      await this.open(selected.id)
    } catch {
      if (!this.disposed) await vscode.window.showErrorMessage('无法读取会话目录，请检查本机 DSH 连接。')
    }
  }

  async open(id = this.running?.id): Promise<void> {
    if (id === undefined) return this.choose()
    try {
      const backend = this.deps.backendService.requireBackend()
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)])
      if (!vscode.workspace.isTrusted || !hasLocalWorkspaceAuthority(backend.connection)) throw new Error()
      const session = await backend.sessions.get(id, signal)
      const directory = effectiveSessionDirectory(session)
      const archived = await backend.workspaces.listArchivedSessionIds(signal)
      if (directory === undefined || archived.includes(id)) throw new Error()
      const local = toCurrentHostWorkspacePath(directory)
      // A foreign WSL distro or Windows drive cannot be opened as a Linux file URI.
      if (!path.isAbsolute(local) || local.includes('\0') || !(await stat(local)).isDirectory())
        throw new Error()
      signal.throwIfAborted()
      if (
        this.disposed ||
        backend !== this.deps.backendService.requireBackend() ||
        !vscode.workspace.isTrusted
      )
        throw new Error()
      if (vscode.workspace.workspaceFolders?.some((folder) => sameWorkspacePath(local, folder.uri.fsPath))) {
        await this.deps.sessionNavigation.open(id, false, signal)
        return
      }
      // Reuse reloads the remote extension host, including when the folder is already open elsewhere.
      await this.deps.context.globalState.update(WORKSPACE_HANDOFF, {
        path: local,
        sessionId: id,
        time: Date.now(),
        source: 'session-location',
        origin: backend.connection.endpoint.baseUrl,
        ...(backend.connection.localDesktopPairing === true ? { desktopPairing: true } : {}),
      })
      try {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(local), {
          forceReuseWindow: true,
        })
      } catch (error) {
        await this.deps.context.globalState.update(WORKSPACE_HANDOFF, undefined)
        throw error
      }
    } catch {
      if (!this.disposed)
        await vscode.window.showErrorMessage(
          '无法打开会话当前目录：请检查目录是否存在、WSL 发行版和 DSH 连接，然后重试。',
        )
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.running?.controller.abort()
    this.subscription.dispose()
    this.bar.dispose()
  }
}

/** The Windows Host may not inspect a WSL checkout; query Git in the owning Extension Host. */
async function readLocalBranch(directory: string, signal: AbortSignal): Promise<string | undefined> {
  const local = toCurrentHostWorkspacePath(directory)
  if (!path.isAbsolute(local) || local.includes('\0')) return undefined
  try {
    const branch = (
      await executeGitCommand(local, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
    ).trim()
    return branch || undefined
  } catch (error) {
    if (signal.aborted || !(error instanceof GitCommandError) || error.exitCode !== 1) return undefined
    try {
      await executeGitCommand(local, ['rev-parse', '--verify', 'HEAD'], signal)
      return 'detached HEAD'
    } catch {
      return undefined
    }
  }
}
