# DSH_Delete_Conversation

为 **Windows 版 DeepSeek Harness (DSH) 0.2.1-rc.3、0.2.1-rc.5** 增加永久删除对话功能。安装后，对话列表中 **归档按钮右侧** 会出现垃圾桶按钮；对话菜单里也会出现「删除对话」。支持中文、英文和 DSH 的明暗主题。

点击按钮后显示一次确认，确认后停止运行中的任务并删除所选对话的本地记录。

## 安装

打开 DSH 的 **插件 → 安装第三方插件**，在安装来源中输入：

```text
https://github.com/Jeatricy/DSH_Delete_Conversation
```

点击「安装」，完成后点击「立即启用」。若 DSH 提示需要重启，按提示重启；其余情况刷新界面后即可使用。

也可以从 [Releases](https://github.com/Jeatricy/DSH_Delete_Conversation/releases) 下载 `.tgz` 安装包，将其绝对路径填入同一安装窗口。解压或克隆仓库后，填写包含包清单的本地目录也可以安装。插件已经包含浏览器构建产物，使用者无需安装 Node.js 或运行构建命令。

卸载时在 DSH 插件管理中卸载「永久删除对话」。删除过的对话无法通过卸载插件恢复。

## 删除范围

删除以单个对话 ID 为单位，包含：

- 对话日志目录中的消息、工具记录、检查点、备份及该目录内的其他数据。
- 对话的定时提醒，包括已停用的提醒。
- 工作区中的对话引用、置顶和归档标记。
- 对应的投影缓存、缓存备份、支持格式的旧版缓存记录、搜索索引和运行时引用。

若共享的旧版缓存损坏或格式未知，插件会保留该文件，并在界面提示；不会猜测其结构或删除其他对话的数据。以往 DSH 进程的临时目录无法可靠归属当前实例，因此只清理当前实例中可明确归属的临时输出。

**保留**工作目录里的项目文件、独立分支/子对话的存储记录，以及可能被其他对话共用的内容寻址附件。删除对话不是删除项目目录，也不会递归删除其他对话。已有导出文件和外部备份不在插件管理范围内。

这是应用层面的永久删除，不提供恢复入口，也不承诺磁盘介质的取证级擦除。

## 兼容性与实现

当前精确支持 **DSH 0.2.1-rc.3 和 0.2.1-rc.5（Windows）**；不包含未经验证的 rc.4、正式版或未来版本。包清单使用 `0.2.1-rc.3 || 0.2.1-rc.5`，不使用覆盖中间版本的范围。这两个版本没有公开的永久删除 API，因此插件仍需严格检查内部结构，找到 DSH 自身的单对话生命周期清理函数，再执行停止、等待空闲、关闭写入和清除记录。版本获准不等于跳过结构检查。

初始化时，适配器检查 Loader 中以下七个包的所有活跃条目：`dsh-agent-loop`、`dsh-session-persistence-jsonl`、`dsh-workspace`、`dsh-session-projection-cache`、`dsh-session-query-sqlite`、`dsh-storage-domain`、`dsh-storage-json`（均位于 `@deepseek-ai` 命名空间）。各条目必须有所属 Loader 树的上下文，包名必须匹配，版本必须全部为 rc.3 或全部为 rc.5；即使两个版本分别受支持，也拒绝混用。禁用或未挂载的条目不用于判定版本；同一包在不同活跃树中的副本也会逐一检查。

包定位优先使用活跃 Loader 的 ESM 解析器，按官方 `internal.version` 的 v1/v2 签名调用 `resolveSync`，从解析到的 Host 模块路径向上寻找对应包清单。只有没有内部解析器时，才使用所属树上下文的 `createRequire` 回退。内部解析失败、未知签名、非文件模块、缺失或损坏的清单均安全拒绝，不改用可能指向另一副本的解析结果。随后仍检查服务方法、缓存结构和单对话生命周期；不兼容时不会开始删除。

本次兼容依据：项目已有 `.research/dsh` 官方源码为 rc.3；维护者通过只读解析当前安装包 `app.asar` 的目录及目标条目，确认本机 `@deepseek-ai/dsh` 和上述七包的清单版本均为 rc.5，且七包 `lib/index.js` 与研究副本逐字节相同。维护者还确认 `dsh-client-connection` 的 Host/浏览器实现、`dsh-client-ui-workspace` 的 Host/浏览器实现以及 Cordis 4.0.5 的实现与研究副本相同。`.research` 的版本号不是当前安装版本的判定依据，也不随安装包验证结果改写。

对照源码确认的关键接口如下；这些是源码核对证据，不能替代桌面端集成复验：

| 接口 | 官方实现与适配依据 |
| --- | --- |
| 生命周期 | `dsh-agent-loop/lib/index.js` 的 `agentLoop.scope(id)` / `agentLoop.lifecycle(id)` 调用取消、等待空闲、释放 scope、关闭写入句柄及解除注册；Cordis 保存带标签的 effect 元数据。 |
| 写锁与存储 | JSONL 的 `open(id, 'write')` 获取独占写权限；Windows 使用内核信号量，允许持锁删除单对话目录。投影缓存使用 `session_projcache` 的 per-record 布局及队列，SQLite `_reconcile` 清理失去存储来源的索引记录。 |
| 版本与加载 | `dsh-app-boot` 使用 semver 检查 `engines.dsh`；`cordis-plugin-loader/src/internal.ts` 定义 v1/v2 解析签名，`dsh-client-modules/lib/index.js` 优先沿 Loader 解析结果定位包清单。 |
| 前端与传输 | workspace 提供现用插槽及属性；connection 的精确 Fetch 路由在调用插件前拒绝非所有者，浏览器 `rpc.call` 的请求/响应信封与插件一致。 |
| 浏览器产物 | `dsh-client-modules` 接受 `exports["./client"]` 与 `window.__ModuleLoader__.load({ id, factory })`；现有构建脚本和包内 `dist/client.js` 使用该格式。 |

- 按钮使用正式插槽 `sidebar.workspaces.session.row.action`，顺序为 150，位于归档 (100) 与置顶 (200) 之间。
- 对话菜单使用 `sidebar.workspaces.session.menu.item`。
- 确认框使用 `shell.overlay` 和原生模态对话框，支持键盘与焦点恢复。
- 删除接口使用 DSH 的 `connection` 通道，继承现有认证和 Host/Origin 检查，并额外要求调用者是所有者且明确确认删除。
- 删除前检查路径、写入锁和生命周期。不会修改 DSH 安装文件，也没有后台 HTTP 服务或运行时 npm 依赖。

升级 DSH 后，请先检查本仓库的兼容版本说明。

## 开发

开发和测试需要 pnpm，以及满足 **`^22.22.2 || ^24.15.0 || >=26.0.0`** 的 Node.js（例如 22.22.2 或 24.15.0 及其同主版本更新）。这是锁文件中 jsdom 30.1.3 及相关依赖的实际要求；不能把任意 Node 22 都视为可运行测试的环境。插件运行时不安装这些开发依赖，`engines.node` 仍为 `>=22`，实际使用受支持 DSH 自带的 Node。

测试只使用合成服务和临时文件夹具，不读取或删除真实用户对话。版本回归测试通过临时包清单及真实 Node 包解析进入生产校验路径，覆盖 rc.3/rc.5、未知版本、上下文缺失、混合版本、多活跃树、ESM v1/v2 解析和结构拒绝。原有生命周期、认证、确认、写锁、路径、共享数据保留和界面测试继续保留。

1.0.1 已通过构建、语法检查和全部 63 项自动测试，并使用 Windows DSH rc.5 自带的 Node 24.21.0 完成隔离宿主集成验证：在临时 `DSH_HOME` 中加载真实 Loader、持久化、工作区、投影缓存和 SQLite 搜索服务，验证冷对话删除及已加载对话的生命周期释放。验证确认日志、所选缓存备份和工作区引用被清理，Agent、Session 和写入句柄被释放，其他对话、子对话及项目文件得到保留。此验证没有操作用户现有配置或对话；桌面窗口中的安装和完整界面交互仍需另行复验。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm pack --pack-destination artifacts
```

主要实现：

- [index.js](./index.js)：Host 插件入口、认证与请求校验。
- [src/host-adapter.js](./src/host-adapter.js)：DSH 生命周期与存储适配。
- [src/client.js](./src/client.js)：删除按钮和确认界面。
- [scripts/build-client.mjs](./scripts/build-client.mjs)：生成 DSH 模块加载格式的浏览器产物。
- [test](./test/)：生命周期、删除边界、请求验证与交互测试。

浏览器产物提交在 [dist/client.js](./dist/client.js) 中，修改前端后需要重新运行 `pnpm build`。已安装插件的代码更新可能需要重新安装并重启 DSH，不应假设刷新一定能替换 Host 模块。

## License

[MIT](./LICENSE)。插件图标为本项目原创。
