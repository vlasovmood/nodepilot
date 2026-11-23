// Minimal OpenAPI 3.1 / JSON Schema 2020-12 model — just what the reference viewer needs.

import i18n from '../../i18n'

const tr = (key: string, opts?: Record<string, unknown>): string => i18n.t(`developer:${key}`, opts ?? {}) as string

export type JsonSchema = {
  $ref?: string
  type?: string | string[]
  title?: string
  description?: string
  format?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  prefixItems?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  default?: unknown
  example?: unknown
  examples?: unknown[]
  writeOnly?: boolean
  readOnly?: boolean
  deprecated?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

export type Parameter = {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema?: JsonSchema
}

export type MediaType = { schema?: JsonSchema }

export type Operation = {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  parameters?: Parameter[]
  requestBody?: { required?: boolean; description?: string; content?: Record<string, MediaType> }
  responses?: Record<string, { description?: string; content?: Record<string, MediaType> }>
  security?: unknown[]
  deprecated?: boolean
  'x-permission'?: string
}

export type OpenApiSpec = {
  openapi: string
  info: { title: string; version: string; description?: string }
  servers?: { url: string }[]
  paths: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, JsonSchema> }
  'x-permission-areas'?: { name: string; description: string }[]
}

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

export type Endpoint = {
  key: string
  method: string
  path: string
  tag: string
  op: Operation
  parameters: Parameter[]
}

export function listEndpoints(spec: OpenApiSpec): Endpoint[] {
  const out: Endpoint[] = []
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = (item.parameters as Parameter[] | undefined) ?? []
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined
      if (!op || typeof op !== 'object') continue
      // operation-level parameters override path-level ones with the same name+in
      const own = op.parameters ?? []
      const params = [...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)), ...own]
      out.push({
        key: op.operationId ?? `${method} ${path}`,
        method,
        path,
        tag: op.tags?.[0] ?? UNTAGGED,
        op,
        parameters: params,
      })
    }
  }
  return out
}

/** Fallback tag for operations without one (rendered as "Other"). */
export const UNTAGGED = 'Other'

/** Backend OpenAPI tag → translation key in the `developer` namespace. Order defines group order. */
export const TAG_LABEL_KEYS: Record<string, string> = {
  Auth: 'tags.auth',
  Meta: 'tags.meta',
  Servers: 'tags.servers',
  Stats: 'tags.stats',
  Projects: 'tags.projects',
  Identities: 'tags.identities',
  Exec: 'tags.exec',
  'Terminal sessions': 'tags.terminalSessions',
  System: 'tags.system',
  Files: 'tags.files',
  Notes: 'tags.notes',
  Graphs: 'tags.graphs',
  Backups: 'tags.backups',
  Tokens: 'tags.tokens',
  AI: 'tags.ai',
  [UNTAGGED]: 'tags.other',
}
const TAG_ORDER = Object.keys(TAG_LABEL_KEYS)

/** Translated tag name (call during render). */
export const tagLabel = (t: string) => (TAG_LABEL_KEYS[t] ? tr(TAG_LABEL_KEYS[t]) : t)

const METHOD_ORDER: Record<string, number> = { get: 0, post: 1, put: 2, patch: 3, delete: 4 }

export function groupEndpoints(eps: Endpoint[]): { tag: string; items: Endpoint[] }[] {
  const map = new Map<string, Endpoint[]>()
  for (const e of eps) {
    const arr = map.get(e.tag) ?? []
    arr.push(e)
    map.set(e.tag, arr)
  }
  const rank = (t: string) => {
    const i = TAG_ORDER.indexOf(t)
    return i === -1 ? TAG_ORDER.length : i
  }
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([tag, items]) => ({
      tag,
      items: items.sort((a, b) => a.path.localeCompare(b.path) || (METHOD_ORDER[a.method] ?? 9) - (METHOD_ORDER[b.method] ?? 9)),
    }))
}

// ---------- schema resolution ----------

const REF_PREFIX = '#/components/schemas/'

export function refName(ref: string): string {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref
}

export function resolveRef(spec: OpenApiSpec, ref: string): JsonSchema | undefined {
  if (!ref.startsWith(REF_PREFIX)) return undefined
  return spec.components?.schemas?.[refName(ref)]
}

function mergeSchemas(base: JsonSchema, over: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...base, ...over }
  if (base.properties || over.properties) merged.properties = { ...base.properties, ...over.properties }
  if (base.required || over.required) merged.required = [...new Set([...(base.required ?? []), ...(over.required ?? [])])]
  return merged
}

const isNullSchema = (s: JsonSchema) => s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null')

