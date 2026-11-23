import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns2, Eye, Pencil, Pin, PinOff, Plus, Save, Search, StickyNote, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk, useProjects, useServers } from '../../api/queries'
import type { Note } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Empty, ErrorState, InlineError, Loading, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { useToast } from '../../components/Toast'
import { formatRelative } from '../../lib/format'
import { cx, markdownExcerpt } from '../../lib/util'

const Markdown = lazy(() => import('./Markdown'))

type Scope = { project_id?: string; server_id?: string }

function sortNotes(notes: Note[]): Note[] {
  return notes.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
}

/**
 * Notes list + markdown editor.
 * - With `scope` the list is limited to that project/server and new notes are attached to it.
 * - With `filters` (Notes page) the user can filter by project/server.
 * - `focusId` opens that note (e.g. from a link); `onSelect` reports the open note so the page can keep it in the URL.
 */
export function NotesPanel({
  scope,
  filters,
  height,
  focusId,
  onSelect,
}: {
  scope?: Scope
  filters?: boolean
  height?: string
  focusId?: string | null
  onSelect?: (id: string | null) => void
}) {
  const { t } = useTranslation('notes')
  const qc = useQueryClient()
  const toast = useToast()
  const projects = useProjects()
  const servers = useServers()
  const [projectFilter, setProjectFilter] = useState('')
  const [serverFilter, setServerFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null)
  // A new focusId (e.g. a sidebar link) opens that note; filters are cleared so it is guaranteed to be listed.
  const [lastFocus, setLastFocus] = useState(focusId)
  if (focusId !== lastFocus) {
    setLastFocus(focusId)
    if (focusId && focusId !== selectedId) {
      setSelectedId(focusId)
      setProjectFilter('')
      setServerFilter('')
      setSearch('')
    }
  }

  const query: Scope = scope ?? {
    project_id: projectFilter || undefined,
    server_id: serverFilter || undefined,
  }

  const notes = useQuery({ queryKey: qk.notes(query), queryFn: () => api.notes.list(query) })

  const list = useMemo(() => {
    const term = search.trim().toLowerCase()
    const arr = (notes.data ?? []).filter((n) => !term || n.title.toLowerCase().includes(term) || n.body.toLowerCase().includes(term))
    return sortNotes(arr)
  }, [notes.data, search])

  useEffect(() => {
    if (!notes.data) return
    if (selectedId && notes.data.some((n) => n.id === selectedId)) return
    if (selectedId && selectedId === focusId && notes.isFetching) return
    setSelectedId(list[0]?.id ?? null)
  }, [notes.data, notes.isFetching, list, selectedId, focusId])

  useEffect(() => {
    onSelect?.(selectedId)
  }, [selectedId, onSelect])

  const selected = notes.data?.find((n) => n.id === selectedId) ?? null

  const create = useMutation({
    mutationFn: () =>
      api.notes.create({
        title: t('defaultTitle'),
        body: '',
        project_id: scope?.project_id ?? (projectFilter || null),
        server_id: scope?.server_id ?? (serverFilter || null),
      }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: qk.notes() })
      setSelectedId(n.id)
    },
    onError: (e) => toast.error(t('toast.createFailed'), e),
  })

  const projectName = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.name : undefined)
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name : undefined)

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0, height }}>
      <div className="toolbar">
        <div className="input-icon" style={{ width: 240 }}>
          <Search size={14} />
          <input className="input" placeholder={t('searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {filters && (
          <>
            <select className="select" style={{ width: 180 }} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="">{t('common:filters.allProjects')}</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 200 }} value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
              <option value="">{t('common:filters.allServers')}</option>
              {servers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Spinner /> : <Plus size={14} />} {t('new')}
        </button>
      </div>

      {notes.isPending ? (
        <Loading />
      ) : notes.isError ? (
        <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
      ) : (notes.data ?? []).length === 0 ? (
        <div className="card">
          <Empty icon={<StickyNote size={28} />} title={t('empty.title')}>
            <div className="muted">{t('empty.text')}</div>
          </Empty>
        </div>
      ) : (
        <div className="notes-layout">
          <div className="card note-list">
            {list.length === 0 && (
              <div className="dim small" style={{ padding: 12 }}>
                {t('common:state.nothingFound')}
              </div>
            )}
            {list.map((n) => {
              const pn = projectName(n.project_id)
              const sn = serverName(n.server_id)
              return (
                <div key={n.id} className={cx('note-item', n.id === selectedId && 'active')} onClick={() => setSelectedId(n.id)}>
                  <div className="title">
                    {n.pinned && <Pin size={12} className="warn-text" />}
                    <span className="ellipsis">{n.title || t('common:untitled')}</span>
                  </div>
                  <div className="excerpt">{markdownExcerpt(n.body) || '—'}</div>
                  <div className="row dim small" style={{ gap: 6 }}>
                    <span>{formatRelative(n.updated_at)}</span>
                    {!scope && pn && <span className="tag">{pn}</span>}
                    {!scope && sn && <span className="tag">{sn}</span>}
                  </div>
                </div>
              )
            })}
          </div>
          {selected ? (
            <NoteEditor key={selected.id} note={selected} onDeleted={() => setSelectedId(null)} showLinks={!scope} />
          ) : (
            <div className="card">
              <Empty title={t('selectNote')} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Mode = 'edit' | 'split' | 'preview'

function NoteEditor({ note, onDeleted, showLinks }: { note: Note; onDeleted: () => void; showLinks: boolean }) {
  const { t } = useTranslation('notes')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const projects = useProjects()
  const servers = useServers()
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [projectId, setProjectId] = useState(note.project_id ?? '')
  const [serverId, setServerId] = useState(note.server_id ?? '')
  const [mode, setMode] = useState<Mode>(note.body ? 'preview' : 'split')

  const dirty =
    title !== note.title || body !== note.body || (projectId || null) !== note.project_id || (serverId || null) !== note.server_id

  const save = useMutation({
    mutationFn: () =>
      api.notes.update(note.id, {
        title: title.trim() || t('common:untitled'),
        body,
        project_id: projectId || null,
        server_id: serverId || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notes() })
      toast.success(t('toast.saved'))
    },
  })

  const pin = useMutation({
    mutationFn: () => api.notes.update(note.id, { pinned: !note.pinned }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notes() }),
    onError: (e) => toast.error(t('common:state.error'), e),
  })

  const remove = async () => {
    const ok = await confirm({
      title: t('confirm.deleteTitle'),
      message: t('confirm.deleteMessage', { title: note.title }),
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.notes.remove(note.id)
      void qc.invalidateQueries({ queryKey: qk.notes() })
      toast.success(t('toast.deleted'))
      onDeleted()
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e)
    }
  }

  // Ctrl+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (dirty && !save.isPending) save.mutate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, save])

  return (
    <div className="card note-editor">
      <div className="card-header" style={{ flexWrap: 'wrap' }}>
        <input
          className="input grow"
          style={{ fontWeight: 600, fontSize: 14, minWidth: 180, width: 'auto', flex: 1 }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('editor.titlePlaceholder')}
        />
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'edit', label: <Pencil size={13} /> },
            { value: 'split', label: <Columns2 size={13} /> },
            { value: 'preview', label: <Eye size={13} /> },
          ]}
        />
        <button
          className="btn btn-icon"
          title={note.pinned ? t('editor.unpin') : t('editor.pin')}
          onClick={() => pin.mutate()}
          disabled={pin.isPending}
        >
          {note.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="btn btn-icon btn-danger-ghost" title={t('common:actions.delete')} onClick={() => void remove()}>
          <Trash2 size={14} />
        </button>
        <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()} title="Ctrl+S">
          {save.isPending ? <Spinner /> : <Save size={14} />} {t('common:actions.save')}
        </button>
      </div>
      {showLinks && (
        <div className="row" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
          <span className="muted small">{t('editor.links')}</span>
          <select className="select select-sm" style={{ width: 200 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t('common:noProject')}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select className="select select-sm" style={{ width: 200 }} value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">{t('common:noServer')}</option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className="dim small">{t('editor.updated', { time: formatRelative(note.updated_at) })}</span>
        </div>
      )}
      {save.isError && (
        <div style={{ padding: '8px 14px 0' }}>
          <InlineError error={save.error} />
        </div>
      )}
      <div className="note-split" style={mode !== 'split' ? { gridTemplateColumns: '1fr' } : undefined}>
        {mode !== 'preview' && (
          <textarea
            className="note-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('editor.bodyPlaceholder')}
            spellCheck={false}
          />
        )}
        {mode !== 'edit' && (
          <div style={{ minHeight: 300 }}>
            <Suspense fallback={<Loading />}>
              {body.trim() ? (
                <Markdown text={body} />
              ) : (
                <div className="dim" style={{ padding: 16 }}>
                  {t('editor.emptyNote')}
                </div>
              )}
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}
