window.__ModuleLoader__.load({
  id: 'dsh-local-kb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/api/local-kb'
    // Set from apply(ctx): the page needs it for `uiWorkspace.pickDirectory()`.
    let uiCtx = null

    async function request(pathname, body, { timeoutMs = 20000 } = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
      const init =
        body === undefined
          ? { headers: { accept: 'application/json' }, signal: controller.signal }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            }
      let response
      try {
        response = await fetch(`${API}${pathname}`, init)
      } catch (error) {
        throw new Error(
          error?.name === 'AbortError'
            ? `知识库服务 ${Math.round(timeoutMs / 1000)} 秒未响应，已放弃这次请求。`
            : `连不上本地知识库服务：${error?.message ?? error}`,
        )
      } finally {
        clearTimeout(timer)
      }
      const text = await response.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`知识库服务返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 140)}`)
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    const MODE_TEXT = {
      keyword: '关键词',
      semantic: '向量',
      'keyword+rerank': '关键词 + 重排',
      'semantic+rerank': '向量 + 重排',
      empty: '无索引',
    }

    function draftFromConfig(config) {
      return {
        name: config.name ?? '',
        root: config.root ?? '',
        libraries: (config.libraries ?? []).map((library) => ({
          id: library.id,
          name: library.name,
          root: library.root,
        })),
        embedding: { ...config.embedding },
        rerank: { ...config.rerank },
        ocr: { ...(config.ocr ?? {}) },
      }
    }

    const CSS = `
.lkb-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.lkb-side{width:272px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.lkb-side-head{padding:14px 14px 6px}
.lkb-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}
.lkb-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:3px;word-break:break-all}
.lkb-side-tools{padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap}
.lkb-libs{display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 0}
.lkb-chip-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lkb-chip-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.lkb-chip-btn.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.lkb-chip-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.lkb-chip-btn.add{border-style:dashed;color:var(--dsw-alias-brand-primary)}
.lkb-chip-count{font-size:11px;opacity:.75}
.lkb-tag{margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:0.85em;color:var(--dsw-alias-label-secondary);font-weight:400}
.lkb-list{flex:1;overflow:auto;padding:4px 6px 14px}
.lkb-item{padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;border:1px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;width:100%}
.lkb-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.lkb-item:hover{background:var(--dsw-alias-bg-layer-2)}
.lkb-item.active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.lkb-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lkb-item-meta{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}
.lkb-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.lkb-head{padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:flex-start;gap:12px}
.lkb-head-main{flex:1;min-width:0}
.lkb-head-title{font-size:15px;font-weight:600}
.lkb-head-path{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:2px;word-break:break-all}
.lkb-head-actions{display:flex;gap:6px;flex:none}
.lkb-tabs{display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.lkb-tab{padding:7px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;font-size:13px}
.lkb-tab:hover{color:var(--dsw-alias-label-primary)}
.lkb-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.lkb-body{flex:1;overflow:auto;padding:14px 18px 26px}
.lkb-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.lkb-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.lkb-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.lkb-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.lkb-chip.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.lkb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lkb-input,.lkb-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 9px;font-size:13px;outline:none;min-width:0}
.lkb-input:focus,.lkb-select:focus{border-color:var(--dsw-alias-brand-primary)}
.lkb-input.wide{flex:1;min-width:220px}
.lkb-input.tiny{width:88px}
.lkb-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer}
.lkb-btn:hover{border-color:var(--dsw-alias-border-l2)}
.lkb-btn:disabled{opacity:.5;cursor:not-allowed}
.lkb-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.lkb-btn.ghost{background:transparent}
.lkb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.lkb-card-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
.lkb-card-path{font-weight:600;font-size:12.5px;word-break:break-all;cursor:pointer;background:transparent;border:0;padding:0;color:inherit;font-family:inherit;text-align:left}
.lkb-card-path:hover,.lkb-card-path:focus-visible{color:var(--dsw-alias-brand-primary)}
.lkb-card-score{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}
.lkb-snippet{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
.lkb-snippet em{font-style:normal;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:3px;padding:0 2px}
.lkb-empty{color:var(--dsw-alias-label-secondary);padding:28px 0;text-align:center;font-size:12.5px}
.lkb-notice{font-size:12px;border-radius:6px;padding:7px 10px;margin-bottom:12px;white-space:pre-wrap;word-break:break-word}
.lkb-notice.info{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.lkb-notice.err{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.lkb-notice.ok{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.lkb-section{margin-bottom:20px}
.lkb-section-title{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.lkb-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;flex:1;min-width:180px}
.lkb-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.lkb-field .hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.lkb-grid{display:flex;gap:10px;flex-wrap:wrap}
.lkb-pre{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px}
.lkb-doc-head{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:10px}
.lkb-doc-path{font-weight:600;word-break:break-all}
.lkb-line{color:var(--dsw-alias-label-secondary);user-select:none;display:inline-block;width:3.4em;text-align:right;margin-right:10px}
.lkb-link{color:var(--dsw-alias-brand-primary);cursor:pointer;background:none;border:0;padding:0;font-size:12px;font-family:inherit;text-decoration:underline}
.lkb-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);margin:8px 0}.lkb-check input{width:16px;height:16px}.lkb-lib-row{display:grid;grid-template-columns:140px 1fr auto;gap:8px;align-items:center;margin:6px 0}.lkb-lib-add{display:grid;grid-template-columns:minmax(110px,1fr) minmax(160px,1.6fr) auto auto;gap:8px;margin-top:10px}
.lkb-fieldset{border:0;margin:0;padding:0;min-width:0}
.lkb-notice.info .lkb-link{color:var(--dsw-alias-brand-primary)}
.lkb-kicker{font-size:11px;color:var(--dsw-alias-label-secondary)}
.lkb-key{display:flex;gap:6px;align-items:center}
`

    function injectStyle() {
      if (typeof document === 'undefined') return
      const id = 'dsh-local-kb-style'
      if (document.getElementById(id)) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function fmtSize(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function fmtTime(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function baseName(relative) {
      const parts = String(relative).split('/')
      return parts[parts.length - 1] || relative
    }

    function dirName(relative) {
      const parts = String(relative).split('/')
      parts.pop()
      return parts.join('/')
    }

    function highlight(text, query) {
      const source = String(text ?? '')
      const terms = String(query ?? '')
        .split(/[\s,，。;；:：!?！？]+/)
        .filter((term) => term.length >= 1)
      if (terms.length === 0) return source
      const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
      const nodes = []
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        nodes.push(h('em', { key: `hl-${index}` }, match[0]))
        last = match.index + match[0].length
        index += 1
        if (match[0].length === 0) pattern.lastIndex += 1
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    function SidebarIcon({ active }) {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 6.2A2.2 2.2 0 0 1 6.2 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6.2A2.2 2.2 0 0 1 4 17.8z' }),
        h('path', { d: 'M8 4v16' }),
        h('path', { d: 'M11.2 9.4h5.4M11.2 13h3.6' }),
      )
    }

    function Chip({ tone, children }) {
      return h('span', { className: `lkb-chip${tone ? ` ${tone}` : ''}` }, children)
    }

    function Notice({ kind, children }) {
      if (!children) return null
      return h(
        'div',
        { className: `lkb-notice ${kind}`, role: kind === 'err' ? 'alert' : 'status' },
        children,
      )
    }

    const useFieldId = typeof React.useId === 'function' ? React.useId : null
    let fieldSeq = 0

    function Field({ label, hint, children }) {
      // A stable id only matters for the label/control pair; fall back to a
      // per-instance counter on React builds without useId.
      const generated = useFieldId ? useFieldId() : null
      const fallbackRef = useRef(null)
      if (!fallbackRef.current) fallbackRef.current = `lkb-field-${(fieldSeq += 1)}`
      const id = generated ?? fallbackRef.current
      const linked =
        React.isValidElement(children) && (children.type === 'input' || children.type === 'select')
          ? React.cloneElement(children, { id })
          : children
      return h(
        'div',
        { className: 'lkb-field' },
        h('label', { htmlFor: linked === children ? undefined : id }, label),
        linked,
        hint ? h('span', { className: 'hint' }, hint) : null,
      )
    }

    function KnowledgePage() {
      injectStyle()
      const [state, setState] = useState(null)
      const [docs, setDocs] = useState(null)
      const [docsError, setDocsError] = useState('')
      const [tab, setTab] = useState('search')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [filter, setFilter] = useState('')
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [rerankOn, setRerankOn] = useState(true)
      const [doc, setDoc] = useState(null)
      const [readError, setReadError] = useState('')
      const [draft, setDraft] = useState(null)
      const [keys, setKeys] = useState({ embedding: '', rerank: '', ocr: '' })
      const [restarting, setRestarting] = useState(false)
      const [scope, setScope] = useState('all')
      const [newLibrary, setNewLibrary] = useState({ name: '', root: '' })
      const pollRef = useRef(0)
      const draftInitRef = useRef(false)
      const searchSeqRef = useRef(0)
      const readSeqRef = useRef(0)

      // `draft` is deliberately not a dependency: it changes on every keystroke,
      // and re-creating these callbacks would re-run the initial load (two full
      // directory scans per character on a large library).
      const loadState = useCallback(async () => {
        const payload = await request('/state')
        setState(payload)
        if (!draftInitRef.current) {
          draftInitRef.current = true
          setDraft(draftFromConfig(payload.config))
        }
        return payload
      }, [])

      const loadDocs = useCallback(async () => {
        try {
          const payload = await request('/docs')
          setDocs(payload)
          setDocsError('')
          return payload
        } catch (failure) {
          setDocsError(String(failure?.message ?? failure))
          throw failure
        }
      }, [])

      const refresh = useCallback(
        async (quiet = false) => {
          try {
            await Promise.all([loadState(), loadDocs()])
            if (!quiet) setError('')
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          }
        },
        [loadState, loadDocs],
      )

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          setBusy('init')
          try {
            await refresh(true)
          } finally {
            if (!cancelled) setBusy('')
          }
        })()
        return () => {
          cancelled = true
        }
      }, [refresh])

      // After a settings save the plugin restarts and drops the route for a moment.
      // Reaching /state again is NOT proof the save worked: the write happens after
      // the response, so the verdict comes from `saveError` on the state payload.
      useEffect(() => {
        if (!restarting) return
        let stopped = false
        const tick = async () => {
          if (stopped) return
          try {
            const payload = await request('/state')
            if (stopped) return
            setState(payload)
            if (payload.saveError) {
              setRestarting(false)
              setBusy('')
              setKeys({ embedding: '', rerank: '', ocr: '' })
              setNotice({
                kind: 'err',
                text: `设置没有写入存储：${payload.saveError}\n请重试，或直接编辑 profile 的 cordis.patch.yml。`,
              })
              return
            }
            setDraft((current) => (current ? draftFromConfig(payload.config) : current))
            setRestarting(false)
            setBusy('')
            setKeys({ embedding: '', rerank: '', ocr: '' })
            setNotice({ kind: 'ok', text: '设置已生效，插件已重新加载。' })
            await loadDocs().catch(() => {})
          } catch {
            pollRef.current += 1
            if (pollRef.current > 40) {
              setRestarting(false)
              setBusy('')
              setNotice({
                kind: 'err',
                text: '保存后服务一直没有恢复：请刷新页面；若仍失败，检查 profile 的 cordis.patch.yml 是否写坏。',
              })
            } else {
              setTimeout(tick, 600)
            }
          }
        }
        pollRef.current = 0
        setTimeout(tick, 900)
        return () => {
          stopped = true
        }
      }, [restarting, loadDocs])

      const status = state?.status ?? null
      const config = state?.config ?? null
      const libraries = draft?.libraries ?? config?.libraries ?? []
      const scopedLibrary = scope === 'all' ? null : libraries.find((library) => library.id === scope) ?? null
      const files = docs?.files ?? []
      const visibleFiles = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        const rows = scope === 'all' ? files : files.filter((file) => file.library?.id === scope)
        const matched =
          needle === ''
            ? rows
            : rows.filter(
                (file) =>
                  file.path.toLowerCase().includes(needle) || (file.library?.name ?? '').toLowerCase().includes(needle),
              )
        return matched.slice().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      }, [files, filter, scope])

      /** The config object both probes and saves send: shared models + the library list. */
      const configPayload = useCallback(() => {
        if (!draft) return null
        return {
          libraries: draft.libraries.map((library) => ({
            id: library.id,
            name: library.name,
            root: library.root,
          })),
          embedding: {
            provider: draft.embedding.provider,
            baseUrl: draft.embedding.baseUrl,
            model: draft.embedding.model,
            apiKeyEnv: draft.embedding.apiKeyEnv,
            batchSize: draft.embedding.batchSize,
          },
          rerank: {
            enabled: Boolean(draft.rerank.enabled),
            provider: draft.rerank.provider,
            baseUrl: draft.rerank.baseUrl,
            model: draft.rerank.model,
            apiKeyEnv: draft.rerank.apiKeyEnv,
            topN: draft.rerank.topN,
            candidates: draft.rerank.candidates,
          },
          ocr: {
            enabled: Boolean(draft.ocr?.enabled),
            baseUrl: draft.ocr?.baseUrl ?? '',
            model: draft.ocr?.model ?? '',
            apiKeyEnv: draft.ocr?.apiKeyEnv ?? '',
            dpi: draft.ocr?.dpi,
            maxPages: draft.ocr?.maxPages,
            concurrency: draft.ocr?.concurrency,
            mutoolPath: draft.ocr?.mutoolPath ?? '',
          },
        }
      }, [draft])

      const runSearch = useCallback(async () => {
        const text = query.trim()
        if (text === '') return
        const seq = (searchSeqRef.current += 1)
        setBusy('search')
        setError('')
        try {
          const payload = await request('/search', {
            query: text,
            limit: config?.topK ?? 8,
            rerank: rerankOn,
            library: scope === 'all' ? undefined : scope,
          })
          if (seq !== searchSeqRef.current) return
          setResults(payload)
        } catch (failure) {
          if (seq !== searchSeqRef.current) return
          setError(String(failure?.message ?? failure))
          setResults(null)
        } finally {
          if (seq === searchSeqRef.current) setBusy('')
        }
      }, [query, config, rerankOn, scope])

      const openDoc = useCallback(async (relativePath, startLine = 1, libraryId) => {
        const seq = (readSeqRef.current += 1)
        setTab('docs')
        setBusy('read')
        setError('')
        setReadError('')
        try {
          const payload = await request('/read', {
            path: relativePath,
            offset: Math.max(1, Number(startLine) - 2),
            limit: 400,
            library: libraryId,
          })
          if (seq !== readSeqRef.current) return
          setDoc(payload)
        } catch (failure) {
          if (seq !== readSeqRef.current) return
          setReadError(`打不开 ${relativePath}：${String(failure?.message ?? failure)}`)
          setDoc(null)
        } finally {
          if (seq === readSeqRef.current) setBusy('')
        }
      }, [])

      const loadMore = useCallback(async () => {
        if (!doc?.truncated) return
        setBusy('read')
        try {
          const offset = doc.offset + doc.text.split('\n').length
          const payload = await request('/read', { path: doc.path, offset, limit: 600, library: doc.library?.id })
          setDoc({ ...payload, offset: doc.offset, text: `${doc.text}\n${payload.text}` })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [doc])

      const runIndex = useCallback(
        async (action) => {
          setBusy(action)
          setError('')
          setNotice(null)
          try {
            // Probes test what is typed in the form (unsaved included), so a
            // wrong endpoint is caught before saving and reloading.
            const probing = action === 'probe' || action === 'probe-rerank' || action === 'probe-ocr'
            const base = { action, library: scope === 'all' ? undefined : scope }
            const payload = await request(
              '/index',
              probing && draft
                ? { ...base, config: configPayload(), keys: { embedding: keys.embedding, rerank: keys.rerank, ocr: keys.ocr } }
                : base,
              { timeoutMs: action === 'rebuild' ? 900000 : 180000 },
            )
            if (action === 'rebuild') {
              const perLibrary = Array.isArray(payload.libraries) ? payload.libraries : null
              const unsupported = payload.unsupported ?? []
              const skipped = payload.skipped ?? []
              const failures = payload.errors ?? []
              const details = []
              if (payload.embeddingError) details.push(`向量化失败：${payload.embeddingError}`)
              if (unsupported.length > 0) {
                details.push(`未支持的格式：${unsupported.map((row) => `${row.extension}×${row.count}`).join('、')}`)
              }
              if (skipped.length > 0) details.push(`跳过 ${skipped.length} 个文件`)
              if (failures.length > 0) {
                details.push(`解析失败 ${failures.length} 个：${String(failures[0]?.reason ?? failures[0]?.error ?? '').slice(0, 120)}`)
              }
              for (const item of perLibrary ?? []) {
                details.push(`「${item.name}」${item.fileCount ?? 0} 个文件 / ${item.chunkCount ?? 0} 个片段`)
                if (item.embeddingError) details.push(`「${item.name}」向量化失败：${item.embeddingError}`)
              }
              const warn =
                Boolean(payload.embeddingError) ||
                failures.length > 0 ||
                (perLibrary ?? []).some((item) => item.embeddingError)
              setNotice({
                kind: warn ? 'err' : 'ok',
                text: [
                  `索引完成：${payload.fileCount ?? 0} 个文件 / ${payload.chunkCount ?? 0} 个片段，用时 ${((payload.durationMs ?? 0) / 1000).toFixed(1)} 秒，模式 ${payload.mode === 'semantic' ? '向量' : '关键词'}。`,
                  ...details,
                ].join('\n'),
              })
              await refresh(true)
            } else if (action === 'probe') {
              setNotice({
                kind: 'ok',
                text: [
                  `embedding 可用：${payload.provider} / ${payload.model}，维度 ${payload.dim}，耗时 ${payload.ms} ms。`,
                  `索引里已有 ${payload.indexed} 个片段（维度 ${payload.indexedDim}）。${payload.tested === 'form' ? '（用的是表单里当前的地址与密钥）' : '（用的是已保存的配置）'}`,
                ].join('\n'),
              })
            } else if (action === 'probe-rerank') {
              setNotice({
                kind: 'ok',
                text: [
                  `重排可用：${payload.model}，耗时 ${payload.ms} ms，返回 ${payload.rows?.length ?? 0} 条分数（前 3 名 ${(payload.rows ?? []).map((row) => row.score).join(' / ')}）。`,
                  payload.tested === 'form' ? '用的是表单里当前的地址与密钥。' : '用的是已保存的配置。',
                ].join('\n'),
              })
            } else if (action === 'probe-ocr') {
              setNotice({
                kind: 'ok',
                text: [
                  `OCR 可用：${payload.model}，渲染并识别了 1 页（取样文件 ${payload.sample}），耗时 ${(payload.ms / 1000).toFixed(1)} 秒，识别出 ${payload.chars} 个字。`,
                  payload.preview ? `识别样例：${payload.preview}` : '',
                  payload.tested === 'form' ? '用的是表单里当前的地址、模型与密钥。' : '用的是已保存的配置。',
                ]
                  .filter(Boolean)
                  .join('\n'),
              })
            }
          } catch (failure) {
            setNotice({ kind: 'err', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [draft, keys, refresh, scope, configPayload],
      )

      const saveSettings = useCallback(async () => {
        if (!draft) return
        setBusy('save')
        setError('')
        setNotice(null)
        try {
          const keysPayload = {}
          if (keys.embedding !== '') keysPayload.embedding = keys.embedding
          if (keys.rerank !== '') keysPayload.rerank = keys.rerank
          if (keys.ocr !== '') keysPayload.ocr = keys.ocr
          const payload = await request('/settings', {
            config: configPayload(),
            keys: keysPayload,
          })
          setKeys({ embedding: '', rerank: '', ocr: '' })
          setNotice({ kind: 'info', text: payload.note ?? '设置已提交。' })
          setRestarting(true)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          setBusy('')
        }
      }, [draft, keys, configPayload])

      /** Add / rename / remove a folder, then let the reload bring the list back. */
      const commitLibraries = useCallback(
        async (nextLibraries) => {
          if (!draft) return
          setBusy('save')
          setError('')
          setNotice(null)
          try {
            const payload = await request('/settings', {
              config: { ...configPayload(), libraries: nextLibraries },
            })
            setNotice({ kind: 'info', text: payload.note ?? '已提交，插件正在重启。' })
            setRestarting(true)
          } catch (failure) {
            setError(String(failure?.message ?? failure))
            setBusy('')
          }
        },
        [draft, configPayload],
      )

      const addLibrary = useCallback(async () => {
        const root = newLibrary.root.trim()
        if (root === '') {
          setError('请填写文件夹的绝对路径。')
          return
        }
        const name = newLibrary.name.trim() || root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
        const next = [...(draft?.libraries ?? []), { name, root }]
        setNewLibrary({ name: '', root: '' })
        await commitLibraries(next)
      }, [newLibrary, draft, commitLibraries])

      const removeLibrary = useCallback(
        async (library) => {
          const confirmed =
            typeof window === 'undefined' || typeof window.confirm !== 'function'
              ? true
              : window.confirm(`从列表里移除「${library.name}」？\n\n只会取消挂载，不会删除磁盘上的文件和 .dsh-kb 索引。`)
          if (!confirmed) return
          const next = (draft?.libraries ?? []).filter((item) => item.root !== library.root)
          if (next.length === 0) {
            setError('至少要保留一个知识库文件夹。')
            return
          }
          await commitLibraries(next)
        },
        [draft, commitLibraries],
      )

      const pickFolder = useCallback(async () => {
        const workspace = uiCtx?.get?.('uiWorkspace')
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setError('当前宿主没有目录选择器：直接输入文件夹的绝对路径即可。')
          return
        }
        try {
          const picked = await workspace.pickDirectory()
          if (typeof picked === 'string' && picked !== '') {
            setNewLibrary((current) => ({
              name: current.name || picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '',
              root: picked,
            }))
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      const clearKey = useCallback(
        async (slot) => {
          const label = slot === 'embedding' ? 'embedding' : slot === 'ocr' ? 'OCR' : '重排'
          const confirmed =
            typeof window === 'undefined' || typeof window.confirm !== 'function'
              ? true
              : window.confirm(`删除已保存的${label}密钥？插件会重启一次，检索会短暂不可用。`)
          if (!confirmed) return
          setBusy('save')
          setError('')
          try {
            await request('/settings', { keys: { [slot]: '' } })
            setNotice({ kind: 'info', text: `已删除保存的${label}密钥，插件正在重新加载。` })
            setRestarting(true)
          } catch (failure) {
            setError(String(failure?.message ?? failure))
            setBusy('')
          }
        },
        [],
      )

      const updateDraft = useCallback((path, value) => {
        setDraft((current) => {
          if (!current) return current
          const next = {
            ...current,
            embedding: { ...current.embedding },
            rerank: { ...current.rerank },
            ocr: { ...(current.ocr ?? {}) },
          }
          const parts = path.split('.')
          if (parts.length === 1) next[parts[0]] = value
          else next[parts[0]][parts[1]] = value
          return next
        })
      }, [])

      const statusChips = []
      if (status) {
        statusChips.push(h(Chip, { key: 'files', tone: 'ok' }, `${status.files ?? 0} 个文件`))
        statusChips.push(h(Chip, { key: 'chunks' }, `${status.chunks ?? 0} 个片段`))
        statusChips.push(
          h(Chip, { key: 'mode', tone: status.mode === 'semantic' ? 'ok' : 'warn' }, status.mode === 'semantic' ? '向量检索' : '关键词检索'),
        )
        if (status.rerank?.enabled) statusChips.push(h(Chip, { key: 'rerank', tone: 'ok' }, `重排 ${status.rerank.model}`))
        if (status.stale) statusChips.push(h(Chip, { key: 'stale', tone: 'warn' }, `索引过期：${status.staleReason || '有文件变化'}`))
        if (status.embeddingError) statusChips.push(h(Chip, { key: 'emb', tone: 'err' }, '向量化失败'))
        if (!status.indexed) statusChips.push(h(Chip, { key: 'none', tone: 'warn' }, '尚未建立索引'))
      }

      const header = h(
        'div',
        { className: 'lkb-head' },
        h(
          'div',
          { className: 'lkb-head-main' },
          h(
            'div',
            { className: 'lkb-head-title' },
            scopedLibrary ? scopedLibrary.name : libraries.length > 1 ? '本地知识库' : config?.name || '本地知识库',
          ),
          h(
            'div',
            { className: 'lkb-head-path' },
            scopedLibrary
              ? scopedLibrary.root
              : libraries.length > 1
                ? `全部 ${libraries.length} 个库：${libraries.map((library) => library.name).join(' · ')}`
                : config?.root || '未设置知识库目录',
          ),
          h('div', { className: 'lkb-chips' }, statusChips),
        ),
        h(
          'div',
          { className: 'lkb-head-actions' },
          h(
            'button',
            {
              className: 'lkb-btn',
              disabled: libraries.length === 0 || Boolean(busy),
              title: scope === 'all' ? '重建所有库的索引' : `只重建「${scopedLibrary?.name ?? ''}」的索引`,
              onClick: () => runIndex('rebuild'),
            },
            busy === 'rebuild' ? '重建中…' : scope === 'all' && libraries.length > 1 ? '重建全部库' : '重建索引',
          ),
          h(
            'button',
            { className: 'lkb-btn ghost', disabled: Boolean(busy), onClick: () => refresh() },
            '刷新',
          ),
        ),
      )

      const scopeChip = (id, label, count) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: `lkb-chip-btn${scope === id ? ' on' : ''}`,
            title: label,
            onClick: () => setScope(id),
          },
          label,
          count === undefined ? null : h('span', { className: 'lkb-chip-count' }, String(count)),
        )

      const sidebar = h(
        'div',
        { className: 'lkb-side' },
        h(
          'div',
          { className: 'lkb-side-head' },
          h('div', { className: 'lkb-title' }, '知识库'),
          h(
            'div',
            { className: 'lkb-sub' },
            libraries.length > 1
              ? `${libraries.length} 个库，默认一起检索`
              : scopedLibrary?.root || docs?.root || config?.root || '未设置目录',
          ),
        ),
        h(
          'div',
          { className: 'lkb-libs' },
          scopeChip('all', '全部库'),
          ...libraries.map((library) => {
            const count = files.filter((file) => file.library?.id === library.id).length
            return scopeChip(library.id, library.name, files.length > 0 ? count : undefined)
          }),
          h(
            'button',
            { type: 'button', className: 'lkb-chip-btn add', title: '添加本地文件夹', onClick: () => setTab('settings') },
            '＋ 添加库',
          ),
        ),
        h(
          'div',
          { className: 'lkb-side-tools' },
          h('input', {
            className: 'lkb-input',
            style: { flex: '1 1 100%' },
            placeholder: scope === 'all' ? '筛选文档…' : `在「${scopedLibrary?.name ?? ''}」里筛选…`,
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'lkb-list' },
          visibleFiles.length === 0
            ? h(
                'div',
                { className: 'lkb-empty' },
                docsError
                  ? `读取目录失败：${docsError}`
                  : docs === null
                    ? '加载中…'
                    : libraries.length === 0
                      ? '还没有添加知识库文件夹：点上面的「＋ 添加库」'
                      : '没有文档',
              )
            : visibleFiles.map((file) =>
                h(
                  'button',
                  {
                    key: `${file.library?.id ?? ''}:${file.path}`,
                    type: 'button',
                    className: `lkb-item${doc?.path === file.path ? ' active' : ''}`,
                    title: file.library ? `${file.library.name} · ${file.path}` : file.path,
                    onClick: () => openDoc(file.path, 1, file.library?.id),
                  },
                  h(
                    'span',
                    { style: { flex: 1, minWidth: 0 } },
                    h('span', { className: 'lkb-item-name', style: { display: 'block' } }, baseName(file.path)),
                    h(
                      'span',
                      { style: { display: 'block', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      [libraries.length > 1 ? file.library?.name : '', dirName(file.path)].filter(Boolean).join(' · ') ||
                        fmtSize(file.size),
                    ),
                  ),
                  h('span', { className: 'lkb-item-meta' }, String(file.chunks)),
                ),
              ),
        ),
      )

      const searchBody = h(
        'div',
        null,
        h(
          'div',
          { className: 'lkb-row', style: { marginBottom: '10px' } },
          h('input', {
            className: 'lkb-input wide',
            placeholder: '输入问题或关键词，回车检索…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !busy) runSearch()
            },
          }),
          h(
            'button',
            { className: 'lkb-btn primary', disabled: Boolean(busy) || query.trim() === '', onClick: runSearch },
            busy === 'search' ? '检索中…' : '检索',
          ),
        ),
        h(
          'div',
          { className: 'lkb-row', style: { marginBottom: '14px' } },
          h(
            'label',
            { className: 'lkb-row', style: { gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            h('input', {
              type: 'checkbox',
              checked: rerankOn && Boolean(status?.rerank?.enabled),
              disabled: !status?.rerank?.enabled,
              onChange: (event) => setRerankOn(event.target.checked),
            }),
            status?.rerank?.enabled ? '使用重排模型' : '重排未启用（到「设置」配置）',
          ),
          config ? h('span', { className: 'lkb-kicker' }, `topK ${config.topK} · minScore ${config.minScore}`) : null,
        ),
        notice ? h(Notice, { kind: notice.kind }, notice.text) : null,
        state?.configured === false
          ? h(
              'div',
              { className: 'lkb-notice info' },
              '还没有添加知识库文件夹。',
              h('button', { className: 'lkb-link', type: 'button', onClick: () => setTab('settings') }, '去「设置」添加一个本地文件夹'),
              ' → 保存 → 回到这里点「重建索引」。',
            )
          : null,
        results === null
          ? h(
              'div',
              { className: 'lkb-empty' },
              status?.indexed ? '输入关键词开始检索。' : '还没有索引：点右上角「重建索引」建立。',
            )
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'lkb-kicker', style: { marginBottom: '8px' } },
                `${results.results?.length ?? 0} 条结果 · ${MODE_TEXT[results.mode] ?? results.mode}${results.rerankModel ? ` · 重排 ${results.rerankModel}` : ''}`,
              ),
              results.note ? h(Notice, { kind: 'info' }, results.note) : null,
              (results.results ?? []).length === 0
                ? h('div', { className: 'lkb-empty' }, '没有命中：换个关键词，或确认索引是最新的。')
                : (results.results ?? []).map((item, index) =>
                    h(
                      'div',
                      { className: 'lkb-card', key: `${item.path}-${item.startLine}-${index}` },
                      h(
                        'div',
                        { className: 'lkb-card-head' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'lkb-card-path',
                            onClick: () => openDoc(item.path, item.startLine, item.library?.id),
                          },
                          `${index + 1}. ${baseName(item.path)}`,
                          h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, `  ·  ${item.path} #L${item.startLine}`),
                          item.library && libraries.length > 1
                            ? h('span', { className: 'lkb-tag' }, item.library.name)
                            : null,
                        ),
                        h(
                          'div',
                          { className: 'lkb-card-score' },
                          `相关度 ${item.score}${item.scoreBefore !== undefined ? `（重排前 ${item.scoreBefore}）` : ''}`,
                        ),
                      ),
                      h('div', { className: 'lkb-snippet' }, highlight(item.snippet, query)),
                    ),
                  ),
            ),
      )

      const docBody = h(
        'div',
        null,
        readError ? h(Notice, { kind: 'err' }, readError) : null,
        !doc
          ? busy === 'read'
            ? h('div', { className: 'lkb-empty' }, '正在读取文件…')
            : readError
              ? null
              : h('div', { className: 'lkb-empty' }, '从左侧文档列表选一篇，或从检索结果点开。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'lkb-doc-head' },
                h(
                  'div',
                  null,
                  h('div', { className: 'lkb-doc-path' }, doc.path),
                  h(
                    'div',
                    { className: 'lkb-kicker' },
                    `${doc.library ? `「${doc.library.name}」 · ` : ''}共 ${doc.totalLines} 行 · 已显示 ${doc.offset}–${doc.offset + doc.text.split('\n').length - 1} 行`,
                  ),
                ),
                h(
                  'div',
                  { className: 'lkb-row' },
                  doc.truncated
                    ? h('button', { className: 'lkb-btn', disabled: Boolean(busy), onClick: loadMore }, busy === 'read' ? '加载中…' : '继续加载')
                    : null,
                ),
              ),
              h(
                'pre',
                { className: 'lkb-pre' },
                doc.text.split('\n').map((line, index) =>
                  h('div', { key: index }, h('span', { className: 'lkb-line' }, String(doc.offset + index)), line),
                ),
              ),
            ),
      )

      const keyHint = (slot) => {
        const info = state?.keys?.[slot]
        if (!info) return ''
        if (!info.configured) return '未配置密钥（本地 Ollama 通常不需要）'
        return `已配置（${info.source === 'credential' ? '凭据库' : info.source === 'env' ? '环境变量' : '配置文件'}）：${info.masked}`
      }

      const settingsBody = !draft
        ? h('div', { className: 'lkb-empty' }, '加载中…')
        : h(
            'fieldset',
            { className: 'lkb-fieldset', disabled: Boolean(busy === 'save' || restarting) },
            notice ? h(Notice, { kind: notice.kind }, notice.text) : null,
            h(
              'div',
              { className: 'lkb-section' },
              h('div', { className: 'lkb-section-title' }, `知识库文件夹（${libraries.length}）`),
              h(
                'div',
                { className: 'lkb-kicker', style: { marginBottom: '6px' } },
                '每个文件夹各自索引到 <目录>\\.dsh-kb，向量互不影响；检索默认跨所有库，结果里会标出库名。',
              ),
              libraries.length === 0
                ? h('div', { className: 'lkb-empty' }, '还没有添加任何文件夹。')
                : libraries.map((library, index) =>
                    h(
                      'div',
                      { className: 'lkb-lib-row', key: library.id ?? `${index}` },
                      h('input', { className: 'lkb-input', value: library.name, readOnly: true, title: '库名' }),
                      h('input', { className: 'lkb-input', value: library.root, readOnly: true, title: '目录' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'lkb-btn ghost',
                          disabled: Boolean(busy) || restarting,
                          onClick: () => removeLibrary(library),
                        },
                        '移除',
                      ),
                    ),
                  ),
              h(
                'div',
                { className: 'lkb-lib-add' },
                h('input', {
                  className: 'lkb-input',
                  placeholder: '新库名称（可留空）',
                  value: newLibrary.name,
                  onChange: (event) => setNewLibrary({ ...newLibrary, name: event.target.value }),
                }),
                h('input', {
                  className: 'lkb-input',
                  placeholder: '文件夹绝对路径，例如 D:\\notes',
                  value: newLibrary.root,
                  onChange: (event) => setNewLibrary({ ...newLibrary, root: event.target.value }),
                }),
                h(
                  'button',
                  { type: 'button', className: 'lkb-btn ghost', disabled: Boolean(busy) || restarting, onClick: pickFolder },
                  '选择文件夹…',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'lkb-btn',
                    disabled: Boolean(busy) || restarting || newLibrary.root.trim() === '',
                    onClick: addLibrary,
                  },
                  busy === 'save' ? '提交中…' : '添加',
                ),
              ),
              h('div', { className: 'lkb-kicker' }, `片段 ${config?.chunkSize ?? 0}/${config?.chunkOverlap ?? 0} 字符 · 扩展名 ${(config?.extensions ?? []).join(' ')}`),
            ),
            h(
              'div',
              { className: 'lkb-section' },
              h('div', { className: 'lkb-section-title' }, '嵌入模型（embedding）'),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: '服务类型' },
                  h(
                    'select',
                    {
                      className: 'lkb-select',
                      value: draft.embedding.provider,
                      onChange: (event) => updateDraft('embedding.provider', event.target.value),
                    },
                    h('option', { value: 'none' }, '不使用（仅关键词检索）'),
                    h('option', { value: 'openai' }, 'OpenAI 兼容 API'),
                    h('option', { value: 'ollama' }, 'Ollama（本地）'),
                  ),
                ),
                h(Field, { label: '接口地址', hint: 'OpenAI 兼容服务填到 /v1 这一层，例如 https://api.siliconflow.cn/v1' },
                  h('input', { className: 'lkb-input', value: draft.embedding.baseUrl, onChange: (event) => updateDraft('embedding.baseUrl', event.target.value) }),
                ),
                h(Field, { label: '模型' },
                  h('input', { className: 'lkb-input', value: draft.embedding.model, onChange: (event) => updateDraft('embedding.model', event.target.value) }),
                ),
                h(Field, { label: '批大小' },
                  h('input', { className: 'lkb-input tiny', type: 'number', min: 1, max: 128, value: draft.embedding.batchSize, onChange: (event) => updateDraft('embedding.batchSize', Number(event.target.value)) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: 'API Key', hint: keyHint('embedding') },
                  h(
                    'div',
                    { className: 'lkb-key' },
                    h('input', {
                      className: 'lkb-input',
                      style: { flex: '1 1 auto' },
                      type: 'password',
                      placeholder: state?.keys?.embedding?.configured ? '已配置，留空则不修改' : '粘贴密钥',
                      value: keys.embedding,
                      onChange: (event) => setKeys({ ...keys, embedding: event.target.value }),
                    }),
                    state?.keys?.embedding?.configured
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'lkb-btn ghost',
                            disabled: Boolean(busy) || restarting,
                            onClick: () => clearKey('embedding'),
                          },
                          '清除',
                        )
                      : null,
                  ),
                ),
                h(Field, { label: '密钥来源环境变量', hint: '填了环境变量名就优先用环境变量（不填用上面保存的密钥）' },
                  h('input', { className: 'lkb-input', value: draft.embedding.apiKeyEnv, onChange: (event) => updateDraft('embedding.apiKeyEnv', event.target.value) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-row' },
                h('button', { className: 'lkb-btn', disabled: Boolean(busy) || draft.embedding.provider === 'none', onClick: () => runIndex('probe') }, busy === 'probe' ? '测试中…' : '测试 embedding'),
                h('span', { className: 'lkb-kicker' }, '测试只发一次请求，不会重建索引。'),
              ),
            ),
            h(
              'div',
              { className: 'lkb-section' },
              h('div', { className: 'lkb-section-title' }, '重排模型（rerank）'),
              h(
                'div',
                { className: 'lkb-row', style: { marginBottom: '10px' } },
                h(
                  'label',
                  { className: 'lkb-row', style: { gap: '6px' } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(draft.rerank.enabled),
                    onChange: (event) => updateDraft('rerank.enabled', event.target.checked),
                  }),
                  '启用重排（Cohere / Jina 协议：POST {baseUrl}/rerank）',
                ),
              ),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: '接口地址', hint: '例如 https://api.jina.ai/v1 或 https://api.cohere.com/v2' },
                  h('input', { className: 'lkb-input', value: draft.rerank.baseUrl, onChange: (event) => updateDraft('rerank.baseUrl', event.target.value) }),
                ),
                h(Field, { label: '模型', hint: '例如 jina-reranker-v2-base-multilingual / rerank-v3.5' },
                  h('input', { className: 'lkb-input', value: draft.rerank.model, onChange: (event) => updateDraft('rerank.model', event.target.value) }),
                ),
                h(Field, { label: '返回条数 topN' },
                  h('input', { className: 'lkb-input tiny', type: 'number', min: 1, max: 30, value: draft.rerank.topN, onChange: (event) => updateDraft('rerank.topN', Number(event.target.value)) }),
                ),
                h(Field, { label: '候选池', hint: '先召回这么多条再重排，越大越准也越慢' },
                  h('input', { className: 'lkb-input tiny', type: 'number', min: 1, max: 100, value: draft.rerank.candidates, onChange: (event) => updateDraft('rerank.candidates', Number(event.target.value)) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: 'API Key', hint: keyHint('rerank') },
                  h(
                    'div',
                    { className: 'lkb-key' },
                    h('input', {
                      className: 'lkb-input',
                      style: { flex: '1 1 auto' },
                      type: 'password',
                      placeholder: state?.keys?.rerank?.configured ? '已配置，留空则不修改' : '粘贴密钥',
                      value: keys.rerank,
                      onChange: (event) => setKeys({ ...keys, rerank: event.target.value }),
                    }),
                    state?.keys?.rerank?.configured
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'lkb-btn ghost',
                            disabled: Boolean(busy) || restarting,
                            onClick: () => clearKey('rerank'),
                          },
                          '清除',
                        )
                      : null,
                  ),
                ),
                h(Field, { label: '密钥来源环境变量' },
                  h('input', { className: 'lkb-input', value: draft.rerank.apiKeyEnv, onChange: (event) => updateDraft('rerank.apiKeyEnv', event.target.value) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-row' },
                h('button', { className: 'lkb-btn', disabled: Boolean(busy) || !draft.rerank.enabled, onClick: () => runIndex('probe-rerank') }, busy === 'probe-rerank' ? '测试中…' : '测试重排'),
                h('span', { className: 'lkb-kicker' }, '密钥存在 DSH 凭据库，配置里只留记录名。'),
              ),
            ),
            h(
              'div',
              { className: 'lkb-section' },
              h('div', { className: 'lkb-section-title' }, '扫描件 OCR（可选）'),
              h('div', { className: 'lkb-kicker' }, 'PDF 没有文本层（整页是图）时，用 mutool 渲染成图片再交给视觉模型转文字。只对扫描件生效，普通 PDF 仍走文本层，不花这份钱。'),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: '接口地址', hint: 'OpenAI 兼容，填到 /v1 这一层' },
                  h('input', { className: 'lkb-input', value: draft.ocr?.baseUrl ?? '', onChange: (event) => updateDraft('ocr.baseUrl', event.target.value) }),
                ),
                h(Field, { label: '视觉模型', hint: '例如 Qwen/Qwen3-VL-8B-Instruct' },
                  h('input', { className: 'lkb-input', value: draft.ocr?.model ?? '', onChange: (event) => updateDraft('ocr.model', event.target.value) }),
                ),
                h(Field, { label: '渲染精度 dpi', hint: '150 够用；太小可能认错字' },
                  h('input', { className: 'lkb-input tiny', type: 'number', min: 72, max: 300, value: draft.ocr?.dpi ?? 150, onChange: (event) => updateDraft('ocr.dpi', Number(event.target.value)) }),
                ),
                h(Field, { label: '单篇最多页数', hint: '超过这个页数的部分不识别' },
                  h('input', { className: 'lkb-input tiny', type: 'number', min: 1, max: 500, value: draft.ocr?.maxPages ?? 40, onChange: (event) => updateDraft('ocr.maxPages', Number(event.target.value)) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: 'API Key', hint: keyHint('ocr') },
                  h(
                    'div',
                    { className: 'lkb-key' },
                    h('input', {
                      className: 'lkb-input',
                      style: { flex: '1 1 auto' },
                      type: 'password',
                      placeholder: state?.keys?.ocr?.configured ? '已配置，留空则不修改' : '粘贴密钥',
                      value: keys.ocr,
                      onChange: (event) => setKeys({ ...keys, ocr: event.target.value }),
                    }),
                    state?.keys?.ocr?.configured
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'lkb-btn ghost',
                            disabled: Boolean(busy) || restarting,
                            onClick: () => clearKey('ocr'),
                          },
                          '清除',
                        )
                      : null,
                  ),
                ),
                h(Field, { label: '密钥来源环境变量' },
                  h('input', { className: 'lkb-input', value: draft.ocr?.apiKeyEnv ?? '', onChange: (event) => updateDraft('ocr.apiKeyEnv', event.target.value) }),
                ),
              ),
              h(
                'div',
                { className: 'lkb-grid' },
                h(Field, { label: 'mutool 路径', hint: '留空则用 PATH 里的 mutool' },
                  h('input', { className: 'lkb-input', value: draft.ocr?.mutoolPath ?? '', onChange: (event) => updateDraft('ocr.mutoolPath', event.target.value) }),
                ),
              ),
              h(
                'label',
                { className: 'lkb-check' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.ocr?.enabled),
                  onChange: (event) => updateDraft('ocr.enabled', event.target.checked),
                }),
                '启用扫描件 OCR（没有文本层的 PDF 才走这条路）',
              ),
              h(
                'div',
                { className: 'lkb-row' },
                h('button', { className: 'lkb-btn', disabled: Boolean(busy) || !draft.ocr?.enabled, onClick: () => runIndex('probe-ocr') }, busy === 'probe-ocr' ? '识别中…' : '测试 OCR'),
                h('span', { className: 'lkb-kicker' }, '会拿库里第一个 PDF 的第 1 页真识别一次，约 20 秒。'),
              ),
            ),
            error ? h(Notice, { kind: 'err' }, error) : null,
            h(
              'div',
              { className: 'lkb-row' },
              h(
                'button',
                {
                  className: 'lkb-btn primary',
                  disabled: Boolean(busy) || !state?.capabilities?.configEditor,
                  title: state?.capabilities?.configEditor ? '写入 profile 配置并重启插件' : '宿主缺少 configEditor，只能手改 cordis.patch.yml',
                  onClick: saveSettings,
                },
                busy === 'save' ? '保存中…' : '保存设置',
              ),
              h('button', { className: 'lkb-btn ghost', disabled: Boolean(busy), onClick: () => refresh() }, '放弃修改'),
              state?.capabilities?.configEditor
                ? h('span', { className: 'lkb-kicker' }, '保存会写入 profile 配置并重载插件，约 2 秒后恢复。')
                : h('span', { className: 'lkb-kicker' }, '当前宿主不支持保存：请编辑 profile 的 cordis.patch.yml。'),
            ),
          )

      const body = tab === 'search' ? searchBody : tab === 'docs' ? docBody : settingsBody

      return h(
        'div',
        { className: 'lkb-root' },
        sidebar,
        h(
          'div',
          { className: 'lkb-main' },
          header,
          error && tab !== 'settings' ? h('div', { style: { padding: '10px 18px 0' } }, h(Notice, { kind: 'err' }, error)) : null,
          h(
            'div',
            { className: 'lkb-tabs' },
            ...['search', 'docs', 'settings'].map((key) =>
              h(
                'button',
                { key, className: `lkb-tab${tab === key ? ' on' : ''}`, onClick: () => setTab(key) },
                key === 'search' ? '检索' : key === 'docs' ? '文档' : '设置',
              ),
            ),
          ),
          h('div', { className: 'lkb-body' }, body),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        injectStyle()
        uiCtx = ctx
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'local-kb',
              order: 6,
              label: () => '知识库',
            },
            SidebarIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'local-kb',
            },
            KnowledgePage,
          ),
        )
      },
    }
  },
})
