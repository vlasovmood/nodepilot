import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { useQuery } from '@tanstack/react-query'
import { Download, Save, WrapText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useConfirm } from '../../components/Confirm'
import { Modal } from '../../components/Modal'
import { ErrorState, Loading, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import i18n from '../../i18n'
import { formatBytes } from '../../lib/format'
import { useTheme } from '../../lib/theme'
import { baseName, cx, downloadUrl } from '../../lib/util'

export const MAX_EDIT_BYTES = 5 * 1024 * 1024

/** Not an I/O failure: the file can't be shown in the editor. Message is a `files:` key, translated at render time. */
class BinaryFileError extends Error {
  readonly key: 'editor.tooLarge' | 'editor.binary'
  readonly params: Record<string, string>
  constructor(key: 'editor.tooLarge' | 'editor.binary', params: Record<string, string> = {}) {
    super(i18n.t(`files:${key}`, params))
    this.key = key
    this.params = params
  }
}

async function loadText(serverId: string, path: string, signal: AbortSignal): Promise<string> {
  const blob = await api.files.readBlob(serverId, path, signal)
  if (blob.size > MAX_EDIT_BYTES) throw new BinaryFileError('editor.tooLarge', { size: formatBytes(blob.size) })
  const buf = new Uint8Array(await blob.arrayBuffer())
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) throw new BinaryFileError('editor.binary')
  return new TextDecoder('utf-8').decode(buf)
}

/** Modal CodeMirror editor for a remote text file. Loaded lazily (CodeMirror is heavy). */
export default function FileEditor({ serverId, path, onClose }: { serverId: string; path: string; onClose: () => void }) {
  const { t } = useTranslation('files')
  const toast = useToast()
  const confirm = useConfirm()
  const [theme] = useTheme()
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [lang, setLang] = useState<Extension | null>(null)

  const file = useQuery({
    queryKey: ['file-content', serverId, path],
    queryFn: ({ signal }) => loadText(serverId, path, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    if (file.data !== undefined && text === null) {
      setText(file.data)
      setSaved(file.data)
    }
  }, [file.data, text])

  useEffect(() => {
    let cancelled = false
    const desc = LanguageDescription.matchFilename(languages, baseName(path))
    if (desc) {
      desc
        .load()
        .then((support) => {
          if (!cancelled) setLang(support)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [path])

  const dirty = text !== null && text !== saved

  const save = async () => {
    if (text === null || saving) return
    setSaving(true)
    try {
      await api.files.write(serverId, path, new Blob([text], { type: 'text/plain;charset=utf-8' }))
      setSaved(text)
      toast.success(t('editor.saved'), path)
    } catch (e) {
      toast.error(t('editor.saveFailed'), e)
    } finally {
      setSaving(false)
    }
  }

  const requestClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: t('editor.discardTitle'),
        message: t('editor.discardMessage'),
        confirmText: t('common:actions.close'),
        danger: true,
      })
      if (!ok) return
    }
    onClose()
  }

  const extensions = useMemo(() => {
    const ext: Extension[] = [
      EditorView.domEventHandlers({
        keydown: (e) => {
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            document.getElementById('np-editor-save')?.click()
            return true
          }
          return false
        },
      }),
    ]
    if (wrap) ext.push(EditorView.lineWrapping)
    if (lang) ext.push(lang)
    return ext
  }, [wrap, lang])

  const loadError = file.error

  return (
    <Modal
      open
      onClose={() => void requestClose()}
      size="full"
      title={
        <span className="row">
          <span className="mono ellipsis">{path}</span>
          {dirty && <span className="badge badge-warn">{t('editor.modified')}</span>}
        </span>
      }
      bodyClassName="modal-body-flush"
      headerExtra={
        <div className="row">
          <button
            className={cx('btn btn-sm', wrap && 'btn-active')}
            onClick={() => setWrap((w) => !w)}
            title={t('editor.wrap')}
            aria-label={t('editor.wrap')}
          >
            <WrapText size={14} />
          </button>
          <button className="btn btn-sm" onClick={() => downloadUrl(api.files.downloadUrl(serverId, path), baseName(path))}>
            <Download size={14} /> {t('common:actions.download')}
          </button>
          <button
            id="np-editor-save"
            className="btn btn-sm btn-primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
            title="Ctrl+S"
          >
            {saving ? <Spinner /> : <Save size={14} />} {t('common:actions.save')}
          </button>
        </div>
      }
    >
      {file.isPending ? (
        <Loading label={t('editor.loadingFile')} />
      ) : loadError ? (
        <ErrorState
          title={loadError instanceof BinaryFileError ? t('editor.cannotOpen') : t('editor.openFailed')}
          error={loadError instanceof BinaryFileError ? t(loadError.key, loadError.params) : loadError}
          onRetry={loadError instanceof BinaryFileError ? undefined : () => void file.refetch()}
        />
      ) : (
        <div className="editor-host">
          <CodeMirror
            value={text ?? ''}
            height="100%"
            theme={theme === 'dark' ? oneDark : 'light'}
            extensions={extensions}
            onChange={(v) => setText(v)}
            autoFocus
            basicSetup={{ foldGutter: true, highlightActiveLine: true, tabSize: 2 }}
          />
        </div>
      )}
    </Modal>
  )
}
