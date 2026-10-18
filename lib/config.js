import z from '@deepseek-ai/schemastery'

/**
 * 设置页表单就是这份 schema 渲染出来的（DSH 的「设置 → 插件」）。
 *
 * ⚠️ 必须是 **ESM**（package.json 的 `type: module` + 这里的 import）：
 * schemastery 的 CJS 入口（lib/index.cjs）会 require 一个 ESM 包（cosmokit），
 * 在 Electron 宿主里实测抛 ERR_REQUIRE_ESM_RACE_CONDITION，导致 Config 拿不到。
 * 走 ESM 入口（lib/index.mjs）就没有这个竞态。
 *
 * ⚠️ 名单是「字符串 + 分隔符」而不是数组：DSH 设置页给 `z.string()` 的控件是
 * 文本框；用分隔符字符串是 mneme 等插件已经在用的形态。分隔符认 换行 / 逗号 / 分号。
 */
export const Config = z.object({
  sessionMode: z
    .union([z.const('off'), z.const('allowlist'), z.const('denylist'), z.const('all')])
    .default('off')
    .description(
      '谁能用这两把刀。off = 谁都不行（默认）；allowlist = 只有名单里的；denylist = 名单里的除外；all = 全部会话。' +
        '这一层挡的是"能不能调用"，被挡的会话会收到明确的拒绝原因。',
    ),
  sessionList: z
    .string()
    .default('')
    .description(
      '会话名单，一行一条（也认逗号和分号）。四种写法：精确 id（session-example-01-… / qq-group-123456789）、' +
        '前缀通配（qq-*）、按人格预设（preset:example）、全部（*）。' +
        '不知道 id 就在那个会话里敲 /fs-acl，它会打印可直接复制的 id。',
    ),
  pathAllow: z
    .string()
    .default('')
    .description(
      '路径白名单，一行一条。写进一条 = 该路径本身 **以及它下面所有子路径** 都允许删除/移动。' +
        '默认空 = 什么都不允许（默认拒绝）。例：D:\\dsh-home',
    ),
  pathDeny: z
    .string()
    .default('')
    .description(
      '路径黑名单，一行一条，**优先级高于白名单**。例：白名单 D:\\dsh-home、黑名单 D:\\dsh-home\\profiles ⇒ ' +
        '可以动 D:\\dsh-home 及其子项，但动不了 D:\\dsh-home\\profiles 及其子项。',
    ),
  askOutside: z
    .boolean()
    .default(true)
    .description(
      '两边都没命中时，是否弹一次审批框（就是"需要完整权限"那个框）。' +
        '只有会话权限档为"询问"时才会弹；批准只对这一次生效。没有审批框可用（比如 QQ 那边）时一律拒绝。',
    ),
})
