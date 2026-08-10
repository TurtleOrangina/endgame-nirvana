// A minimal YAML writer/reader for the two files this measurement owns. Both are written
// by this code and only ever read back by it, so the supported subset is deliberately tiny:
// nested mappings, lists whose entries are either a single-line flow mapping or a block
// mapping of scalars plus a nested list, and JSON scalars. That is far less code than a
// YAML dependency would cost, and it fails loudly on anything it doesn't know.

export type YamlScalar = string | number | boolean | null
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue }

function formatScalar(value: YamlScalar): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)
}

function isScalar(value: YamlValue): value is YamlScalar {
  return value === null || typeof value !== 'object'
}

// Objects whose values are all scalars are written on one line — the per-puzzle rows stay
// diffable that way, which is the whole point of committing them
function formatFlowMapping(entries: Record<string, YamlScalar>): string {
  const pairs = Object.entries(entries).map(([key, value]) => `${key}: ${formatScalar(value)}`)
  return `{ ${pairs.join(', ')} }`
}

function isFlatMapping(value: YamlValue): value is Record<string, YamlScalar> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isScalar)
  )
}

export function formatYaml(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (isScalar(value)) return `${formatScalar(value)}\n`
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n'
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${formatScalar(item)}\n`
        if (isFlatMapping(item)) return `${pad}- ${formatFlowMapping(item)}\n`
        // A list entry with nested content is written as a block whose first key sits on
        // the dash line, so an entry reads as one thing rather than a dangling "-"
        const block = formatYaml(item, indent + 2)
        return `${pad}- ${block.slice(indent + 2)}`
      })
      .join('')
  }
  return Object.entries(value)
    .map(([key, child]) => {
      if (isScalar(child)) return `${pad}${key}: ${formatScalar(child)}\n`
      if (isFlatMapping(child)) return `${pad}${key}: ${formatFlowMapping(child)}\n`
      if (Array.isArray(child) && child.length === 0) return `${pad}${key}: []\n`
      return `${pad}${key}:\n${formatYaml(child, indent + 2)}`
    })
    .join('')
}

// Keys are bare identifiers and values are JSON, so quoting the keys turns a flow mapping
// into JSON outright
function parseFlowMapping(flow: string): Record<string, YamlScalar> {
  const asJson = flow.replaceAll(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
  return JSON.parse(asJson) as Record<string, YamlScalar>
}

/**
 * Reads back the scalar fields of every entry in the list written under `listKey` by
 * `formatYaml` — the committed puzzle set's rows, and the baselines' per-puzzle rows.
 * Entries may be flow mappings or block mappings; anything nested inside an entry (a
 * baseline row's `playouts:` list) is skipped, since only the scalars are comparable.
 */
export function parseMappingList(text: string, listKey: string): Record<string, YamlScalar>[] {
  const lines = text.split('\n')
  const listStart = lines.findIndex((line) => line.trimEnd() === `${listKey}:`)
  if (listStart === -1) throw new Error(`No "${listKey}:" list found in the YAML input`)

  const rows: Record<string, YamlScalar>[] = []
  let entryIndent: number | null = null
  let entry: Record<string, YamlScalar> | null = null

  const readInto = (target: Record<string, YamlScalar>, content: string): void => {
    if (content.startsWith('{')) {
      Object.assign(target, parseFlowMapping(content))
      return
    }
    const [, key, value] = /^([A-Za-z_]\w*):\s*(.*)$/.exec(content) ?? []
    // An empty value opens a nested block, whose lines are skipped by their indentation
    if (key !== undefined && value !== undefined && value !== '') {
      target[key] = JSON.parse(value) as YamlScalar
    }
  }

  for (const line of lines.slice(listStart + 1)) {
    if (line.trim() === '') continue
    const indent = line.search(/\S/)
    const dashed = /^-\s+(.*?)\s*$/.exec(line.slice(indent))
    entryIndent ??= dashed ? indent : null
    if (entryIndent === null) break
    // The list ends at the first line that is no deeper than its entries without starting one
    if (indent < entryIndent || (indent === entryIndent && !dashed)) break

    if (dashed && indent === entryIndent) {
      entry = {}
      rows.push(entry)
      readInto(entry, dashed[1]!)
    } else if (entry && indent === entryIndent + 2) {
      readInto(entry, line.trim())
    }
  }
  return rows
}
