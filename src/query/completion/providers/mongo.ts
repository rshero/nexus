import { rankCompletionSuggestions } from "../ranking.ts"
import type { CompletionContext, CompletionProvider, CompletionResult, CompletionSuggestion } from "../types.ts"

interface ParsedContext {
  mode: "collections" | "rootOperations" | "chainOperations" | "filterFields" | "filterObjectId"
  token: string
  replaceStart: number
  replaceEnd: number
  collection?: string
}

const ROOT_OPERATIONS: CompletionSuggestion[] = [
  {
    id: "mongo-op-find",
    label: "find({})",
    kind: "operation",
    insertText: "find({})",
    cursorOffset: "find({".length,
    detail: "Find documents",
  },
  {
    id: "mongo-op-findOne",
    label: "findOne({})",
    kind: "operation",
    insertText: "findOne({})",
    cursorOffset: "findOne({".length,
    detail: "Find a single document",
  },
  {
    id: "mongo-op-countDocuments",
    label: "countDocuments({})",
    kind: "operation",
    insertText: "countDocuments({})",
    cursorOffset: "countDocuments({".length,
    detail: "Count documents",
  },
  {
    id: "mongo-op-deleteOne",
    label: "deleteOne({})",
    kind: "operation",
    insertText: "deleteOne({})",
    cursorOffset: "deleteOne({".length,
    detail: "Delete a single document",
  },
  {
    id: "mongo-op-deleteMany",
    label: "deleteMany({})",
    kind: "operation",
    insertText: "deleteMany({})",
    cursorOffset: "deleteMany({".length,
    detail: "Delete multiple documents",
  },
  {
    id: "mongo-op-aggregate",
    label: "aggregate([])",
    kind: "operation",
    insertText: "aggregate([])",
    cursorOffset: "aggregate([".length,
    detail: "Run aggregation pipeline",
  },
]

const CHAIN_OPERATIONS: CompletionSuggestion[] = [
  {
    id: "mongo-op-sort",
    label: "sort({})",
    kind: "operation",
    insertText: "sort({})",
    cursorOffset: "sort({".length,
    detail: "Sort result documents",
  },
  {
    id: "mongo-op-limit",
    label: "limit(20)",
    kind: "operation",
    insertText: "limit(20)",
    cursorOffset: "limit(".length,
    detail: "Limit result count",
  },
  {
    id: "mongo-op-skip",
    label: "skip(0)",
    kind: "operation",
    insertText: "skip(0)",
    cursorOffset: "skip(".length,
    detail: "Skip N documents",
  },
]

interface KeyToken {
  token: string
  replaceStartOffset: number
  replaceEndOffset: number
}

