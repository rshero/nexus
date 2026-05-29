import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import {
  deleteWordBackward,
  getTextInput,
  isDeleteWordKey,
  isInsertNewlineKey,
  isSubmitKey,
  moveCursorWordLeft,
  moveCursorWordRight,
  normalizeTextInput,
} from "../../utils/keyInput.ts"
import { subscribePaste } from "../../state/paste.ts"
import { CompletionMenu } from "../common/CompletionMenu.tsx"
import { getCompletions } from "../../query/completion/engine.ts"
import { deleteWithAutoPair, insertWithAutoPair } from "../../query/editor/autoPair.ts"
import { formatQuery, highlightQueryLines, type QueryToken, type QueryTokenRole } from "../../query/editor/highlight.ts"
import type { CompletionSuggestion } from "../../query/completion/types.ts"
import type { DbType } from "../../db/types.ts"
import type { ThemeColors } from "../../theme/themes.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"

interface QueryConsoleProps {
  focused: boolean
  query: string
  error?: string | null
  dbType: DbType
  database: string
  schemaDatabases: string[]
  schemaCollections: string[]
  schemaCollectionFields: Record<string, string[]>
  onChange: (query: string) => void
  onExecute: (query: string) => void
  onBlur: () => void
}

interface ActiveCompletion {
  items: CompletionSuggestion[]
  replaceStart: number
  replaceEnd: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getTokenColor(role: QueryTokenRole, colors: ThemeColors): string {
  switch (role) {
    case "keyword":
      return colors.queryKeyword
    case "function":
      return colors.queryFunction
    case "field":
      return colors.queryField
    case "string":
      return colors.queryString
    case "number":
      return colors.queryNumber
    case "operator":
      return colors.queryOperator
    case "comment":
      return colors.queryComment
    case "error":
      return colors.error
    case "text":
      return colors.text
  }
}

function renderToken(token: QueryToken, colors: ThemeColors): ReactNode {
  return (
    <span key={`${token.start}-${token.end}-${token.role}`} fg={getTokenColor(token.role, colors)}>
      {token.text}
    </span>
  )
}

function renderLineTokens(tokens: QueryToken[], line: string, colors: ThemeColors): ReactNode {
  if (line.length === 0) return " "
  if (tokens.length === 0) return line
  return tokens.map((token) => renderToken(token, colors))
}

function renderPlainCursorLine(line: string, cursorOffset: number, colors: ThemeColors): ReactNode {
  const before = line.slice(0, cursorOffset)
  const current = line[cursorOffset]
  const after = line.slice(cursorOffset + (current ? 1 : 0))

  return (
    <>
      {before}
      {current ? (
        <span fg={colors.background} bg={colors.accent}>
          {current}
        </span>
      ) : (
        <span fg={colors.accent}>█</span>
      )}
      {after}
    </>
  )
}

function renderCursorLine(tokens: QueryToken[], line: string, lineStart: number, cursorPos: number, colors: ThemeColors): ReactNode {
  const cursorOffset = clamp(cursorPos - lineStart, 0, line.length)
  const cursorAbsolute = lineStart + cursorOffset
  const parts: ReactNode[] = []
  let insertedCursor = false

  if (line.length === 0) {
    return <span fg={colors.accent}>█</span>
  }

  if (tokens.length === 0) {
    return renderPlainCursorLine(line, cursorOffset, colors)
  }

  for (const token of tokens) {
    const color = getTokenColor(token.role, colors)

    if (!insertedCursor && cursorAbsolute >= token.start && cursorAbsolute < token.end) {
      const before = line.slice(token.start - lineStart, cursorAbsolute - lineStart)
      const current = line[cursorOffset] ?? ""
      const after = line.slice(cursorOffset + 1, token.end - lineStart)

      if (before) {
        parts.push(
          <span key={`${token.start}-before`} fg={color}>
            {before}
          </span>
        )
      }

      parts.push(
        <span key={`${cursorAbsolute}-cursor`} fg={colors.background} bg={colors.accent}>
          {current}
        </span>
      )

      if (after) {
        parts.push(
          <span key={`${token.start}-after`} fg={color}>
            {after}
          </span>
        )
      }

      insertedCursor = true
      continue
    }

    parts.push(renderToken(token, colors))
  }

  if (!insertedCursor) {
    parts.push(
      <span key={`${cursorAbsolute}-cursor-end`} fg={colors.accent}>
        █
      </span>
    )
  }

  return parts
}

function findCurrentLineIndex(lineStarts: number[], cursorPos: number): number {
  let idx = 0
  for (let i = 0; i < lineStarts.length; i++) {
    if ((lineStarts[i] ?? 0) <= cursorPos) idx = i
  }
  return idx
}

export function QueryConsole({
  focused,
  query,
  error,
  dbType,
  database,
  schemaDatabases,
  schemaCollections,
  schemaCollectionFields,
  onChange,
  onExecute,
  onBlur,
}: QueryConsoleProps) {
  const { colors } = useTheme()
  const [cursorPos, setCursorPos] = useState(query.length)
  const [completion, setCompletion] = useState<ActiveCompletion | null>(null)
  const [completionIndex, setCompletionIndex] = useState(0)
  const preferredColumnRef = useRef<number | null>(null)

  useEffect(() => {
    setCursorPos((prev) => clamp(prev, 0, query.length))
  }, [query])

  const lines = useMemo(() => query.split("\n"), [query])
  const lineStarts = useMemo(() => {
    const starts: number[] = [0]
    for (let i = 0; i < query.length; i++) {
      if (query[i] === "\n") starts.push(i + 1)
    }
    return starts
  }, [query])
  const beforeCursor = query.slice(0, cursorPos)
  const cursorLine = useMemo(() => findCurrentLineIndex(lineStarts, cursorPos), [lineStarts, cursorPos])
  const cursorColumn = beforeCursor.length - (beforeCursor.lastIndexOf("\n") + 1)
  const highlightedLines = useMemo(() => highlightQueryLines(query, dbType), [query, dbType])

  const closeCompletion = useCallback(() => {
    setCompletion(null)
    setCompletionIndex(0)
  }, [])

  const updateQuery = useCallback(
    (next: string, nextCursor: number) => {
      onChange(next)
      setCursorPos(clamp(nextCursor, 0, next.length))
      preferredColumnRef.current = null
    },
    [onChange]
  )

  const refreshCompletion = useCallback(
    (nextQuery: string, nextCursor: number, preserveSelection = true) => {
      const result = getCompletions({
        query: nextQuery,
        cursor: nextCursor,
        dbType,
        database,
        schema: {
          databases: schemaDatabases,
          collections: schemaCollections,
          collectionFields: schemaCollectionFields,
        },
      })

      if (!result || result.items.length === 0) {
        closeCompletion()
        return
      }

      setCompletion(result)
      if (preserveSelection) {
        setCompletionIndex((prev) => Math.min(prev, result.items.length - 1))
      } else {
        setCompletionIndex(0)
      }
    },
    [dbType, database, schemaDatabases, schemaCollections, schemaCollectionFields, closeCompletion]
  )

  const moveCursorVertical = useCallback(
    (direction: -1 | 1): number | null => {
      const targetLineIndex = cursorLine + direction
      if (targetLineIndex < 0 || targetLineIndex >= lines.length) return null

      const currentLineStart = lineStarts[cursorLine] ?? 0
      const targetLineStart = lineStarts[targetLineIndex] ?? 0
      const targetLineLength = lines[targetLineIndex]?.length ?? 0
      const currentColumn = cursorPos - currentLineStart
      const preferredColumn = preferredColumnRef.current ?? currentColumn
      const nextColumn = Math.min(preferredColumn, targetLineLength)
      const nextCursor = targetLineStart + nextColumn

      preferredColumnRef.current = preferredColumn
      setCursorPos(nextCursor)
      return nextCursor
    },
    [cursorLine, cursorPos, lineStarts, lines]
  )

  const applyCompletion = useCallback(
    (item: CompletionSuggestion) => {
      if (!completion) return
      const next = `${query.slice(0, completion.replaceStart)}${item.insertText}${query.slice(completion.replaceEnd)}`
      const nextCursor = completion.replaceStart + (item.cursorOffset ?? item.insertText.length)
      updateQuery(next, nextCursor)
      closeCompletion()
    },
    [completion, query, updateQuery, closeCompletion]
  )

  useKeyboard((key) => {
    if (!focused) return

    const hasCompletion = completion && completion.items.length > 0

    if (hasCompletion && (key.name === "down" || key.name === "j")) {
      setCompletionIndex((prev) => Math.min((completion?.items.length ?? 1) - 1, prev + 1))
      return
    }

    if (hasCompletion && (key.name === "up" || key.name === "k")) {
      setCompletionIndex((prev) => Math.max(0, prev - 1))
      return
    }

    if (key.ctrl && key.name === "l") {
      updateQuery("", 0)
      closeCompletion()
      return
    }

    if (key.name === "tab") {
      if (hasCompletion) {
        const selected = completion?.items[completionIndex]
        if (selected) {
          applyCompletion(selected)
        }
      } else {
        const next = `${query.slice(0, cursorPos)}  ${query.slice(cursorPos)}`
        updateQuery(next, cursorPos + 2)
        refreshCompletion(next, cursorPos + 2)
      }
      return
    }

    if (hasCompletion && isSubmitKey(key) && !isInsertNewlineKey(key)) {
      const selected = completion?.items[completionIndex]
      if (selected) {
        applyCompletion(selected)
      }
      return
    }

    if (key.name === "escape") {
      if (hasCompletion) {
        closeCompletion()
      } else {
        onBlur()
      }
      return
    }

    if (key.ctrl && key.name === "f") {
      const formatted = formatQuery(query, dbType, cursorPos)
      if (formatted.changed) {
        updateQuery(formatted.query, formatted.cursor)
        closeCompletion()
      }
      return
    }

    if (isSubmitKey(key) && !isInsertNewlineKey(key)) {
      onExecute(query)
      return
    }

    if (isInsertNewlineKey(key)) {
      const next = `${query.slice(0, cursorPos)}\n${query.slice(cursorPos)}`
      updateQuery(next, cursorPos + 1)
      closeCompletion()
      return
    }

    if (isDeleteWordKey(key)) {
      const result = deleteWordBackward(query, cursorPos)
      updateQuery(result.value, result.cursor)
      refreshCompletion(result.value, result.cursor)
      return
    }

    if (key.name === "left") {
      preferredColumnRef.current = null
      const nextCursor = key.ctrl ? moveCursorWordLeft(query, cursorPos) : Math.max(0, cursorPos - 1)
      setCursorPos(nextCursor)
      refreshCompletion(query, nextCursor)
      return
    }

    if (key.name === "right") {
      preferredColumnRef.current = null
      const nextCursor = key.ctrl ? moveCursorWordRight(query, cursorPos) : Math.min(query.length, cursorPos + 1)
      setCursorPos(nextCursor)
      refreshCompletion(query, nextCursor)
      return
    }

    if (key.name === "up") {
      const nextCursor = moveCursorVertical(-1)
      if (nextCursor !== null) refreshCompletion(query, nextCursor)
      return
    }

    if (key.name === "down") {
      const nextCursor = moveCursorVertical(1)
      if (nextCursor !== null) refreshCompletion(query, nextCursor)
      return
    }

    if (key.name === "home") {
      preferredColumnRef.current = null
      setCursorPos(0)
      refreshCompletion(query, 0)
      return
    }

    if (key.name === "end") {
      preferredColumnRef.current = null
      const nextCursor = query.length
      setCursorPos(nextCursor)
      refreshCompletion(query, nextCursor)
      return
    }

    if (key.name === "backspace") {
      const result = deleteWithAutoPair(query, cursorPos)
      updateQuery(result.value, result.cursor)
      refreshCompletion(result.value, result.cursor)
      return
    }

    if (key.name === "delete") {
      if (cursorPos >= query.length) return
      const next = `${query.slice(0, cursorPos)}${query.slice(cursorPos + 1)}`
      updateQuery(next, cursorPos)
      refreshCompletion(next, cursorPos)
      return
    }

    const inputText = getTextInput(key, { allowNewline: true })
    if (inputText) {
      if (inputText.length > 1) {
        const nextValue = `${query.slice(0, cursorPos)}${inputText}${query.slice(cursorPos)}`
        const nextCursor = cursorPos + inputText.length
        updateQuery(nextValue, nextCursor)
        refreshCompletion(nextValue, nextCursor)
        return
      }

      const paired = insertWithAutoPair(query, cursorPos, inputText)
      updateQuery(paired.value, paired.cursor)
      refreshCompletion(paired.value, paired.cursor)
    }
  })

  const applyPastedText = useCallback(
    (rawText: string) => {
      if (!focused) return

      const pasted = normalizeTextInput(rawText, { allowNewline: true })
      if (!pasted) return

      const next = `${query.slice(0, cursorPos)}${pasted}${query.slice(cursorPos)}`
      const nextCursor = cursorPos + pasted.length
      updateQuery(next, nextCursor)
      refreshCompletion(next, nextCursor)
    },
    [focused, query, cursorPos, updateQuery, refreshCompletion]
  )

  useEffect(() => subscribePaste(applyPastedText), [applyPastedText])

  const handlePaste = useCallback(
    (event: { text: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
      applyPastedText(event.text)
      event.preventDefault?.()
      event.stopPropagation?.()
    },
    [applyPastedText]
  )

  return (
    <box flexGrow={1} flexDirection="column" padding={1} onPaste={handlePaste}>
      <text fg={colors.muted}>Enter run • ↑↓ move lines • Ctrl+L clear • Ctrl+Enter newline • Ctrl+F format • Esc exit input</text>
      <box height={1}>
        <text fg={colors.border}>{"─".repeat(200)}</text>
      </box>
      {error && <text fg={colors.error}>{error}</text>}
      <box flexGrow={1} flexDirection="column">
        {lines.length === 0 ? (
          <>
            <text fg={colors.muted}>Type query...</text>
            <text fg={colors.muted}>Mongo examples: db.users.find(&#123;&#125;)</text>
            <text fg={colors.muted}>db.users.find(&#123;"year": &#123;"$gte": 2000&#125;&#125;).sort(&#123;"year": -1&#125;).limit(20)</text>
          </>
        ) : (
          lines.map((line, lineIndex) => {
            const lineKey = `line-${lineStarts[lineIndex] ?? lineIndex}`
            const highlightedLine = highlightedLines[lineIndex]
            const tokens = highlightedLine?.tokens ?? []
            const lineStart = highlightedLine?.start ?? lineStarts[lineIndex] ?? 0

            if (!focused || lineIndex !== cursorLine) {
              return (
                <text key={lineKey} fg={colors.text}>
                  {renderLineTokens(tokens, line, colors)}
                </text>
              )
            }

            const safeColumn = clamp(cursorColumn, 0, line.length)
            const completionLeft = Math.max(0, safeColumn)

            return (
              <box key={lineKey} flexDirection="column">
                <text fg={colors.textBright}>
                  {renderCursorLine(tokens, line, lineStart, cursorPos, colors)}
                </text>
                {completion && completion.items.length > 0 && (
                  <box flexDirection="row">
                    {completionLeft > 0 && <box width={completionLeft} />}
                    <CompletionMenu visible={true} items={completion.items} selectedIndex={completionIndex} />
                  </box>
                )}
              </box>
            )
          })
        )}
      </box>
    </box>
  )
}