export type SchemaView = {
  /** Display type, e.g. `string`, `integer · uint32`, `Note[]`, `map<string, Level>`, `oneOf`. */
  typeLabel: string
  /** Name of the referenced component (for display and cycle detection). */
  ref?: string
  nullable: boolean
  description?: string
  enumValues?: unknown[]
  constValue?: unknown
  hasConst: boolean
  hasDefault: boolean
  defaultValue?: unknown
  notes: string[]
  /** Object members (for arrays — members of the item object). */
  children?: { name: string; required: boolean; schema: JsonSchema }[]
  /** Alternatives of oneOf/anyOf (for arrays — of the items). */
  variants?: { label: string; schema: JsonSchema }[]
  /** Refs traversed while unwrapping (for cycle guard). */
  refs: string[]
}

/**
 * Flatten a schema node for display: follow `$ref` (merging sibling keywords), fold `T | null`
 * into `nullable`, unwrap arrays into their item's members and list `oneOf` alternatives.
 */
export function viewSchema(spec: OpenApiSpec, input: JsonSchema | undefined, depth = 0): SchemaView {
  const refs: string[] = []
  let s: JsonSchema = input ?? {}
  let nullable = false
  let description = s.description
  let ref: string | undefined

  for (let guard = 0; guard < 16; guard++) {
    if (s.$ref) {
      const name = refName(s.$ref)
      if (refs.includes(name)) break
      refs.push(name)
      ref ??= name
      const { $ref: _ignored, ...rest } = s
      void _ignored
      const target = resolveRef(spec, s.$ref) ?? {}
      s = mergeSchemas(target, rest)
      description ??= s.description
      continue
    }
    if (s.allOf?.length) {
      const { allOf, ...rest } = s
      s = allOf.reduce<JsonSchema>((acc, part) => mergeSchemas(acc, part), rest)
      continue
    }
    const alts = s.anyOf ?? s.oneOf
    if (alts) {
      const nonNull = alts.filter((a) => !isNullSchema(a))
      if (nonNull.length < alts.length) nullable = true
      if (nonNull.length === 1) {
        const { anyOf: _a, oneOf: _o, ...rest } = s
        void _a
        void _o
        s = mergeSchemas(rest, nonNull[0])
        if (!nonNull[0].$ref) description ??= s.description
        continue
      }
    }
    break
  }

  const notes: string[] = []
  let types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
  if (types.includes('null')) {
    nullable = true
    types = types.filter((t) => t !== 'null')
  }
  if (s.format && s.format !== 'binary') notes.push(s.format)
  if (s.minimum !== undefined && s.maximum !== undefined) notes.push(`${s.minimum}…${s.maximum}`)
  else if (s.minimum !== undefined && s.minimum !== 0) notes.push(`≥ ${s.minimum}`)
  else if (s.maximum !== undefined) notes.push(`≤ ${s.maximum}`)
  if (s.minItems !== undefined || s.maxItems !== undefined) notes.push(tr('schema.items', { min: s.minItems ?? 0, max: s.maxItems ?? '∞' }))
  if (s.minLength !== undefined || s.maxLength !== undefined)
    notes.push(tr('schema.length', { min: s.minLength ?? 0, max: s.maxLength ?? '∞' }))
  if (s.writeOnly) notes.push(tr('schema.writeOnly'))
  if (s.readOnly) notes.push(tr('schema.readOnly'))
  if (s.deprecated) notes.push(tr('schema.deprecated'))

  const view: SchemaView = {
    typeLabel: '',
    ref,
    nullable,
    description,
    enumValues: s.enum,
    constValue: s.const,
    hasConst: 'const' in s,
    hasDefault: 'default' in s,
    defaultValue: s.default,
    notes,
    refs,
  }

  const alts = s.oneOf ?? s.anyOf
  if (alts && alts.filter((a) => !isNullSchema(a)).length > 1) {
    view.typeLabel = ref ?? (s.oneOf ? tr('schema.oneOf') : tr('schema.anyOf'))
    view.variants = alts.filter((a) => !isNullSchema(a)).map((a, i) => ({ label: variantLabel(spec, a, i), schema: a }))
    return view
  }

  const type = types[0] ?? (s.properties ? 'object' : s.items ? 'array' : '')
  if (type === 'array') {
    if (s.items && depth < 12) {
      const item = viewSchema(spec, s.items, depth + 1)
      view.typeLabel = `${item.ref ?? item.typeLabel}${item.nullable ? '?' : ''}[]`
      view.children = item.children
      view.variants = item.variants
      view.refs = [...refs, ...item.refs]
      if (!view.description) view.description = item.description
      if (item.enumValues) view.enumValues = item.enumValues
    } else view.typeLabel = 'array'
    return view
  }
  if (type === 'object' || s.properties) {
    const req = new Set(s.required ?? [])
    view.children = Object.entries(s.properties ?? {}).map(([name, schema]) => ({ name, required: req.has(name), schema }))
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      const val = viewSchema(spec, s.additionalProperties, depth + 1)
      view.typeLabel = `map<string, ${val.ref ?? val.typeLabel}>`
      view.children.push({ name: tr('schema.mapKey'), required: false, schema: s.additionalProperties })
    } else view.typeLabel = ref ?? 'object'
    if (view.children.length === 0 && s.additionalProperties !== true) view.children = undefined
    if (s.additionalProperties === true && !s.properties) view.typeLabel = tr('schema.anyObject')
    return view
  }
  if (s.format === 'binary') view.typeLabel = 'binary'
  else if (types.length > 1) view.typeLabel = types.join(' | ')
  else view.typeLabel = type || (view.hasConst ? typeof s.const : 'any')
  return view
}