function extractMongoKeyToken(input: string): KeyToken | null {
  let depth = 1
  let inString: "'" | '"' | null = null
  let escaped = false
  let segmentStart = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === inString) {
        inString = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = char
      continue
    }

    if (char === "{") {
      depth += 1
      continue
    }

    if (char === "}") {
      depth -= 1
      if (depth < 1) return null
      continue
    }

    if (depth === 0 && char === ",") {
      segmentStart = i + 1
      continue
    }
  }

  if (depth < 1) {
    return null
  }

  const segment = input.slice(segmentStart)
  let keyDepth = 0
  inString = null
  escaped = false
  let hasTopLevelColon = false

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === inString) {
        inString = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = char
      continue
    }

    if (char === "{" || char === "[") {
      keyDepth += 1
      continue
    }

    if (char === "}" || char === "]") {
      keyDepth -= 1
      continue
    }

    if (char === ":" && keyDepth === 0) {
      hasTopLevelColon = true
      break
    }
  }

  if (hasTopLevelColon) {
    return null
  }

  const segmentLeadingSpace = segment.match(/^\s*/)?.[0].length ?? 0
  const candidate = segment.slice(segmentLeadingSpace)
  const quoted = candidate.match(/^["']([A-Za-z0-9_$.]*)$/)
  if (quoted) {
    const token = quoted[1] ?? ""
    const replaceStartOffset = segmentStart + segmentLeadingSpace + 1
    return {
      token,
      replaceStartOffset,
      replaceEndOffset: segmentStart + segment.length,
    }
  }

  const bare = candidate.match(/^([A-Za-z0-9_$.]*)$/)
  if (!bare) {
    return null
  }

  const token = bare[1] ?? ""
  const replaceStartOffset = segmentStart + segmentLeadingSpace
  return {
    token,
    replaceStartOffset,
    replaceEndOffset: segmentStart + segment.length,
  }
}

function parseMongoCompletionContext(query: string, cursor: number): ParsedContext | null {
  const beforeCursor = query.slice(0, cursor)

  const filterCall = /db\.([A-Za-z0-9_$]+)\.(find|findOne|countDocuments|deleteOne|deleteMany)\s*\(\s*\{([\s\S]*)$/i.exec(beforeCursor)
  if (filterCall) {
    const collection = filterCall[1] ?? ""
    const filterBody = filterCall[3] ?? ""

    const objectIdMatch = /(?:^|,)\s*["']?_id["']?\s*:\s*([A-Za-z0-9_$]*)$/i.exec(filterBody)
    if (objectIdMatch) {
      const token = objectIdMatch[1] ?? ""
      return {
        mode: "filterObjectId",
        token,
        replaceStart: cursor - token.length,
        replaceEnd: cursor,
        collection,
      }
    }

    const keyToken = extractMongoKeyToken(filterBody)
    if (keyToken) {
      const filterBodyStart = cursor - filterBody.length
      return {
        mode: "filterFields",
        token: keyToken.token,
        replaceStart: filterBodyStart + keyToken.replaceStartOffset,
        replaceEnd: filterBodyStart + keyToken.replaceEndOffset,
        collection,
      }
    }
  }

  const collectionsMatch = beforeCursor.match(/db\.([A-Za-z0-9_$]*)$/)
  if (collectionsMatch) {
    const token = collectionsMatch[1] ?? ""
    return {
      mode: "collections",
      token,
      replaceStart: cursor - token.length,
      replaceEnd: cursor,
    }
  }

  const operationsMatch = beforeCursor.match(/(.+)\.([A-Za-z0-9_$]*)$/)
  if (!operationsMatch) return null

  const expression = operationsMatch[1] ?? ""
  const token = operationsMatch[2] ?? ""

  if (/^db\.[A-Za-z0-9_$]+$/.test(expression)) {
    return {
      mode: "rootOperations",
      token,
      replaceStart: cursor - token.length,
      replaceEnd: cursor,
    }
  }

  if (/^db\.[A-Za-z0-9_$]+\.(find|findOne)\(/.test(expression)) {
    return {
      mode: "chainOperations",
      token,
      replaceStart: cursor - token.length,
      replaceEnd: cursor,
    }
  }

  return null
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

export const mongoCompletionProvider: CompletionProvider = {
  getCompletions(context: CompletionContext): CompletionResult | null {
    const parsed = parseMongoCompletionContext(context.query, context.cursor)
    if (!parsed) return null

    if (parsed.mode === "filterObjectId") {
      return {
        items: rankCompletionSuggestions(
          [
            {
              id: "mongo-filter-objectid",
              label: "ObjectId(\"...\")",
              kind: "snippet",
              insertText: "ObjectId(\"\")",
              cursorOffset: "ObjectId(\"".length,
              detail: "Mongo ObjectId value",
            },
          ],
          parsed.token
        ),
        replaceStart: parsed.replaceStart,
        replaceEnd: parsed.replaceEnd,
      }
    }

    if (parsed.mode === "filterFields") {
      const collectionFields = parsed.collection ? context.schema.collectionFields[parsed.collection] ?? [] : []
      const fieldNames = unique(["_id", ...collectionFields])
      const items = rankCompletionSuggestions(
        fieldNames.map((field) => ({
          id: `mongo-field-${parsed.collection ?? "any"}-${field}`,
          label: field,
          kind: "field",
          insertText: field,
          detail: parsed.collection ? `${parsed.collection} field` : "Document field",
        })),
        parsed.token
      )

      if (items.length === 0) return null

      return {
        items,
        replaceStart: parsed.replaceStart,
        replaceEnd: parsed.replaceEnd,
      }
    }

    if (parsed.mode === "collections") {
      const collectionSuggestions: CompletionSuggestion[] = context.schema.collections.map((name) => ({
        id: `mongo-col-${name}`,
        label: name,
        kind: "collection",
        insertText: name,
        detail: `Collection in ${context.database}`,
      }))

      const siblingDatabaseSuggestions: CompletionSuggestion[] = context.schema.databases.map((name) => ({
        id: `mongo-db-${name}`,
        label: `getSiblingDb(\"${name}\")`,
        kind: "database",
        insertText: `getSiblingDb(\"${name}\")`,
        detail: `Switch to database ${name}`,
      }))

      return {
        items: rankCompletionSuggestions([...collectionSuggestions, ...siblingDatabaseSuggestions], parsed.token),
        replaceStart: parsed.replaceStart,
        replaceEnd: parsed.replaceEnd,
      }
    }

    const items = parsed.mode === "chainOperations" ? CHAIN_OPERATIONS : ROOT_OPERATIONS
    return {
      items: rankCompletionSuggestions(items, parsed.token),
      replaceStart: parsed.replaceStart,
      replaceEnd: parsed.replaceEnd,
    }
  },
}
