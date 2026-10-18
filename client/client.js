/**
 * dsh-host-fs —— 设置页（浏览器半）。
 *
 * 零构建：宿主按 exports["./client"] 的字符串直接读这个文件、当经典脚本下发，
 * 所以这里不能有 import/export/JSX，只能 `window.__ModuleLoader__.load({ id, factory })`。
 * React 由模块表提供（`require("react")`），别打包自己的 React。
 *
 * 界面（「设置 → 插件 → 文件权限」）：
 *   ① 会话权限：四档模式 + 搜索框 + 按类别分组的会话勾选表（标题 + id）
 *   ② 路径权限：pathAllow / pathDeny 两个多行文本框
 *   ③ 保存：一次 POST 写入，不是勾一下存一下
 *
 * 数据来源是宿主的两条路由（见 lib/settings-host.js）：
 *   GET  /api/dsh-host-fs/config
 *   GET  /api/dsh-host-fs/sessions
 *   POST /api/dsh-host-fs/config
 *
 * 保存时前端只报「我看见了哪些会话 / 勾了哪些」，sessionList 由宿主用**当时的**
 * 配置重新拼 —— 通配、preset、已经不在列表里的旧会话 id 都不会被这次保存丢掉。
 */
window.__ModuleLoader__.load({
  id: 'dsh-host-fs',
  factory(require) {
    let React = require('react');
    // 冻结模块表里 react 是 ESM 互操作对象时，createElement 可能挂在 default 上
    if (React && !React.createElement && React.default) React = React.default;
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;
    const BASE = '/api/dsh-host-fs';

    /** 四档会话权限。label 是按钮上的字，hint 是下面那行说明。 */
    const MODES = [
      { value: 'off', label: '关闭', hint: '谁都不能用（默认）' },
      { value: 'allowlist', label: '白名单', hint: '只有勾选的会话能用' },
      { value: 'denylist', label: '黑名单', hint: '勾选的会话不能用，其余可以' },
      { value: 'all', label: '全部会话', hint: '任何会话都能用' },
    ];

    /** 会话分组。id 与宿主 lib/settings.js 的 groupOfSession 对应。 */
    const GROUPS = [
      { id: 'local', label: '本机会话', pattern: 'session-*' },
      { id: 'group', label: 'QQ 群聊', pattern: 'qq-group-*' },
      { id: 'private', label: 'QQ 私聊', pattern: 'qq-private-*' },
      { id: 'sub', label: '子会话', pattern: '其余' },
    ];

    const NAME_SUB = '(未命名)';

    /** 与宿主 guard.js 的 splitList 语义一致：换行 / 逗号 / 分号都认。 */
    function splitEntries(raw) {
      return String(raw || '')
        .split(/[\r\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    /** 读自己的路由；非 2xx 或 ok:false 都抛错，错误文本直接来自宿主。 */
    async function requestJson(method, pathname, body) {
      const init = { method, cache: 'no-store', headers: {} };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(BASE + pathname, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok === false) {
        const detail =
          payload !== null && payload.error !== undefined
            ? typeof payload.error === 'string'
              ? payload.error
              : payload.error.message || payload.error.code || JSON.stringify(payload.error)
            : `HTTP ${response.status}`;
        throw new Error(String(detail));
      }
      return payload;
    }

    // ------------------------------------------------------------ 样式
    const C = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      tertiary: 'var(--dsw-alias-label-tertiary, #9ca3af)',
      danger: 'var(--dsw-alias-label-error, #c02629)',
      ok: 'var(--dsw-alias-label-primary, #1d7a45)',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      soft: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
      inputBg: 'var(--dsw-alias-bg-base, transparent)',
    };

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '760px',
        padding: '2px 2px 20px',
        fontSize: '13px',
        lineHeight: 1.55,
        color: 'inherit',
      },
      section: { display: 'flex', flexDirection: 'column', gap: '8px' },
      sectionTitle: {
        margin: 0,
        fontSize: '14px',
        fontWeight: 650,
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
      },
      sectionHint: { margin: 0, color: C.sub, fontSize: '12px' },
      modeRow: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      modeButton: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '1px',
        cursor: 'pointer',
        border: C.border,
        borderRadius: '8px',
        padding: '6px 12px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: 1.35,
      },
      modeButtonActive: {
        borderColor: C.accent,
        background: C.soft,
        boxShadow: `inset 0 0 0 1px ${C.accent}`,
      },
      modeLabel: { fontWeight: 600 },
      modeHint: { color: C.sub, fontSize: '11px' },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      search: {
        flex: '1 1 220px',
        minWidth: '160px',
        border: C.border,
        borderRadius: '8px',
        padding: '6px 10px',
        background: C.inputBg,
        color: 'inherit',
        font: 'inherit',
      },
      smallButton: {
        cursor: 'pointer',
        border: C.border,
        borderRadius: '8px',
        padding: '5px 10px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
      },
      counter: { color: C.sub, fontSize: '12px' },
      list: {
        maxHeight: '380px',
        overflow: 'auto',
        border: C.border,
        borderRadius: '10px',
        padding: '4px 6px',
        background: C.soft,
      },
      group: { margin: '6px 0 10px' },
      groupHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '2px 4px',
        borderBottom: C.border,
        marginBottom: '2px',
      },
      groupLabel: { fontWeight: 650 },
      groupPattern: { color: C.tertiary, fontSize: '11px', fontFamily: 'ui-monospace,Consolas,monospace' },
      groupCount: { marginLeft: 'auto', color: C.sub, fontSize: '11px' },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '3px 6px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      rowText: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 4px', minWidth: 0 },
      rowTitle: { fontWeight: 500, overflowWrap: 'anywhere' },
      rowId: {
        color: C.sub,
        fontSize: '12px',
        fontFamily: 'ui-monospace,Consolas,monospace',
        overflowWrap: 'anywhere',
      },
      live: {
        color: C.ok,
        fontSize: '11px',
        border: `1px solid ${C.ok}`,
        borderRadius: '999px',
        padding: '0 6px',
        lineHeight: '16px',
        flex: '0 0 auto',
      },
      note: { margin: 0, color: C.sub, fontSize: '12px' },
      noteCode: {
        fontFamily: 'ui-monospace,Consolas,monospace',
        background: C.soft,
        borderRadius: '5px',
        padding: '0 4px',
        overflowWrap: 'anywhere',
      },
      warnBox: {
        border: '1px solid var(--dsw-alias-label-warning, #d9a400)',
        borderRadius: '8px',
        padding: '8px 10px',
        color: 'var(--dsw-alias-label-warning, #8a6d00)',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      fieldLabel: { fontWeight: 600 },
      fieldHint: { margin: 0, color: C.sub, fontSize: '12px' },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        resize: 'vertical',
        border: C.border,
        borderRadius: '8px',
        padding: '8px 10px',
        background: C.inputBg,
        color: 'inherit',
        font: '12px/1.5 ui-monospace,Consolas,monospace',
      },
      footer: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', paddingTop: '2px' },
      primary: {
        cursor: 'pointer',
        border: '1px solid #4d6bfe',
        background: '#4d6bfe',
        color: '#ffffff',
        borderRadius: '8px',
        padding: '6px 20px',
        font: 'inherit',
        fontWeight: 600,
      },
      okText: { color: C.ok, fontSize: '12px' },
      dangerText: { color: C.danger, fontSize: '12px' },
      empty: { color: C.sub, padding: '10px 6px' },
    };

    // ------------------------------------------------------- 组件
    function HostFsSettingsTab() {
      const [sessions, setSessions] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [warnings, setWarnings] = useState([]);
      const [canSave, setCanSave] = useState(true);
      const [draft, setDraft] = useState({ sessionMode: 'off', pathAllow: '', pathDeny: '' });
      const [checked, setChecked] = useState([]);
      const [extraRules, setExtraRules] = useState([]);
      const [query, setQuery] = useState('');
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const [reloadToken, setReloadToken] = useState(0);

      /** 把一份配置套到表单上：会话名单里「当前列表能认出来的精确 id」= 勾选，其余原样保留。 */
      function applyConfig(config, rows) {
        const known = new Map(rows.map((row) => [row.id.toLowerCase(), row.id]));
        const nextChecked = [];
        const nextExtra = [];
        for (const entry of splitEntries(config.sessionList || '')) {
          const canonical = known.get(entry.toLowerCase());
          if (canonical !== undefined) {
            if (!nextChecked.includes(canonical)) nextChecked.push(canonical);
          } else if (!nextExtra.some((item) => item.toLowerCase() === entry.toLowerCase())) {
            nextExtra.push(entry);
          }
        }
        setChecked(nextChecked);
        setExtraRules(nextExtra);
        setDraft({
          sessionMode: MODES.some((mode) => mode.value === config.sessionMode) ? config.sessionMode : 'off',
          pathAllow: typeof config.pathAllow === 'string' ? config.pathAllow : '',
          pathDeny: typeof config.pathDeny === 'string' ? config.pathDeny : '',
        });
      }

      useEffect(() => {
        let alive = true;
        setLoading(true);
        setError(null);
        setNotice(null);
        Promise.all([requestJson('GET', '/config'), requestJson('GET', '/sessions')])
          .then(([configPayload, sessionsPayload]) => {
            if (!alive) return;
            const rows = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
            setSessions(rows);
            setWarnings([].concat(configPayload.warnings || [], sessionsPayload.warnings || []));
            setCanSave(configPayload.canSave !== false);
            applyConfig(configPayload.config || {}, rows);
            setLoading(false);
          })
          .catch((reason) => {
            if (!alive) return;
            setError(reason && reason.message ? reason.message : String(reason));
            setLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [reloadToken]);

      const checkedSet = useMemo(
        () => new Set(checked.map((id) => id.toLowerCase())),
        [checked],
      );

      /** 按「最后一次更新时间」倒序：宿主用会话文件的 mtime 补 updatedAt，缺失时退回 createdAt。 */
      const ordered = useMemo(() => {
        const stamp = (row) => {
          if (Number.isFinite(row.updatedAt)) return row.updatedAt;
          if (Number.isFinite(row.createdAt)) return row.createdAt;
          return 0;
        };
        return sessions
          .slice()
          .sort((a, b) => stamp(b) - stamp(a) || String(b.id).localeCompare(String(a.id)));
      }, [sessions]);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q === '') return ordered;
        return ordered.filter(
          (row) => row.id.toLowerCase().includes(q) || String(row.title || '').toLowerCase().includes(q),
        );
      }, [ordered, query]);

      const grouped = useMemo(() => {
        const map = { local: [], group: [], private: [], sub: [] };
        for (const row of filtered) {
          const bucket = map[row.group] !== undefined ? map[row.group] : map.sub;
          bucket.push(row);
        }
        return map;
      }, [filtered]);

      /** 勾选的会话，按列表顺序（让 sessionList 稳定、好读）。 */
      const checkedInOrder = useMemo(
        () => sessions.filter((row) => checkedSet.has(row.id.toLowerCase())).map((row) => row.id),
        [sessions, checkedSet],
      );

      const activeMode = MODES.find((mode) => mode.value === draft.sessionMode) || MODES[0];
      const listMatters = draft.sessionMode === 'allowlist' || draft.sessionMode === 'denylist';

      function patchDraft(patch) {
        setDraft((previous) => Object.assign({}, previous, patch));
      }

      function toggleSession(id, on) {
        setChecked((previous) => {
          const key = id.toLowerCase();
          const without = previous.filter((item) => item.toLowerCase() !== key);
          return on ? without.concat(id) : without;
        });
      }

      function setFilteredChecked(on) {
        setChecked((previous) => {
          const next = new Set(previous.map((item) => item.toLowerCase()));
          for (const row of filtered) {
            if (on) next.add(row.id.toLowerCase());
            else next.delete(row.id.toLowerCase());
          }
          return sessions.filter((row) => next.has(row.id.toLowerCase())).map((row) => row.id);
        });
      }

      async function onSave() {
        if (saving || !canSave) return;
        setSaving(true);
        setNotice(null);
        try {
          const payload = await requestJson('POST', '/config', {
            sessionMode: draft.sessionMode,
            visibleSessionIds: sessions.map((row) => row.id),
            checkedSessionIds: checkedInOrder,
            pathAllow: draft.pathAllow,
            pathDeny: draft.pathDeny,
          });
          applyConfig(payload.config || {}, sessions);
          setNotice({
            kind: 'ok',
            text: '已保存到 profile 的 dsh-host-fs 配置行。插件会按新配置重载，闸门立即按新值生效。',
          });
        } catch (reason) {
          setNotice({
            kind: 'error',
            text: '保存失败：' + (reason && reason.message ? reason.message : String(reason)),
          });
        } finally {
          setSaving(false);
        }
      }

      function renderRow(row) {
        const isChecked = checkedSet.has(row.id.toLowerCase());
        return h(
          'label',
          { key: row.id, style: styles.row, title: row.id },
          h('input', {
            type: 'checkbox',
            checked: isChecked,
            onChange: (event) => toggleSession(row.id, event.target.checked),
            style: { marginTop: '3px', flex: '0 0 auto' },
          }),
          h(
            'span',
            { style: styles.rowText },
            h('span', { style: styles.rowTitle }, row.title || NAME_SUB),
            h('span', { style: styles.rowId }, '（' + row.id + '）'),
          ),
          row.live === true ? h('span', { style: styles.live }, '在线') : null,
        );
      }

      if (loading) {
        return h('div', { style: styles.page }, h('p', { style: styles.note }, '正在读取会话与配置…'));
      }
      if (error !== null) {
        return h(
          'div',
          { style: styles.page },
          h('p', { style: styles.dangerText }, '读取失败：' + error),
          h('p', { style: styles.note }, '如果刚装完插件，先重启宿主再打开这一页；路由要等插件重新加载后才会挂上。'),
          h(
            'div',
            { style: styles.footer },
            h(
              'button',
              {
                type: 'button',
                style: styles.smallButton,
                onClick: () => setReloadToken((value) => value + 1),
              },
              '重新加载',
            ),
          ),
        );
      }

      const children = [];

      if (warnings.length > 0) {
        children.push(
          h(
            'div',
            { key: 'warnings', style: styles.warnBox },
            warnings.map((warning, index) => h('div', { key: String(index) }, '⚠ ' + warning)),
          ),
        );
      }

      // ① 会话权限
      children.push(
        h(
          'section',
          { key: 'sessions', style: styles.section },
          h(
            'h3',
            { style: styles.sectionTitle },
            '会话权限',
            h('span', { style: styles.sectionHint }, '挡的是「能不能调用这两个工具」'),
          ),
          h(
            'div',
            { style: styles.modeRow },
            MODES.map((mode) =>
              h(
                'button',
                {
                  key: mode.value,
                  type: 'button',
                  'aria-pressed': draft.sessionMode === mode.value ? 'true' : 'false',
                  style:
                    draft.sessionMode === mode.value
                      ? Object.assign({}, styles.modeButton, styles.modeButtonActive)
                      : styles.modeButton,
                  onClick: () => patchDraft({ sessionMode: mode.value }),
                },
                h('span', { style: styles.modeLabel }, mode.label),
                h('span', { style: styles.modeHint }, mode.hint),
              ),
            ),
          ),
          h(
            'p',
            { style: styles.sectionHint },
            '当前：' + activeMode.label + ' —— ' + activeMode.hint +
              (listMatters ? '，勾选只对下面的名单生效。' : '，名单仍会保存，但这一档不看它。'),
          ),
          h(
            'div',
            { style: styles.toolbar },
            h('input', {
              type: 'search',
              style: styles.search,
              value: query,
              placeholder: '搜索会话标题或会话 id…',
              'aria-label': '搜索会话',
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'button',
              { type: 'button', style: styles.smallButton, onClick: () => setFilteredChecked(true) },
              '勾选当前筛选',
            ),
            h(
              'button',
              { type: 'button', style: styles.smallButton, onClick: () => setFilteredChecked(false) },
              '取消当前筛选',
            ),
            h(
              'button',
              {
                type: 'button',
                style: styles.smallButton,
                onClick: () => setReloadToken((value) => value + 1),
              },
              '刷新列表',
            ),
          ),
          h(
            'p',
            { style: styles.counter },
            '已勾选 ' + checkedInOrder.length + ' 个会话 / 共 ' + sessions.length + ' 个' +
              (query.trim() === '' ? '' : '（筛选后 ' + filtered.length + ' 个）'),
          ),
          extraRules.length > 0
            ? h(
                'p',
                { style: styles.note },
                '配置里还有这些不是会话 id 的规则，保存时原样保留：',
                h('code', { style: styles.noteCode }, extraRules.join('  ·  ')),
              )
            : null,
          h(
            'div',
            { style: styles.list, role: 'group', 'aria-label': '会话勾选表' },
            filtered.length === 0
              ? h('div', { style: styles.empty }, sessions.length === 0 ? '宿主没有返回任何会话。' : '没有匹配的会话。')
              : GROUPS.map((group) => {
                  const rows = grouped[group.id] || [];
                  if (rows.length === 0) return null;
                  return h(
                    'div',
                    { key: group.id, style: styles.group },
                    h(
                      'div',
                      { style: styles.groupHead },
                      h('span', { style: styles.groupLabel }, group.label),
                      h('span', { style: styles.groupPattern }, group.pattern),
                      h('span', { style: styles.groupCount }, rows.length + ' 个'),
                    ),
                    rows.map(renderRow),
                  );
                }),
          ),
        ),
      );

      // ② 路径权限
      children.push(
        h(
          'section',
          { key: 'paths', style: styles.section },
          h(
            'h3',
            { style: styles.sectionTitle },
            '路径权限',
            h('span', { style: styles.sectionHint }, '写进去的路径包含它下面所有子路径'),
          ),
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, '路径白名单 pathAllow'),
            h(
              'p',
              { style: styles.fieldHint },
              '一行一条。默认空 = 什么都不允许（默认拒绝）；黑名单优先于白名单；驱动器根永远拒绝，不受这里影响。',
            ),
            h('textarea', {
              style: styles.textarea,
              rows: 4,
              spellCheck: false,
              value: draft.pathAllow,
              placeholder: 'D:\\dsh-home',
              onChange: (event) => patchDraft({ pathAllow: event.target.value }),
            }),
          ),
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, '路径黑名单 pathDeny'),
            h(
              'p',
              { style: styles.fieldHint },
              '一行一条，优先级高于白名单。例：白名单 D:\\dsh-home、黑名单 D:\\dsh-home\\profiles ⇒ 可以动 D:\\dsh-home 及其子项，但动不了 profiles 及其子项。',
            ),
            h('textarea', {
              style: styles.textarea,
              rows: 4,
              spellCheck: false,
              value: draft.pathDeny,
              placeholder: 'D:\\dsh-home\\profiles',
              onChange: (event) => patchDraft({ pathDeny: event.target.value }),
            }),
          ),
        ),
      );

      // ③ 保存
      children.push(
        h(
          'div',
          { key: 'footer', style: styles.footer },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, styles.primary, saving || !canSave ? { opacity: 0.55, cursor: 'default' } : null),
              disabled: saving || !canSave,
              onClick: onSave,
            },
            saving ? '保存中…' : '保存',
          ),
          h(
            'span',
            { style: styles.note },
            canSave
              ? '一次写入 profile 的 dsh-host-fs 配置行；勾选本身不会立刻保存。'
              : '宿主没有 configEditor，无法从界面保存（请手工编辑 profile 的 cordis.patch.yml）。',
          ),
          notice !== null
            ? h(
                'span',
                { style: notice.kind === 'ok' ? styles.okText : styles.dangerText },
                notice.text,
              )
            : null,
        ),
      );

      return h('div', { style: styles.page }, children);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'dsh-host-fs',
              order: 60,
              label: () => '文件权限',
            },
            HostFsSettingsTab,
          ),
        );
      },
    };
  },
});
