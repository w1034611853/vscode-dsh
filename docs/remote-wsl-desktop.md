# Remote-WSL 与 Windows DSH Desktop

本功能允许 VS Code Remote-WSL 的 Linux Extension Host 连接同一台 Windows 主机上的 DSH Desktop，并继续使用 Desktop 中已有的工作区和会话。它不会在 WSL 中启动第二套 DSH Runtime，也不会迁移模型、MCP、插件或会话数据。

## 前置条件

- Windows 11 22H2 或更新版本。
- WSL2 使用 mirrored networking。
- Windows IPv6 网络组件保持启用；如果系统策略将 `DisabledComponents` 设为 `0xff`，WSL 会回退到 NAT。
- DSH Desktop 正在运行，并安装、启用 `dsh-vscode-connect`。
- VS Code 已通过 Remote-WSL 打开目标发行版中的项目。
- DSH Desktop 的连接地址是本机 HTTP loopback 地址（`http://127.0.0.1:<port>`）。

在 Windows PowerShell 中确认 WSL 配置：

```ini
[wsl2]
networkingMode=mirrored
```

应用配置：

```powershell
wsl --update
wsl --shutdown
```

在 WSL 终端确认：

```bash
wslinfo --networking-mode
# mirrored
```

## 首次连接

1. 在 DSH Desktop 中确认「设置 → 通用设置 → VS Code 连接」已开启。
2. 在 VS Code Remote-WSL 窗口中打开 DSH 面板，选择 **DSH Desktop**。
3. 首次连接时，从 Desktop 复制完整连接地址，在 **DSH: Connect to Desktop / 连接桌面端** 中粘贴。
4. 连接成功后，扩展会通过已授权的 Desktop Connect HTTP API 获取短期 launch URL，并在 Extension Host 的 SecretStorage 中更新授权。后续重连不依赖 Windows Named Pipe。

HTTP 配对请求使用当前 endpoint 已授权的 HttpOnly 会话 Cookie；只有 Desktop Connect 插件启用且已授权的 loopback endpoint 才会返回新的 launch URL。扩展会校验返回地址必须是带有效端口的 `http://127.0.0.1`，并校验路径和 token，不会把 token 写入设置、Webview 状态或日志。Remote-WSL 会保留首次授权的 bootstrap endpoint，优先用它获取当前 bridge 地址，再回退到当前连接地址。

## 工作区路径映射

Windows DSH 可能将 WSL 工作区登记为：

```text
\\wsl.localhost\\<distro>\\home\\user\\project
```

Remote-WSL Extension Host 使用 POSIX 路径：

```text
/home/user/project
```

扩展只在当前 `WSL_DISTRO_NAME` 与 UNC 中的发行版名称匹配时，将 Windows UNC 路径映射为 POSIX 路径。其他发行版、普通 UNC 路径和包含 `.` / `..` 路径段的输入不会被映射。打开工作区时，文件系统检查和 VS Code 文件夹跳转使用当前 WSL Host 可访问的 POSIX 路径。

## 故障排查

- `wslinfo --networking-mode` 必须输出 `mirrored`；如果输出 `nat`，先检查 Windows IPv6 是否被系统策略禁用。
- 从 WSL 执行 `curl -i http://127.0.0.1:<port>/api`，确认 Windows Desktop 服务可达。
- 如果普通聊天可用但工作区仍只读，确认 Desktop Connect 插件已启用、工作区受信任，并检查 DSH Output 中的配对诊断。
- 如果只读预览的历史 API 失败，请保留 DSH Output 的脱敏日志；路径映射和连接授权成功并不保证旧版 DSH 的历史协议一定兼容。
- 如果 DSH Desktop 重启后原 bootstrap 地址也无法访问（例如首次粘贴的地址本身就是已重启的临时 bridge 端口），请在 Desktop 中重新复制连接地址，并再次执行 **DSH: Connect to Desktop**。
