# dsh-host-fs

## 装上就能用（三步）

1. **装**：`dsh plugin --profile <你的 profile> add dsh-host-fs`（或 `github:sniperdown/dsh-host-fs`），然后**重启一次 DSH**。
   插件必须重启才会加载；改完配置也要重启或让它重载。
2. **配**：设置 → 插件 → 顶部 **「文件权限」** 页。
   - 会话权限选 `白名单`，在列表里勾上允许使用它的会话（每行是「标题（会话 id）」，按最后活动时间排序）
   - 路径白名单写允许删除/移动的目录（**含所有子路径**）；路径黑名单留着挡不该碰的东西
   - 点 **保存**（一次写入，勾选本身不会立刻落盘）
3. **用**：那个会话里就能调 `fs_remove` / `fs_move` 了。拿不准就先 `dryRun: true` 让它报账。

默认状态是**全关**：`sessionMode = off`、路径白名单为空 —— 装上什么也做不了，必须先显式放行。
不知道会话 id 时，在目标会话里敲 `/fs-acl`，它会打印可直接复制的 id 和当前生效的配置。

> ⚠️ 手改 profile 的 `cordis.patch.yml` 时，这个插件的条目只能是 **`id` + `config`** 的覆盖行。
> 不要再写 `name`、也不要放进 `insert:` —— 那会和 bundle 自带的声明重 id，市场更新时报
> `duplicate loader entry id` 并把别的插件一起回滚。


在 **DSH 宿主进程**里删除 / 移动文件 —— 包括工作区之外的路径。

[English](./README.md)

## 为什么需要它

DSH 有两条碰文件系统的正规通道，而在 Windows 上**都不能删工作区外的文件**：

| 通道 | 限制 |
|---|---|
| `ctx.fs` / `read`·`write`·`edit` 工具 | 只有 `stat / read / list / write / edit` —— **根本没有删除** |
| shell 工具（`pwsh` / `bash`） | 子进程跑在 **Low 完整性级别**，写不了/删不了任何 Medium 标签的目录（比如 DSH 自己的 home） |

插件的工具跑在**宿主进程**里，权限就是用户本人的权限 —— 这就是全部机关：`fs_remove` / `fs_move` 由宿主执行普通的 `node:fs` 调用，所以 shell 做不到的地方它们能做。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile <name> add dsh-host-fs

# 从 git 仓库
dsh plugin --profile <name> add github:you/dsh-host-fs

