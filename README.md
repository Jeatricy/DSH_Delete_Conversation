# DSH_Delete_Conversation

为 **Windows 版 DeepSeek Harness (DSH) 0.2.1-rc.3** 增加永久删除对话功能。安装后，对话列表中 **归档按钮右侧** 会出现垃圾桶按钮；对话菜单里也会出现「删除对话」。支持中文、英文和 DSH 的明暗主题。

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

当前兼容版本为 **DSH 0.2.1-rc.3**。此版本没有公开的永久删除 API，因此插件使用一个严格检查版本和结构的适配器，找到 DSH 自身的单对话生命周期清理函数，然后执行停止、等待空闲、关闭写入和清除记录。版本或结构不匹配时拒绝删除，不猜测内部字段。

- 按钮使用正式插槽 `sidebar.workspaces.session.row.action`，顺序为 150，位于归档 (100) 与置顶 (200) 之间。
- 对话菜单使用 `sidebar.workspaces.session.menu.item`。
- 确认框使用 `shell.overlay` 和原生模态对话框，支持键盘与焦点恢复。
- 删除接口使用 DSH 的 `connection` 通道，继承现有认证和 Host/Origin 检查，并额外要求调用者是所有者且明确确认删除。
- 删除前检查路径、写入锁和生命周期。不会修改 DSH 安装文件，也没有后台 HTTP 服务或运行时 npm 依赖。

升级 DSH 后，请先检查本仓库的兼容版本说明。

## 开发

要求 Node.js 22+ 和 pnpm。

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