function variantLabel(spec: OpenApiSpec, s: JsonSchema, i: number): string {
  const v = viewSchema(spec, s)
  // discriminator-like: a property with `const`
  const disc = v.children?.find((c) => c.schema.const !== undefined)
  if (disc) return `${disc.name} = ${JSON.stringify(disc.schema.const)}`
  if (v.ref) return v.ref
  return tr('schema.variant', { n: i + 1, type: v.typeLabel })
}

// ---------- examples ----------

const STRING_HINTS: Record<string, string> = {
  name: 'example',
  description: '',
  host: '192.0.2.10',
  username: 'root',
  password: 'secret',
  command: 'uptime',
  path: '/tmp',
  from: '/tmp/a.txt',
  to: '/tmp/b.txt',
  color: '#ffffff',
  schedule: '0 0 3 * * *',
  signal: 'TERM',
}

/** Natural-language example values, translated when the example is built. */
const LOCALIZED_HINTS: Record<string, string> = { title: 'schema.exampleTitle', body: 'schema.exampleBody' }

/** Build a plausible JSON example for a schema (used to prefill "try it" bodies). */
export function exampleFor(spec: OpenApiSpec, schema: JsonSchema | undefined, propName?: string, seen: string[] = []): unknown {
  if (!schema) return null
  if (seen.length > 8) return null
  if (schema.example !== undefined) return schema.example
  if (schema.examples?.length) return schema.examples[0]
  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (seen.includes(name)) return null
    const { $ref: _r, ...rest } = schema
    void _r
    return exampleFor(spec, mergeSchemas(resolveRef(spec, schema.$ref) ?? {}, rest), propName, [...seen, name])
  }
  if ('default' in schema) return schema.default
  if ('const' in schema) return schema.const
  if (schema.enum?.length) return schema.enum[0]
  if (schema.allOf?.length)
    return exampleFor(
      spec,
      schema.allOf.reduce<JsonSchema>((a, p) => mergeSchemas(a, p), {}),
      propName,
      seen,
    )
  const alts = schema.anyOf ?? schema.oneOf
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const nullable = types.includes('null') || !!alts?.some(isNullSchema)
  // ids are better left null than filled with garbage
  if (nullable && propName && /(_id|_ids)$/.test(propName)) return null
  if (alts?.length) {
    const first = alts.find((a) => !isNullSchema(a))
    return first ? exampleFor(spec, first, propName, seen) : null
  }
  const type = types.find((t) => t !== 'null') ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined)
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = exampleFor(spec, v, k, seen)
      return out
    }
    case 'array':
      if (propName && /_ids$/.test(propName)) return []
      return schema.items ? [exampleFor(spec, schema.items, propName, seen)] : []
    case 'string':
      if (schema.format === 'date-time') return new Date().toISOString()
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
      if (propName && LOCALIZED_HINTS[propName]) return tr(LOCALIZED_HINTS[propName])
      return (propName && STRING_HINTS[propName]) ?? 'string'
    case 'integer':
    case 'number':
      if (propName === 'port') return 22
      return schema.minimum ?? 0
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      return null
  }
}

// ---------- operation helpers ----------

export function jsonBodySchema(op: Operation): JsonSchema | undefined {
  return op.requestBody?.content?.['application/json']?.schema
}

export function isBinaryBody(op: Operation): boolean {
  const c = op.requestBody?.content
  return !!c && !c['application/json'] && Object.keys(c).length > 0
}

export function isWebSocket(op: Operation): boolean {
  return !!op.responses?.['101']
}

export function isBinaryDownload(op: Operation): boolean {
  const c = op.responses?.['200']?.content
  return !!c && !c['application/json'] && Object.keys(c).some((k) => k === 'application/octet-stream' || !k.startsWith('text/'))
}

export function isPublic(op: Operation): boolean {
  return Array.isArray(op.security) && op.security.length === 0
}

/** Description without the auto-generated "required permission" sentence (shown as a badge instead). */
export function cleanDescription(op: Operation): string {
  return (op.description ?? '').replace(/Требуемые права токена:\s*`[^`]*`\.?/g, '').trim()
}
