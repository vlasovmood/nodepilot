import { ChevronRight, Repeat } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { cx } from '../../lib/util'
import { viewSchema, type JsonSchema, type OpenApiSpec, type SchemaView } from './openapi'

/** Text with `inline code` spans (descriptions in the spec use Markdown backticks). */
export function RichText({ text }: { text: string }) {
  const parts = text.split('`')
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : <Fragment key={i}>{p}</Fragment>))}</>
}

function fmt(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : JSON.stringify(v)
}

function TypeInfo({ v }: { v: SchemaView }) {
  return (
    <>
      <span className="sch-type">{v.typeLabel}</span>
      {v.nullable && <span className="sch-tag">null</span>}
      {v.notes.map((n) => (
        <span key={n} className="sch-tag">
          {n}
        </span>
      ))}
    </>
  )
}

function Extras({ v }: { v: SchemaView }) {
  const { t } = useTranslation('developer')
  if (!v.enumValues && !v.hasConst && !v.hasDefault) return null
  return (
    <div className="sch-extras">
      {v.hasConst && (
        <span>
          <Trans t={t} i18nKey="schema.const" values={{ value: fmt(v.constValue) }} components={{ code: <code /> }} />
        </span>
      )}
      {v.enumValues && (
        <span>
          {t('schema.enum')}{' '}
          {v.enumValues.map((e, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <code>{fmt(e)}</code>
            </Fragment>
          ))}
        </span>
      )}
      {v.hasDefault &&
        v.defaultValue !== null &&
        !(typeof v.defaultValue === 'object' && Object.keys(v.defaultValue as object).length === 0) && (
          <span>
            <Trans t={t} i18nKey="schema.default" values={{ value: fmt(v.defaultValue) }} components={{ code: <code /> }} />
          </span>
        )}
    </div>
  )
}

/** Readable, collapsible JSON Schema tree. `$ref`s are resolved; recursive refs are not expanded. */
export function SchemaTree({ spec, schema }: { spec: OpenApiSpec; schema: JsonSchema }) {
  useTranslation('developer') // re-render on language change: viewSchema() returns translated notes
  const v = viewSchema(spec, schema)
  const hasBody = !!(v.children?.length || v.variants?.length)
  return (
    <div className="sch">
      <div className="sch-root">
        <TypeInfo v={v} />
        {v.description && (
          <span className="sch-desc">
            <RichText text={v.description} />
          </span>
        )}
      </div>
      {!hasBody && <Extras v={v} />}
      {hasBody && <Members spec={spec} v={v} depth={0} ancestors={v.refs} />}
    </div>
  )
}

function Members({ spec, v, depth, ancestors }: { spec: OpenApiSpec; v: SchemaView; depth: number; ancestors: string[] }) {
  return (
    <div className="sch-members">
      {v.children?.map((c) => (
        <SchemaRow key={c.name} spec={spec} name={c.name} required={c.required} schema={c.schema} depth={depth} ancestors={ancestors} />
      ))}
      {v.variants?.map((alt, i) => (
        <SchemaRow key={i} spec={spec} name={alt.label} variant schema={alt.schema} depth={depth} ancestors={ancestors} />
      ))}
    </div>
  )
}

function SchemaRow({
  spec,
  name,
  required,
  variant,
  schema,
  depth,
  ancestors,
}: {
  spec: OpenApiSpec
  name: string
  required?: boolean
  variant?: boolean
  schema: JsonSchema
  depth: number
  ancestors: string[]
}) {
  const { t } = useTranslation('developer')
  const v = viewSchema(spec, schema, depth)
  const cyclic = v.refs.some((r) => ancestors.includes(r))
  const expandable = !cyclic && !!(v.children?.length || v.variants?.length) && depth < 10
  const [open, setOpen] = useState(false)

  return (
    <div className="sch-row">
      <div className={cx('sch-line', expandable && 'clickable')} onClick={expandable ? () => setOpen(!open) : undefined}>
        <span className="sch-chev">
          {expandable && <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} />}
        </span>
        <span className={cx('sch-name', variant && 'variant')}>{name}</span>
        {required && (
          <span className="sch-req" title={t('schema.requiredTitle')}>
            {t('schema.required')}
          </span>
        )}
        <TypeInfo v={v} />
        {cyclic && (
          <span className="sch-tag" title={t('schema.recursiveTitle')}>
            <Repeat size={10} /> {t('schema.recursive')}
          </span>
        )}
      </div>
      {(v.description || v.enumValues || v.hasConst || v.hasDefault) && (
        <div className="sch-meta">
          {v.description && (
            <div className="sch-desc">
              <RichText text={v.description} />
            </div>
          )}
          <Extras v={v} />
        </div>
      )}
      {expandable && open && <Members spec={spec} v={v} depth={depth + 1} ancestors={[...ancestors, ...v.refs]} />}
    </div>
  )
}
