window.__ModuleLoader__.load({
  id: 'dsh-familiar-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
    const card = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.22))',
      borderRadius: 10,
      padding: '14px 16px',
      marginBottom: 12,
      background: 'var(--dsw-alias-bg-layer, transparent)',
    }
    const muted = { color: 'var(--dsw-alias-text-secondary, #888)', fontSize: 12 }
    const sectionTitle = { fontSize: 13, fontWeight: 600, margin: '0 0 10px' }

    function MemoryIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('circle', { cx: 9, cy: 9, r: 2.2, fill: 'currentColor', opacity: 0.95 }),
        h('circle', { cx: 16, cy: 7, r: 1.6, fill: 'currentColor', opacity: 0.7 }),
        h('circle', { cx: 15.5, cy: 15, r: 2.4, fill: 'currentColor', opacity: 0.9 }),
        h('circle', { cx: 8.5, cy: 16.5, r: 1.8, fill: 'currentColor', opacity: 0.75 }),
        h('g', { stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.55, strokeLinecap: 'round' },
          h('line', { x1: 9, y1: 9, x2: 16, y2: 7 }),
          h('line', { x1: 9, y1: 9, x2: 8.5, y2: 16.5 }),
          h('line', { x1: 8.5, y1: 16.5, x2: 15.5, y2: 15 }),
          h('line', { x1: 16, y1: 7, x2: 15.5, y2: 15 }),
        ),
      )
    }

    function formatDate(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    function MemoryPage() {
      const [state, setState] = React.useState({ phase: 'idle', data: null, error: '' })

      const load = React.useCallback(() => {
        setState({ phase: 'loading', data: null, error: '' })
        fetch('/remember/memory.json', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
          .then((data) => setState({ phase: 'ready', data, error: '' }))
          .catch((err) => setState({ phase: 'error', data: null, error: String((err && err.message) || err) }))
      }, [])

      React.useEffect(() => { load() }, [load])

      const data = state.data
      const facts = data && Array.isArray(data.facts) ? data.facts : []
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : []

      return h(
        'div',
        { style: { padding: '24px 28px', maxWidth: 860, margin: '0 auto', overflowY: 'auto', height: '100%' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 } },
          h('h1', { style: { fontSize: 18, fontWeight: 600, margin: 0 } }, '长期记忆'),
          h('span', { style: muted }, state.phase === 'loading' ? '读取中…' : (data ? '共 ' + facts.length + ' 条事实 · ' + sessions.length + ' 个会话卡' : '')),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginLeft: 'auto', fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))',
              background: 'transparent', color: 'inherit',
            },
          }, '刷新'),
        ),
        data && data.dir ? h('div', { style: { ...muted, fontFamily: MONO, marginBottom: 18 } }, data.dir) : null,

        state.phase === 'error'
          ? h('div', { style: card },
              h('div', { style: sectionTitle }, '读不到记忆数据'),
              h('div', { style: muted }, state.error),
              h('div', { style: { ...muted, marginTop: 8 } }, '记忆数据仍然在本地记忆目录里（默认 ~/.dsh/memory），可以直接用编辑器打开。'),
            )
          : null,

        data
          ? h('div', null,
              h('div', { style: card },
                h('div', { style: sectionTitle }, '长期画像（常驻注入）'),
                data.profile
                  ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: MONO, fontSize: 12, lineHeight: 1.7 } }, data.profile)
                  : h('div', { style: muted }, '（空）'),
                h('div', { style: { ...muted, marginTop: 10 } }, '会话内冻结：手改 profile.md 后，新会话开始时才重新加载。'),
              ),

              h('div', { style: card },
                h('div', { style: sectionTitle }, '已确认的长期事实（' + facts.length + '）'),
                facts.length === 0
                  ? h('div', { style: muted }, '（空）')
                  : h('div', null, facts.map((f) => h('div', {
                      key: f.id,
                      style: { display: 'flex', gap: 10, padding: '7px 0', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.14))' },
                    },
                    h('span', { style: { ...muted, fontFamily: MONO, flex: '0 0 78px' } }, formatDate(f.createdAt)),
                    h('span', { style: { fontSize: 13, lineHeight: 1.6 } }, f.text),
                    h('span', { style: { ...muted, marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap' } },
                      (f.origin === 'memory_remember' ? '手动' : '自动') + ' · ' + (f.source === 'inferred' ? '模型归纳' : '用户说的')),
                  ))),
              ),

              h('div', { style: card },
                h('div', { style: sectionTitle }, '会话卡（' + sessions.length + '，仅用于检索路由）'),
                sessions.length === 0
                  ? h('div', { style: muted }, '（空）')
                  : h('div', null, sessions.map((s) => h('div', {
                      key: s.id,
                      style: { display: 'flex', gap: 10, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.14))', fontSize: 13 },
                    },
                    h('span', { style: { ...muted, fontFamily: MONO, flex: '0 0 78px' } }, formatDate(s.createdAt)),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title || '(无标题)'),
                    h('span', { style: { ...muted, marginLeft: 'auto', flex: '0 0 auto' } }, (s.msgCount || 0) + ' 条'),
                  ))),
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'remember',
          order: 30,
          label: '记忆',
        }, MemoryIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'remember',
        }, MemoryPage))
      },
    }
  },
})
