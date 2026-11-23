import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  value: string[]
  onChange: (v: string[]) => void
  suggestions?: string[]
  placeholder?: string
}

export function TagInput({ value, onChange, suggestions = [], placeholder }: Props) {
  const { t: tr } = useTranslation()
  const [text, setText] = useState('')
  const listId = useId()

  const add = (raw: string) => {
    const parts = raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!parts.length) {
      setText('')
      return
    }
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setText('')
  }

  return (
    <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((t) => (
        <span key={t} className="tag">
          {t}
          <button
            type="button"
            className="tag-x"
            onClick={() => onChange(value.filter((x) => x !== t))}
            aria-label={tr('tags.remove', { tag: t })}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={text}
        list={listId}
        placeholder={value.length ? '' : (placeholder ?? tr('tags.placeholder'))}
        onChange={(e) => {
          const v = e.target.value
          if (/[,\s]$/.test(v)) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => add(text)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  )
}
