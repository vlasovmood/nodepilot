import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { terminalUrl } from '../../api/client'
import type { TerminalClientMessage, TerminalServerMessage } from '../../api/types'
import { Spinner } from '../../components/States'
import i18n from '../../i18n'
import { cssVar, useTheme } from '../../lib/theme'

export type SessionState = 'connecting' | 'ready' | 'exited' | 'closed' | 'error'

/** Overlay text: either a `terminal:` key (translated at render, so it follows language switches) or raw text from the server. */
type OverlayMessage = { key: 'reason.exited' | 'reason.aborted' | 'reason.closed'; code?: number | null } | { raw: string }

function xtermTheme(): ITheme {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light'
  const bg = cssVar('--term-bg') || (dark ? '#0a0d12' : '#fbfcfd')
  const fg = cssVar('--term-fg') || (dark ? '#d8dee9' : '#1f2937')
  return dark
    ? {
        background: bg,
        foreground: fg,
        cursor: '#e2e8f0',
        cursorAccent: bg,
        selectionBackground: 'rgba(59,130,246,0.35)',
        black: '#1c2128',
        red: '#f47067',
        green: '#57ab5a',
        yellow: '#c69026',
        blue: '#539bf5',
        magenta: '#b083f0',
        cyan: '#39c5cf',
        white: '#d8dee9',
        brightBlack: '#636e7b',
        brightRed: '#ff938a',
        brightGreen: '#6bc46d',
        brightYellow: '#daaa3f',
        brightBlue: '#6cb6ff',
        brightMagenta: '#dcbdfb',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      }
    : {
        background: bg,
        foreground: fg,
        cursor: '#1f2937',
        cursorAccent: bg,
        selectionBackground: 'rgba(37,99,235,0.25)',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#9a6700',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f',
      }
}

const encoder = new TextEncoder()

type Props = {
  serverId: string
  visible: boolean
  onStateChange?: (s: SessionState) => void
}

/** One interactive SSH shell over the terminal WebSocket (see docs/API.md "Terminal"). */
export function TerminalSession({ serverId, visible, onStateChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<SessionState>('connecting')
  const [message, setMessage] = useState<OverlayMessage | null>(null)
  const [theme] = useTheme()
  const { t } = useTranslation('terminal')
  const stateCb = useRef(onStateChange)
  stateCb.current = onStateChange

  const update = useCallback((s: SessionState, msg: OverlayMessage | null = null) => {
    setState(s)
    setMessage(msg)
    stateCb.current?.(s)
  }, [])

  const sendControl = (msg: TerminalClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const safeFit = useCallback(() => {
    const host = hostRef.current
    const fit = fitRef.current
    if (!host || !fit || host.clientWidth === 0 || host.clientHeight === 0) return
    try {
      fit.fit()
    } catch {
      /* terminal not ready */
    }
  }, [])

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term) return
    wsRef.current?.close()
    safeFit()
    update('connecting')

    const ws = new WebSocket(terminalUrl(serverId, term.cols, term.rows))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    let finished = false

    ws.onopen = () => {
      // Make sure the remote PTY matches the actual size.
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows } satisfies TerminalClientMessage))
    }
    ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
      if (wsRef.current !== ws) return
      if (typeof ev.data === 'string') {
        let msg: TerminalServerMessage
        try {
          msg = JSON.parse(ev.data) as TerminalServerMessage
        } catch {
          return
        }
        if (msg.type === 'ready') {
          update('ready')
          term.focus()
        } else if (msg.type === 'exit') {
          finished = true
          term.write(`\r\n\x1b[2m[${i18n.t('terminal:output.exited', { code: msg.code })}]\x1b[0m\r\n`)
          update('exited', { key: 'reason.exited', code: msg.code })
        } else if (msg.type === 'error') {
          finished = true
          term.write(`\r\n\x1b[31m[${i18n.t('terminal:output.error', { message: msg.message })}]\x1b[0m\r\n`)
          update('error', { raw: msg.message })
        }
        return
      }
      term.write(new Uint8Array(ev.data))
    }
    ws.onerror = () => {
      /* onclose follows with details */
    }
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return
      if (finished) return
      const reason: OverlayMessage = ev.reason
        ? { raw: ev.reason }
        : ev.code === 1006
          ? { key: 'reason.aborted' }
          : { key: 'reason.closed', code: ev.code }
      const text = 'raw' in reason ? reason.raw : i18n.t(`terminal:${reason.key}`, { code: reason.code })
      term.write(`\r\n\x1b[33m[${text}]\x1b[0m\r\n`)
      update('closed', reason)
    }
  }, [serverId, safeFit, update])

  // Create the terminal once.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10000,
      allowProposedApi: false,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((d) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d))
    })
    const binSub = term.onBinary((d) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const buf = new Uint8Array(d.length)
      for (let i = 0; i < d.length; i++) buf[i] = d.charCodeAt(i) & 0xff
      ws.send(buf)
    })
    const resizeSub = term.onResize(({ cols, rows }) => sendControl({ type: 'resize', cols, rows }))

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(safeFit)
    })
    ro.observe(host)

    connect()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      dataSub.dispose()
      binSub.dispose()
      resizeSub.dispose()
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme()
  }, [theme])

  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      safeFit()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, safeFit])

  const reconnect = () => {
    termRef.current?.reset()
    connect()
  }

  return (
    <div className="term-pane" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      <div className="term-host" ref={hostRef} />
      {state === 'connecting' && (
        <div className="term-overlay">
          <Spinner /> {t('status.connecting')}
        </div>
      )}
      {(state === 'exited' || state === 'closed' || state === 'error') && (
        <div className="term-overlay">
          <span className={state === 'exited' ? 'muted' : 'danger-text'}>
            {message && ('raw' in message ? message.raw : t(message.key, { code: message.code }))}
          </span>
          <button className="btn btn-sm btn-primary" onClick={reconnect}>
            <RotateCw size={13} /> {t('reconnect')}
          </button>
        </div>
      )}
    </div>
  )
}
