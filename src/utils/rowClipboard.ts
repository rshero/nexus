import type { ColumnDef, DbType } from "../db/types.ts"

function orderedRow(columns: ColumnDef[], row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const seen = new Set<string>()

  for (const column of columns) {
    if (column.name in row) {
      next[column.name] = row[column.name]
      seen.add(column.name)
    }
  }

  for (const [key, value] of Object.entries(row)) {
    if (!seen.has(key)) next[key] = value
  }

  return next
}

function stringifyJson(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, child) => {
          if (typeof child === "bigint") return child.toString()
          if (child === undefined) return null
          return child
        },
        2
      ) ?? "null"
    )
  } catch {
    return String(value)
  }
}

function formatTabularValue(value: unknown): string {
  if (value === null || value === undefined) return ""

  const text = typeof value === "object" ? stringifyJson(value) : String(value)
  if (!/["\t\r\n]/.test(text)) return text

  return `"${text.replace(/"/g, '""')}"`
}

export function formatRowForClipboard(dbType: DbType, columns: ColumnDef[], row: Record<string, unknown>): string {
  const ordered = orderedRow(columns, row)

  if (dbType === "mongo" || dbType === "elasticsearch") {
    return stringifyJson(ordered)
  }

  const columnNames = Object.keys(ordered)
  const header = columnNames.join("\t")
  const values = columnNames.map((column) => formatTabularValue(ordered[column])).join("\t")

  return `${header}\n${values}`
}

function parseDelimitedLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!

    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
      continue
    }

    if (char === "\t") {
      values.push(current)
      current = ""
      continue
    }

    current += char
  }

  values.push(current)
  return values
}

function parseTabularValue(value: string): unknown {
  if (value === "") return null
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)

  const trimmed = value.trim()
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }

  return value
}

export function parseRowFromClipboard(input: string): { row?: Record<string, unknown>; error?: string } {
  const trimmed = input.trim()
  if (!trimmed) return { error: "Clipboard row is empty" }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { row: parsed as Record<string, unknown> }
    }
    return { error: "Clipboard JSON must be an object row" }
  } catch {
    // Fall through to tabular parsing.
  }

  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  if (lines.length < 2) return { error: "Clipboard row must be JSON or tab-separated header/value lines" }

  const headers = parseDelimitedLine(lines[0]!)
  const values = parseDelimitedLine(lines.slice(1).join("\n"))
  if (headers.length === 0 || headers.some((header) => header.length === 0)) {
    return { error: "Clipboard row has invalid tabular headers" }
  }

  const row: Record<string, unknown> = {}
  for (let i = 0; i < headers.length; i++) {
    row[headers[i]!] = parseTabularValue(values[i] ?? "")
  }

  return { row }
}
