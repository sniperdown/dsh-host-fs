# dsh-host-fs

## Install and run (three steps)

1. **Install**: `dsh plugin --profile <your profile> add dsh-host-fs` (or `github:sniperdown/dsh-host-fs`),
   then **restart DSH once**. Plugins are only imported at load time.
   Tested against DSH **0.2.0-rc.2**. Older hosts lack the `settings.plugins.tab` slot, so the
   settings page will not render (`fs_remove` / `fs_move` still work, configured via `cordis.patch.yml`).
2. **Configure**: Settings → Plugins → the **Files** tab.
   - set the session mode to `allowlist` and tick the sessions allowed to use it
     (each row shows the session title and id, newest activity first)
   - put the directories you allow in the path allow list (an entry covers **all subpaths**);
     use the deny list to block something inside them
   - press **Save** (one write; ticking alone does not persist)
3. **Use**: `fs_remove` / `fs_move` are now available in those sessions. Try `dryRun: true` first.

The shipped default is fully closed: `sessionMode = off` and an empty path allow list — nothing works
until you explicitly allow it. Type `/fs-acl` in a session to print its id and the currently loaded policy.

> ⚠️ If you edit the profile's `cordis.patch.yml` by hand, this plugin's entry must be an **`id` + `config`**
> override row only. Do not add `name` and do not put it inside `insert:` — that collides with the bundle's
> own declaration and makes the market report `duplicate loader entry id`, rolling back other plugins.


Delete and move files **from the DSH host process** — including paths outside the workspace.

[中文说明](./README.zh.md)

## Why this exists

DSH ships two ways to touch the filesystem, and neither can delete a file outside the workspace on Windows:

| Path | Limit |
|---|---|
| `ctx.fs` / the `read`·`write`·`edit` tools | has `stat / read / list / write / edit` — **no delete at all** |
| shell tools (`pwsh` / `bash`) | the child process runs at **Low integrity**, so it cannot unlink or write anything in a directory owned at normal integrity (e.g. the DSH home) |

A plugin's tools run **inside the host process**, at the user's own integrity level. That is the whole trick: `fs_remove` and `fs_move` are ordinary `node:fs` calls made by the host, so they work where the shell cannot.

## Install

```bash
# from npm (once published)
dsh plugin --profile <name> add dsh-host-fs

# from a git repository
dsh plugin --profile <name> add github:you/dsh-host-fs

# from a local checkout
dsh plugin --profile <name> add link:/absolute/path/to/dsh-host-fs
```

## Configuration

Settings → Plugins → **dsh-host-fs** has the generated schema form. Settings → Plugins → **File permissions**
is the dedicated page: the four session modes, a search box, a grouped **session checkbox table**
(each row is `title (session id)`), the `pathAllow` / `pathDeny` textareas, and one **Save** button —
checking a box never persists anything by itself.

The host recomputes `sessionList` on save: the page only controls the sessions it can see, while
wildcards (`qq-*`), `preset:example`, `*`, and ids of sessions that no longer exist are **kept verbatim**.

Two independent gates; both default to the safe side.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `sessionMode` | `off` · `allowlist` · `denylist` · `all` | `off` | **Who may call the tools.** `off` = nobody. |
| `sessionList` | text | empty | One entry per line (newlines, commas or semicolons). Accepted forms: exact id (`session-…`, `qq-group-…`), prefix glob (`qq-*`), agent preset (`preset:example`), everything (`*`). |
| `pathAllow` | text | empty | One path per line. An entry allows **that path and every path below it**. Empty = nothing is allowed. |
| `pathDeny` | text | empty | Same syntax, **wins over `pathAllow`**. |
| `askOutside` | boolean | `true` | For a path in neither list: ask once in the GUI (see below). |

### Path decision (exact)

```
1. the path is a drive root (C:\ , H:\ …)        → refuse  (not configurable)
2. the path is inside any pathDeny entry          → refuse  (wins over allow)
3. the path is inside any pathAllow entry         → allow
4. otherwise                                      → askOutside ? one-shot approval : refuse
```

So with `pathAllow = C:\1` and `pathDeny = C:\1\2`:

| Path | Result |
|---|---|
| `C:\1` | allowed |
| `C:\1\3`, `C:\1\3\deep\x.txt` | allowed |
| `C:\1\2`, `C:\1\2\3` | refused (deny wins) |
| `C:\1\20` | allowed (not under `C:\1\2`) |

`fs_move` runs **both** ends through this same decision, so moving something out of an allowed directory into a forbidden one is refused.

### The one-shot approval

When `askOutside` is on and a path is in neither list, the plugin calls DSH's approval API — the same "needs full access" dialog the harness uses. It requires the session's approval policy to be **ask**; the only accepted answer is `allowed-once`, so it can never widen the configuration. If no answerer exists (QQ sessions, headless runs) the request fails closed and the operation is refused.

There is deliberately **no `unsafe` / `force` flag** that lets the model bypass your lists: the configuration is the authority.

## Tools

### `fs_remove`

| Param | Type | Meaning |
|---|---|---|
| `path` | string, required | Absolute path; a relative path resolves against the session working directory. |
| `recursive` | boolean | Required to delete a directory that is not empty. |
| `dryRun` | boolean | Only measure and report; delete nothing. |

Returns `{ path, kind, entries, bytes, dryRun, approved }`, where `kind` is `file` · `dir` · `link` · `other` · `missing`. A missing path is **not** an error — it reports `kind: "missing"` so retries stay harmless.

### `fs_move`

| Param | Type | Meaning |
|---|---|---|
| `from` | string, required | Source path. |
| `to` | string, required | Destination path. |
| `overwrite` | boolean | Allow replacing an existing destination. |
| `dryRun` | boolean | Only report; move nothing. |

Creates missing parent directories, refuses to move a directory into its own subtree, and fails with a clear error across drives (copy + `fs_remove` instead).

## `/fs-acl`

A read-only slash command. Prints the current session id, its preset, the cwd, the loaded configuration, and the exact line to paste into `sessionList` to allow this session:

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

It also warns when the values it shows are the ones currently loaded in memory — i.e. if you just edited the settings and this report has not changed, the plugin has not been reloaded yet.

## Notes on Windows specifics

- **Junctions are not symlinks to `lstat`.** `isSymbolicLink()` is `false` and `isDirectory()` is `true` for a junction; `readlink` throws `EINVAL`. Detection therefore uses `Dirent.isSymbolicLink()` while listing the parent, falling back to a `realpath` comparison.
- **`fs.rmSync(recursive)` does not delete through a junction** — verified: removing a directory that contains a junction leaves the target and its contents intact. A junction path itself is reported as `kind: "link"` and only the link is removed.
- Read-only files are retried once after clearing the attribute; other errors surface unchanged.

## Limitations (v0.3)

- The session gate **refuses** calls from sessions that are not allowed; it does not hide the tools per session (a session that is not allowed still sees them and gets an explicit error explaining how to allow it).
- Sessions created before title events existed show `(未命名)`; a live session is marked with a badge.
- The settings page ships with the plugin: **restart the host after install/update** for the tab to appear.
- Titles are read in **one batch** (a few hundred sessions can take a second or two); a title timeout does not block checking boxes or saving.
- Config writes go through DSH's `configEditor` — the profile patch is never hand-written.

## License

MIT