# 从本地目录
dsh plugin --profile <name> add link:/absolute/path/to/dsh-host-fs
```

## 配置

设置 → 插件 → **dsh-host-fs** 有自动生成的表单；**设置 → 插件 → 文件权限** 是专用页：
四档会话权限、搜索框、按类别分组的**会话勾选表**（每行是 `标题（会话 id）`）、
`pathAllow` / `pathDeny` 两个文本框，点一次「保存」才写入 profile —— 勾一下不会立刻存。

`sessionList` 由宿主在保存时重算：界面只负责它看得见的那批会话的勾选；
通配（`qq-*`）、`preset:example`、`*`，以及已经不在列表里的旧会话 id 都**原样保留**。

两层独立的闸门，默认都在安全侧。

| 配置项 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `sessionMode` | `off` · `allowlist` · `denylist` · `all` | `off` | **谁可以调用。** `off` = 谁都不行。 |
| `sessionList` | 文本 | 空 | 一行一条（换行 / 逗号 / 分号都认）。写法：精确 id（`session-…`、`qq-group-…`）、前缀通配（`qq-*`）、按人格预设（`preset:example`）、全部（`*`）。 |
| `pathAllow` | 文本 | 空 | 一行一条路径。写进一条 ⇒ **该路径本身以及它下面所有子路径**都允许。空 = 什么都不允许。 |
| `pathDeny` | 文本 | 空 | 语法同白名单，**优先级高于白名单**。 |
| `askOutside` | 布尔 | `true` | 两边都没命中的路径：在 GUI 里问一次（见下）。 |

### 路径判定（精确版）

```
1. 是驱动器根（C:\ 、H:\ …）              → 拒绝（不可配置）
2. 落在某条 pathDeny 之下                  → 拒绝（压过白名单）
3. 落在某条 pathAllow 之下                 → 允许
4. 其余                                    → askOutside ? 弹一次审批 : 拒绝
```

于是 `pathAllow = C:\1`、`pathDeny = C:\1\2` 时：

| 路径 | 结果 |
|---|---|
| `C:\1` | 允许 |
| `C:\1\3`、`C:\1\3\deep\x.txt` | 允许 |
| `C:\1\2`、`C:\1\2\3` | 拒绝（黑名单优先） |
| `C:\1\20` | 允许（不在 `C:\1\2` 之下） |

`fs_move` 的**源和目标各走一遍**同一套判定 —— 所以把东西从允许目录移进禁止目录会被拒。

### 一次性审批

`askOutside` 开着、且路径两个名单都没命中时，插件会调用 DSH 的审批 API（就是那个"需要完整权限"的框）。前提是该会话的审批档位是 **ask**；只接受 `allowed-once` 一种结果，所以它**永远不可能放宽配置**。没有应答者时（QQ 会话、headless）一律 fail closed。

这里**故意没有** `unsafe` / `force` 之类让模型绕过名单的参数 —— **配置说了算**。

## 工具

### `fs_remove`

| 参数 | 类型 | 含义 |
|---|---|---|
| `path` | string，必填 | 绝对路径；相对路径以会话工作目录为基准。 |
| `recursive` | boolean | 删除**非空目录**时必须显式给 `true`。 |
| `dryRun` | boolean | 只统计、不删。 |

返回 `{ path, kind, entries, bytes, dryRun, approved }`，`kind` 取 `file` · `dir` · `link` · `other` · `missing`。路径不存在**不是错误** —— 返回 `kind: "missing"`，所以重试是无害的。

### `fs_move`

| 参数 | 类型 | 含义 |
|---|---|---|
| `from` | string，必填 | 源路径。 |
| `to` | string，必填 | 目标路径。 |
| `overwrite` | boolean | 允许覆盖已存在的目标。 |
| `dryRun` | boolean | 只报告，不移动。 |

会自动创建目标缺失的父目录；拒绝把目录移进它自己的子树；跨盘移动会明确报错（请先复制再 `fs_remove`）。

## `/fs-acl`

只读斜杠命令。打印当前会话 id、preset、cwd、**当前加载的**配置，以及"要放行本会话就抄这一行"：

```
dsh-host-fs · 当前会话
  会话 id  : session-example-01-…
  preset   : (默认)
  会话闸门 : sessionMode=allowlist → 拒绝（not-in-allowlist）
  名单     : (空)
  ...
sessionList 里放这一行即可放行本会话：
  session-example-01-…
```

它还会提醒：报告里的值是**内存中正在跑的那份配置** —— 如果你刚改过设置而这里没变，说明插件还没重载。

## Windows 相关的两条实测结论

- **junction 不是 `lstat` 意义上的符号链接**：`isSymbolicLink()` 为 `false`、`isDirectory()` 为 `true`，`readlink` 抛 `EINVAL`。所以判定用列父目录时的 `Dirent.isSymbolicLink()`，拿不到再退回 `realpath` 比较。
- **`fs.rmSync(recursive)` 不会删穿 junction**：实测删掉"装着 junction 的目录"之后，目标及其内容完好无损。junction 路径本身会报 `kind: "link"`，只删链接。

只读文件会清一次属性后重试一次；其余错误原样抛出。

## 已知限制（v0.3）

- 会话闸门是**调用时拒绝**，不是按会话隐藏工具（被拒的会话仍看得到工具，但会收到一句明确的"怎么放行"）。
- 旧版本的会话没有标题事件，列表里显示 `(未命名)`；会话 id 旁边有「在线」标记。
- 设置页是插件的一部分：**装好/更新后要重启宿主**，页面才会出现在「设置 → 插件」里。
- 会话标题是**一次批量**读的（几百个会话可能要等一两秒）；读标题超时不影响勾选与保存。
- 界面只显示调用插件自己路由的权限页；配置写入走 DSH 的 `configEditor`，不手写 profile patch。

## 许可证

MIT
