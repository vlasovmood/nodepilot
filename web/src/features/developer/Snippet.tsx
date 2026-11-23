import type { ReactNode } from 'react'
import { CopyButton } from '../../components/CopyButton'

/** Copyable code block with an optional caption. */
export function Snippet({ title, code, hint }: { title?: ReactNode; code: string; hint?: ReactNode }) {
  return (
    <div className="snippet">
      {(title || hint) && (
        <div className="snippet-head">
          {title && <span className="snippet-title">{title}</span>}
          {hint && <span className="dim small">{hint}</span>}
        </div>
      )}
      <div className="snippet-body">
        <pre className="snippet-code">{code}</pre>
        <div className="snippet-copy">
          <CopyButton text={code} />
        </div>
      </div>
    </div>
  )
}

/** Value with a copy button, inline (base URLs, endpoints). */
export function CopyValue({ value }: { value: string }) {
  return (
    <span className="copy-value">
      <code>{value}</code>
      <CopyButton text={value} />
    </span>
  )
}
