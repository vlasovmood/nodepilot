import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Download,
  Eye,
  EyeOff,
  File,
  FileCode,
  FileSymlink,
  Folder,
  FolderPlus,
  Home,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { lazy, Suspense, useMemo, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, errorMessage } from '../../api/client'
import { qk } from '../../api/queries'
import type { FileEntry, Server } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Field } from '../../components/Field'
import { Menu } from '../../components/Menu'
import { Modal } from '../../components/Modal'
import { ErrorState, InlineError, Loading, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { intlLocale } from '../../i18n'
import { formatBytes, formatDateTime } from '../../lib/format'
import { baseName, cx, downloadUrl, joinPath, parentPath, splitPath, gridMinWidth } from '../../lib/util'

const FileEditor = lazy(() => import('./FileEditor'))
const MAX_EDIT_BYTES = 5 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

const COLS = 'minmax(240px,1fr) 100px 110px 150px 40px'
const MIN_W = gridMinWidth(COLS)
const ROW_H = 32

type SortKey = 'name' | 'size' | 'modified'
type Upload = { id: number; name: string; loaded: number; total: number; error?: string; done?: boolean }

export function FilesTab({ server }: { server: Server }) {
  const { t, i18n } = useTranslation('files')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  /** `null` = home directory (server default). */
  const [path, setPath] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [editing, setEditing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | null>(null)
  const [pathInput, setPathInput] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const uploadSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const listing = useQuery({
    queryKey: qk.files(server.id, path ?? '~'),
    queryFn: () => api.files.list(server.id, path ?? undefined),
    placeholderData: keepPreviousData,
  })

  const cwd = listing.data?.path ?? path ?? '~'

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const collator = new Intl.Collator(intlLocale(i18n.language), { numeric: true, sensitivity: 'base' })
    const list = (listing.data?.entries ?? []).filter(
      (e) => e.name !== '.' && e.name !== '..' && (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)),
    )
    return list.sort((a, b) => {
      const da = a.kind === 'dir' ? 0 : 1
      const db = b.kind === 'dir' ? 0 : 1
      if (da !== db) return da - db
      let r = 0
      if (sort.key === 'size') r = a.size - b.size
      else if (sort.key === 'modified') r = (a.modified ?? '').localeCompare(b.modified ?? '')
      return (r || collator.compare(a.name, b.name)) * sort.dir
    })
  }, [listing.data, filter, showHidden, sort, i18n.language])

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 15,
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['files', server.id] })

  const go = (p: string | null) => {
    setFilter('')
    setPath(p)
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const openEntry = async (e: FileEntry) => {
    if (e.kind === 'dir') return go(e.path)
    if (e.kind === 'symlink') {
      // Try as a directory first; fall back to opening as a file.
      try {
        await qc.fetchQuery({ queryKey: qk.files(server.id, e.path), queryFn: () => api.files.list(server.id, e.path) })
        return go(e.path)
      } catch {
        /* not a directory */
      }
    }
    if (e.size > MAX_EDIT_BYTES) {
      const ok = await confirm({
        title: t('tooLarge.title'),
        message: t('tooLarge.message', { size: formatBytes(e.size) }),
        confirmText: t('common:actions.download'),
      })
      if (ok) downloadUrl(api.files.downloadUrl(server.id, e.path), e.name)
      return
    }
    setEditing(e.path)
  }

  const remove = async (e: FileEntry) => {
    const isDir = e.kind === 'dir'
    const ok = await confirm({
      title: isDir ? t('remove.folderTitle') : t('remove.fileTitle'),
      message: (
        <>
          <code>{e.path}</code>
          {isDir && (
            <div className="danger-text" style={{ marginTop: 8 }}>
              {t('remove.recursiveWarning')}
            </div>
          )}
        </>
      ),
      confirmText: t('common:actions.delete'),
      danger: true,
      requireText: isDir ? e.name : undefined,
    })
    if (!ok) return
    try {
      await api.files.remove(server.id, e.path, isDir)
      toast.success(t('toast.deleted'), e.path)
      refresh()
    } catch (err) {
      toast.error(t('toast.deleteFailed'), err)
    }
  }

  const uploadFiles = async (files: File[]) => {
    if (!files.length || cwd === '~') return
    const dir = cwd
    for (const f of files) {
      const id = ++uploadSeq.current
      if (f.size > MAX_UPLOAD_BYTES) {
        setUploads((u) => [
          ...u,
          { id, name: f.name, loaded: 0, total: f.size, error: t('upload.tooLarge', { limit: formatBytes(MAX_UPLOAD_BYTES) }) },
        ])
        continue
      }
      setUploads((u) => [...u, { id, name: f.name, loaded: 0, total: f.size }])
      try {
        await api.files.upload(server.id, joinPath(dir, f.name), f, (loaded, total) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, loaded, total } : x))),
        )
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, loaded: x.total, done: true } : x)))
        window.setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500)
      } catch (err) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: errorMessage(err) } : x)))
      }
    }
    void qc.invalidateQueries({ queryKey: ['files', server.id] })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files: File[] = []
    let dirs = 0
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        dirs++
        continue
      }
      const f = item.getAsFile()
      if (f) files.push(f)
    }
    if (dirs > 0) toast.error(t('toast.foldersSkipped'), t('toast.foldersSkippedHint'))
    void uploadFiles(files)
  }

  const sortHead = (key: SortKey, label: string) => (
    <div
      className={cx('vt-cell sortable', sort.key === key && 'sorted')}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}
    >
      {label}
      {sort.key === key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </div>
  )

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <button className="btn btn-icon" title={t('toolbar.home')} onClick={() => go(null)} disabled={path === null}>
          <Home size={14} />
        </button>
        <button className="btn btn-icon" title={t('toolbar.up')} disabled={cwd === '/' || cwd === '~'} onClick={() => go(parentPath(cwd))}>
          <ArrowUpFromLine size={14} />
        </button>
        {pathInput !== null ? (
          <input
            className="input mono grow"
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pathInput.trim()) {
                go(pathInput.trim())
                setPathInput(null)
              } else if (e.key === 'Escape') setPathInput(null)
            }}
            onBlur={() => setPathInput(null)}
          />
        ) : (
          <div className="breadcrumbs grow" onDoubleClick={() => setPathInput(cwd)} title={t('toolbar.breadcrumbsHint')}>
            {cwd === '~' ? (
              <span className="dim">~</span>
            ) : (
              splitPath(cwd).map((seg, i, arr) => (
                <span key={seg.path} className="row" style={{ gap: 0 }}>
                  {i > 1 && <span className="dim">/</span>}
                  <button className={cx(i === arr.length - 1 && 'current')} onClick={() => go(seg.path)}>
                    {seg.name}
                  </button>
                </span>
              ))
            )}
            <button className="btn btn-ghost btn-icon btn-sm" title={t('toolbar.editPath')} onClick={() => setPathInput(cwd)}>
              <Pencil size={12} />
            </button>
          </div>
        )}
        <div className="input-icon" style={{ width: 180 }}>
          <Search size={14} />
          <input className="input" placeholder={t('toolbar.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button
          className={cx('btn btn-icon', showHidden && 'btn-active')}
          title={showHidden ? t('toolbar.hideHidden') : t('toolbar.showHidden')}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="btn btn-icon" title={t('common:actions.refresh')} onClick={refresh}>
          <RefreshCw size={14} className={listing.isFetching ? 'spin' : undefined} />
        </button>
        <button className="btn" onClick={() => setDialog({ kind: 'mkdir' })} disabled={cwd === '~'}>
          <FolderPlus size={14} /> {t('toolbar.newFolder')}
        </button>
        <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={cwd === '~'}>
          <Upload size={14} /> {t('common:actions.upload')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void uploadFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="card card-pad stack-sm">
          {uploads.map((u) => (
            <div key={u.id} className="row small">
              <Upload size={13} className="dim" />
              <span className="ellipsis" style={{ width: 240 }}>
                {u.name}
              </span>
              {u.error ? (
                <span className="danger-text grow ellipsis">{u.error}</span>
              ) : (
                <div className="progress grow">
                  <div style={{ width: `${u.total ? (u.loaded / u.total) * 100 : 0}%` }} />
                </div>
              )}
              <span className="dim num" style={{ width: 150, textAlign: 'end' }}>
                {u.done ? t('upload.done') : `${formatBytes(u.loaded)} / ${formatBytes(u.total)}`}
              </span>
              {(u.error || u.done) && (
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title={t('upload.dismiss')}
                  aria-label={t('upload.dismiss')}
                  onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        className={cx('vt drop-zone', dragging && 'dragging')}
        data-drop-label={t('dropToUpload')}
        style={{ minHeight: 300 }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          dragDepth.current++
          setDragging(true)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {listing.isPending ? (
          <Loading />
        ) : listing.isError ? (
          <ErrorState
            error={listing.error}
            title={t('listError')}
            onRetry={() => (path && path !== '~' ? go(parentPath(path)) : void listing.refetch())}
          />
        ) : (
          <div className="vt-scroll" ref={scrollRef}>
            <div className="vt-head" style={{ gridTemplateColumns: COLS, minWidth: MIN_W }}>
              {sortHead('name', t('columns.name'))}
              {sortHead('size', t('columns.size'))}
              <div className="vt-cell">{t('columns.mode')}</div>
              {sortHead('modified', t('columns.modified'))}
              <div className="vt-cell" />
            </div>
            {entries.length === 0 && <div className="state dim">{filter ? t('empty.noMatches') : t('empty.folder')}</div>}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const e = entries[vi.index]
                return (
                  <div
                    key={e.path}
                    className="vt-row clickable"
                    style={{ gridTemplateColumns: COLS, minWidth: MIN_W, transform: `translateY(${vi.start}px)`, height: ROW_H }}
                    onDoubleClick={() => void openEntry(e)}
                  >
                    <div className="vt-cell" onClick={() => void openEntry(e)}>
                      <EntryIcon e={e} />
                      <span className="ellipsis" title={e.name}>
                        {e.name}
                      </span>
                    </div>
                    <div className="vt-cell num small dim">{e.kind === 'dir' ? '—' : formatBytes(e.size)}</div>
                    <div className="vt-cell mono small dim">{e.mode}</div>
                    <div className="vt-cell small dim num">{formatDateTime(e.modified)}</div>
                    <div className="vt-cell" onClick={(ev) => ev.stopPropagation()}>
                      <Menu
                        trigger={(toggle) => (
                          <button
                            className="btn btn-ghost btn-icon btn-sm"
                            onClick={toggle}
                            title={t('common:actions.more')}
                            aria-label={t('common:actions.more')}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                        )}
                        items={[
                          ...(e.kind === 'dir'
                            ? [{ label: t('common:actions.open'), icon: <Folder size={14} />, onClick: () => go(e.path) }]
                            : [
                                { label: t('menu.edit'), icon: <FileCode size={14} />, onClick: () => void openEntry(e) },
                                {
                                  label: t('common:actions.download'),
                                  icon: <Download size={14} />,
                                  onClick: () => downloadUrl(api.files.downloadUrl(server.id, e.path), e.name),
                                },
                              ]),
                          { label: t('menu.rename'), icon: <Pencil size={14} />, onClick: () => setDialog({ kind: 'rename', entry: e }) },
                          'sep' as const,
                          { label: t('common:actions.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(e) },
                        ]}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {listing.data && (
          <div className="vt-footer">
            <span>
              {t('footer.items', { count: entries.length })}
              {listing.data.entries.length !== entries.length && ` ${t('footer.total', { n: listing.data.entries.length })}`}
            </span>
            <span className="spacer" />
            <span className="dim">{t('footer.hint')}</span>
          </div>
        )}
      </div>

      {dialog && (
        <NameDialog
          title={dialog.kind === 'mkdir' ? t('dialog.newFolder') : t('dialog.rename')}
          label={dialog.kind === 'mkdir' ? t('dialog.folderName') : t('dialog.newNameOrPath')}
          initial={dialog.kind === 'rename' ? dialog.entry.name : ''}
          onClose={() => setDialog(null)}
          onSubmit={async (value) => {
            const target = value.startsWith('/') ? value : joinPath(cwd, value)
            if (dialog.kind === 'mkdir') {
              await api.files.mkdir(server.id, target)
              toast.success(t('toast.folderCreated'), target)
            } else {
              await api.files.rename(server.id, dialog.entry.path, target)
              toast.success(t('toast.renamed'), `${dialog.entry.name} → ${baseName(target)}`)
            }
            refresh()
          }}
        />
      )}

      {editing && (
        <Suspense
          fallback={
            <Modal open onClose={() => setEditing(null)} title={t('editor.loadingEditor')}>
              <Loading />
            </Modal>
          }
        >
          <FileEditor serverId={server.id} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </div>
  )
}

function EntryIcon({ e }: { e: FileEntry }) {
  if (e.kind === 'dir') return <Folder size={15} className="file-icon-dir" />
  if (e.kind === 'symlink') return <FileSymlink size={15} className="file-icon-link" />
  return <File size={15} className="dim" />
}

function NameDialog({
  title,
  label,
  initial,
  onClose,
  onSubmit,
}: {
  title: string
  label: string
  initial: string
  onClose: () => void
  onSubmit: (v: string) => Promise<void>
}) {
  const { t } = useTranslation('files')
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const submit = async () => {
    const v = value.trim()
    if (!v || v === initial) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(v)
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      locked={busy}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !value.trim() || value.trim() === initial} onClick={() => void submit()}>
            {busy && <Spinner />} {t('dialog.ok')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={label}>
          <input
            className="input mono"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </Field>
        {error !== null && <InlineError error={error} />}
      </div>
    </Modal>
  )
}
