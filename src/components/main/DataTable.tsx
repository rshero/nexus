import { useState, useMemo, useCallback, useEffect } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { MouseEvent as TuiMouseEvent } from "@opentui/core"
import type { QueryResult, ColumnDef } from "../../db/types.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"

export interface SelectedCell {
  rowIndex: number
  colIndex: number
  columnName: string
  value: unknown
  row: Record<string, unknown>
}

interface DataTableProps {
  result: QueryResult
  focused: boolean
  currentOffset: number
  pageSize: number
  onPageChange?: (offset: number) => void
  onCellSelect?: (cell: SelectedCell) => void
  onColumnSort?: (column: string, direction: 1 | -1) => void
  currentSort?: Record<string, 1 | -1> | null
  sidebarWidth?: number
  detailWidth?: number
  filterBarActive?: boolean
}

type TableColors = {
  header: string
  headerBg: string
  separator: string
  selectedRow: string
  selectedCell: string
  string: string
  number: string
  boolean: string
  null: string
  object: string
  text: string
  dim: string
  rowNum: string
  pageBg: string
  pageActive: string
  pageInactive: string
  hintKey: string
  footerBg: string
  scrollTrack: string
  scrollThumb: string
}

const MIN_COL_WIDTH = 6
const MAX_COL_WIDTH = 40
const SAMPLE_ROWS = 20
const FIXED_PAGE_SIZE = 20
const ROW_NUM_WIDTH = 4
const COL_SEPARATOR = "│"
const COL_PADDING = " "

function getValueType(value: unknown): keyof TableColors {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return "string"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "object") return "object"
  return "text"
}

function formatCellValue(value: unknown, maxWidth: number): string {
  let str: string
  if (value === null || value === undefined) {
    str = "null"
  } else if (typeof value === "object") {
    try {
      str = JSON.stringify(value)
    } catch {
      str = "[object]"
    }
  } else {
    str = String(value)
  }

  // Replace newlines/tabs with visible placeholders
  str = str.replace(/\n/g, "↵").replace(/\t/g, "→").replace(/\r/g, "")

  if (str.length > maxWidth) {
    return str.slice(0, maxWidth - 1) + "…"
  }
  return str
}

function padCell(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  return text + " ".repeat(width - text.length)
}

function computeColumnWidths(
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  _availableWidth: number
): number[] {
  // Compute natural widths from data - no shrinking to fit viewport
  const widths: number[] = columns.map((col) => Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, col.name.length)))

  const sampleRows = rows.slice(0, SAMPLE_ROWS)
  for (const row of sampleRows) {
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]!
      const value = row[col.name]
      const formatted = formatCellValue(value, MAX_COL_WIDTH)
      widths[i] = Math.min(MAX_COL_WIDTH, Math.max(widths[i]!, formatted.length))
    }
  }

  return widths
}

export function DataTable({
  result,
  focused,
  currentOffset,
  pageSize: _pageSize,
  onPageChange,
  onCellSelect,
  onColumnSort,
  currentSort,
  sidebarWidth = 0,
  detailWidth = 0,
  filterBarActive = false,
}: DataTableProps) {
  const { colors: themeColors } = useTheme()
  const COLORS = useMemo<TableColors>(
    () => ({
      header: themeColors.textBright,
      headerBg: themeColors.backgroundMuted,
      separator: themeColors.border,
      selectedRow: themeColors.surfaceAlt,
      selectedCell: themeColors.surfaceStrong,
      string: themeColors.success,
      number: themeColors.info,
      boolean: themeColors.warning,
      null: themeColors.muted,
      object: themeColors.purple,
      text: themeColors.text,
      dim: themeColors.muted,
      rowNum: themeColors.border,
      pageBg: themeColors.background,
      pageActive: themeColors.accent,
      pageInactive: themeColors.info,
      hintKey: themeColors.accent,
      footerBg: themeColors.backgroundMuted,
      scrollTrack: themeColors.background,
      scrollThumb: themeColors.border,
    }),
    [themeColors]
  )
  const { width: termWidth, height: termHeight } = useTerminalDimensions()
  const [selectedRow, setSelectedRow] = useState(0)
  const [selectedCol, setSelectedCol] = useState(0)
  // Viewport offsets - what portion of content is visible
  const [viewportRowOffset, setViewportRowOffset] = useState(0)
  const [viewportColOffset, setViewportColOffset] = useState(0)

  const { columns, rows: allRows, totalCount } = result
  const usesLocalPagination = !onPageChange
  const [localOffset, setLocalOffset] = useState(0)

  const resetLocalPaginationView = useCallback(() => {
    setLocalOffset(0)
    setSelectedRow(0)
    setViewportRowOffset(0)
  }, [])

  const effectivePageSize = FIXED_PAGE_SIZE
  const effectiveOffset = usesLocalPagination ? localOffset : currentOffset
  const rows = usesLocalPagination ? allRows.slice(localOffset, localOffset + effectivePageSize) : allRows
  const totalRows = usesLocalPagination ? allRows.length : totalCount

  useEffect(() => {
    if (!usesLocalPagination) return
    resetLocalPaginationView()
  }, [usesLocalPagination, allRows, resetLocalPaginationView])

  // Reset selection when data changes (e.g., page change)
  useEffect(() => {
    if (selectedRow >= rows.length && rows.length > 0) {
      setSelectedRow(rows.length - 1)
    }
  }, [rows.length])

  // Available width for the table (subtract sidebar, main panel border, internal padding)
  // sidebarWidth includes its own border; main panel has 2 chars for border (rounded)
  const availableWidth = Math.max(20, termWidth - sidebarWidth - detailWidth - 4)

  const columnWidths = useMemo(
    () => computeColumnWidths(columns, rows, availableWidth),
    [columns, rows, availableWidth]
  )

  // Calculate which columns are visible based on horizontal scroll
  // This is purely viewport-based - doesn't auto-adjust for selection
  const visibleColumns = useMemo(() => {
    const fixedOverhead = 2 + ROW_NUM_WIDTH + COL_SEPARATOR.length + (COL_PADDING.length * 2)
    let usedWidth = fixedOverhead
    const visible: number[] = []

    for (let i = viewportColOffset; i < columns.length; i++) {
      const colWidth = columnWidths[i]!
      const sepWidth = visible.length > 0 ? COL_SEPARATOR.length + (COL_PADDING.length * 2) : 0
      // Always include at least one column; include subsequent ones if ≥1 char fits
      if (availableWidth - usedWidth - sepWidth < 1 && visible.length > 0) break
      usedWidth += colWidth + sepWidth
      visible.push(i)
      // Stop after a partial column — no room for more
      if (usedWidth >= availableWidth) break
    }

    return visible
  }, [viewportColOffset, columns.length, columnWidths, availableWidth])

  // Maximum viewportColOffset that still shows the last column - prevents over-scrolling
  // past the end and eliminates the large trailing gap.
  const maxColOffset = useMemo(() => {
    if (columns.length === 0) return 0
    const fixedOverhead = 2 + ROW_NUM_WIDTH + COL_SEPARATOR.length + (COL_PADDING.length * 2)
    let w = fixedOverhead + columnWidths[columns.length - 1]!
    let startCol = columns.length - 1
    for (let i = columns.length - 2; i >= 0; i--) {
      const needed = columnWidths[i]! + COL_SEPARATOR.length + (COL_PADDING.length * 2)
      if (w + needed > availableWidth) break
      w += needed
      startCol = i
    }
    return startCol
  }, [columns.length, columnWidths, availableWidth])

  // Clamp viewportColOffset when maxColOffset shrinks (e.g. terminal resize or data change)
  useEffect(() => {
    setViewportColOffset((prev) => Math.min(prev, maxColOffset))
  }, [maxColOffset])

  // The last visible column may be clipped to the remaining space (partial column at right edge)
  const lastVisibleDisplayWidth = useMemo(() => {
    if (visibleColumns.length === 0) return 0
    const fixedOverhead = 2 + ROW_NUM_WIDTH + COL_SEPARATOR.length + (COL_PADDING.length * 2)
    let usedWidth = fixedOverhead
    for (let vi = 0; vi < visibleColumns.length - 1; vi++) {
      usedWidth += columnWidths[visibleColumns[vi]!]! + COL_SEPARATOR.length + (COL_PADDING.length * 2)
    }
    const remaining = availableWidth - usedWidth
    const lastColIdx = visibleColumns[visibleColumns.length - 1]!
    return Math.max(1, Math.min(columnWidths[lastColIdx]!, remaining))
  }, [visibleColumns, columnWidths, availableWidth])

  // Available height for data rows (subtract header, separator, footer, scrollbar)
  const headerHeight = 1
  const separatorHeight = 1
  const footerHeight = 1
  const hScrollbarHeight = 1
  const availableHeight = Math.max(1, termHeight - headerHeight - separatorHeight - footerHeight - hScrollbarHeight - 4)
  const visibleRowCount = availableHeight

  // Pagination
  const currentPage = Math.floor(effectiveOffset / effectivePageSize) + 1
  const totalPages = Math.max(1, Math.ceil(totalRows / effectivePageSize))
  const hasNextPage = effectiveOffset + effectivePageSize < totalRows
  const hasPrevPage = effectiveOffset > 0

  // Adjust viewport to keep selection visible (called when selection moves)
  const ensureSelectionVisible = useCallback(
    (newRow: number) => {
      setViewportRowOffset((prev) => {
        if (newRow < prev) return newRow
        if (newRow >= prev + visibleRowCount) return newRow - visibleRowCount + 1
        return prev
      })
    },
    [visibleRowCount]
  )

  // Ensure selected column is visible (called when selection moves via arrow keys)
  const ensureColVisible = useCallback(
    (newCol: number) => {
      // Check if newCol is outside current visible range
      const fixedOverhead = 2 + ROW_NUM_WIDTH + COL_SEPARATOR.length + (COL_PADDING.length * 2)

      setViewportColOffset((prev) => {
        // Calculate visible columns from current offset
        let usedWidth = fixedOverhead
        let firstVisible = prev
        let lastVisible = prev

        for (let i = prev; i < columns.length; i++) {
          const colWidth = columnWidths[i]!
          const sepWidth = i > prev ? COL_SEPARATOR.length + (COL_PADDING.length * 2) : 0
          if (usedWidth + colWidth + sepWidth > availableWidth && i > prev) break
          usedWidth += colWidth + sepWidth
          lastVisible = i
        }

        if (newCol < firstVisible) {
          return newCol
        } else if (newCol > lastVisible) {
          // Find offset that makes newCol visible as last column
          let w = fixedOverhead + columnWidths[newCol]!
          let startCol = newCol
          for (let i = newCol - 1; i >= 0; i--) {
            const needed = columnWidths[i]! + COL_SEPARATOR.length + (COL_PADDING.length * 2)
            if (w + needed > availableWidth) break
            w += needed
            startCol = i
          }
          return startCol
        }
        return prev
      })
    },
    [columns.length, columnWidths, availableWidth]
  )

  // Move selection (arrow keys) - viewport auto-adjusts
  const moveSelection = useCallback(
    (rowDelta: number, colDelta: number) => {
      if (rowDelta !== 0) {
        setSelectedRow((r) => {
          const newRow = Math.max(0, Math.min(rows.length - 1, r + rowDelta))
          ensureSelectionVisible(newRow)
          return newRow
        })
      }
      if (colDelta !== 0) {
        setSelectedCol((c) => {
          const newCol = Math.max(0, Math.min(columns.length - 1, c + colDelta))
          ensureColVisible(newCol)
          return newCol
        })
      }
    },
    [rows.length, columns.length, ensureSelectionVisible, ensureColVisible]
  )

  // Scroll viewport (mouse wheel) - selection stays in place
  const scrollViewport = useCallback(
    (rowDelta: number, colDelta: number) => {
      if (rowDelta !== 0) {
        setViewportRowOffset((prev) => {
          const maxOffset = Math.max(0, rows.length - visibleRowCount)
          return Math.max(0, Math.min(maxOffset, prev + rowDelta))
        })
      }
      if (colDelta !== 0) {
        setViewportColOffset((prev) => Math.max(0, Math.min(maxColOffset, prev + colDelta)))
      }
    },
    [rows.length, columns.length, visibleRowCount, maxColOffset]
  )

  const jumpToRow = useCallback(
    (row: number) => {
      const newRow = Math.max(0, Math.min(rows.length - 1, row))
      setSelectedRow(newRow)
      ensureSelectionVisible(newRow)
    },
    [rows.length, ensureSelectionVisible]
  )

  const emitSelectedCell = useCallback(() => {
    if (!onCellSelect) return
    const row = rows[selectedRow]
    const column = columns[selectedCol]
    if (!row || !column) return

    onCellSelect({
      rowIndex: selectedRow,
      colIndex: selectedCol,
      columnName: column.name,
      value: row[column.name],
      row,
    })
  }, [onCellSelect, rows, columns, selectedRow, selectedCol])

  useKeyboard((key) => {
    if (!focused) return

    // Arrow keys - move selection
    if (key.name === "down" || key.name === "j") {
      moveSelection(1, 0)
      return
    }
    if (key.name === "up" || key.name === "k") {
      moveSelection(-1, 0)
      return
    }
    if (key.name === "right" || key.name === "l") {
      moveSelection(0, 1)
      return
    }
    if (key.name === "left" || key.name === "h") {
      moveSelection(0, -1)
      return
    }

    // Page navigation (within current page data)
    if (key.name === "pagedown") {
      moveSelection(visibleRowCount, 0)
      return
    }
    if (key.name === "pageup") {
      moveSelection(-visibleRowCount, 0)
      return
    }

    // Jump to start/end of current data
    if (key.name === "home" || (key.name === "g" && !key.shift)) {
      jumpToRow(0)
      return
    }
    if (key.name === "end" || (key.name === "g" && key.shift)) {
      jumpToRow(rows.length - 1)
      return
    }

    // Database pagination: n = next page, p = prev page
    if (key.name === "n" && hasNextPage) {
      if (onPageChange) {
        onPageChange(effectiveOffset + effectivePageSize)
      } else {
        setLocalOffset((prev) => prev + effectivePageSize)
      }
      setSelectedRow(0)
      setViewportRowOffset(0)
      return
    }
    if (key.name === "p" && hasPrevPage) {
      if (onPageChange) {
        onPageChange(Math.max(0, effectiveOffset - effectivePageSize))
      } else {
        setLocalOffset((prev) => Math.max(0, prev - effectivePageSize))
      }
      setSelectedRow(0)
      setViewportRowOffset(0)
      return
    }

    // Select cell
    if (key.name === "return") {
      emitSelectedCell()
      return
    }

    if (key.name === "v") {
      emitSelectedCell()
      return
    }

    // Sort by current column: 's' key
    if (key.name === "s" && onColumnSort && columns[selectedCol]) {
      const col = columns[selectedCol]
      const currentDir = currentSort?.[col.name]
      // Toggle: none -> ASC (1) -> DESC (-1) -> none
      const newDir = currentDir === 1 ? -1 : currentDir === -1 ? undefined : 1
      if (newDir !== undefined) {
        onColumnSort(col.name, newDir)
      } else {
        // Clear sort for this column
        onColumnSort(col.name, 1) // Will be handled by parent to remove
      }
      return
    }
  })

  // Mouse scroll handler - scrolls viewport, not selection
  const handleMouseScroll = useCallback(
    (event: TuiMouseEvent) => {
      if (!focused || !event.scroll) return
      const { direction, delta } = event.scroll

      if (direction === "up" || direction === "down") {
        // Shift+scroll = horizontal scrolling (by columns)
        if (event.modifiers.shift) {
          const colDelta = direction === "down" ? 1 : -1
          scrollViewport(0, colDelta * Math.max(1, delta))
        } else {
          // Vertical scrolling: scroll viewport
          const rowDelta = direction === "down" ? 1 : -1
          scrollViewport(rowDelta * Math.max(1, delta), 0)
        }
      } else if (direction === "left" || direction === "right") {
        const colDelta = direction === "right" ? 1 : -1
        scrollViewport(0, colDelta * Math.max(1, delta))
      }
    },
    [focused, scrollViewport]
  )

  // Build row number column width
  const rowNumStr = (idx: number) => {
    const num = String(effectiveOffset + idx + 1)
    return num.length < ROW_NUM_WIDTH ? " ".repeat(ROW_NUM_WIDTH - num.length) + num : num
  }

  // Render header row
  const headerParts: any[] = [
    <span key="__rownum" fg={COLORS.dim}>
      {padCell("#", ROW_NUM_WIDTH)}
      {COL_PADDING}
      <span fg={COLORS.separator}>{COL_SEPARATOR}</span>
    </span>,
  ]
  for (let vi = 0; vi < visibleColumns.length; vi++) {
    const colIdx = visibleColumns[vi]!
    const col = columns[colIdx]!
    const w = vi === visibleColumns.length - 1 ? lastVisibleDisplayWidth : columnWidths[colIdx]!
    
    // Check if this column is sorted
    const sortDir = currentSort?.[col.name]
    const sortIndicator = sortDir === 1 ? " ▴" : sortDir === -1 ? " ▾" : ""
    const displayText = col.name + sortIndicator
    const text = padCell(formatCellValue(displayText, w), w)
    
    headerParts.push(
      <span key={col.name}>
        <span fg={COLORS.header}>
          {COL_PADDING}
          {text}
          {COL_PADDING}
        </span>
        {vi < visibleColumns.length - 1 ? <span fg={COLORS.separator}>{COL_SEPARATOR}</span> : ""}
      </span>
    )
  }

  // Render separator
  const sepParts = [
    "─".repeat(ROW_NUM_WIDTH) + "─┼─",
    ...visibleColumns.map((colIdx, vi) => {
      const w = vi === visibleColumns.length - 1 ? lastVisibleDisplayWidth : columnWidths[colIdx]!
      return "─".repeat(w) + (vi < visibleColumns.length - 1 ? "─┼─" : "")
    }),
  ]
  const separatorLine = sepParts.join("")

  // Render data rows
  const dataRows: any[] = []
  for (let viewIdx = 0; viewIdx < visibleRowCount; viewIdx++) {
    const actualRowIdx = viewportRowOffset + viewIdx
    if (actualRowIdx >= rows.length) break

    const row = rows[actualRowIdx]!
    const isSelectedRow = actualRowIdx === selectedRow

    const cellParts: any[] = [
      <span key="__rownum">
        <span fg={COLORS.rowNum}>{rowNumStr(actualRowIdx)}</span>
        {COL_PADDING}
        <span fg={COLORS.separator}>{COL_SEPARATOR}</span>
      </span>,
    ]

    for (let vi = 0; vi < visibleColumns.length; vi++) {
      const colIdx = visibleColumns[vi]!
      const col = columns[colIdx]!
      const w = vi === visibleColumns.length - 1 ? lastVisibleDisplayWidth : columnWidths[colIdx]!
      const value = row[col.name]
      const formatted = formatCellValue(value, w)
      const padded = padCell(formatted, w)
      const valueType = getValueType(value)
      const color = COLORS[valueType]
      const isSelectedCell = isSelectedRow && colIdx === selectedCol

      const cellBg = isSelectedCell ? COLORS.selectedCell : undefined
      
      // Background covers: padding + content + padding (between separators)
      // Separator is rendered outside the background
      cellParts.push(
        <span key={col.name}>
          <span bg={cellBg}>
            {COL_PADDING}
            <span fg={color}>{padded}</span>
            {COL_PADDING}
          </span>
          {vi < visibleColumns.length - 1 ? <span fg={COLORS.separator}>{COL_SEPARATOR}</span> : ""}
        </span>
      )
    }

    dataRows.push(
      <box key={actualRowIdx} height={1} flexDirection="row" backgroundColor={isSelectedRow ? COLORS.selectedRow : undefined}>
        <text>{cellParts}</text>
      </box>
    )
  }

  // Horizontal scroll indicator
  const hasColsLeft = viewportColOffset > 0
  const hasColsRight = viewportColOffset < maxColOffset
  const showHorizontalScrollbar = maxColOffset > 0

  // Horizontal scrollbar calculation
  const hScrollbarWidth = availableWidth - 2 // Account for padding
  const maxColScroll = maxColOffset
  // Thumb size proportional to visible columns
  const hThumbRatio = Math.min(0.5, Math.max(0.1, visibleColumns.length / columns.length))
  const hThumbSize = Math.max(3, Math.round(hThumbRatio * hScrollbarWidth))
  const hThumbPosition = maxColScroll > 0 ? Math.round((viewportColOffset / maxColScroll) * (hScrollbarWidth - hThumbSize)) : 0

  // Pagination bar
  const pageInfo = `Page ${currentPage}/${totalPages}`
  const rowRange = rows.length > 0 ? `Rows ${effectiveOffset + 1}–${effectiveOffset + rows.length} of ${totalRows}` : "No rows"
  const colInfo = `Col ${selectedCol + 1}/${columns.length}`
  const navHint = [hasPrevPage ? "[p]prev" : "", hasNextPage ? "[n]next" : ""].filter(Boolean).join("  ")

  return (
    <box flexDirection="column" flexGrow={1} onMouseScroll={handleMouseScroll}>
      {/* Header */}
      <box height={1} backgroundColor={COLORS.headerBg} paddingX={1}>
        <text>{headerParts}</text>
      </box>

      {/* Separator */}
      <box height={1} paddingX={1}>
        <text fg={COLORS.separator}>{separatorLine}</text>
      </box>

      {/* Data rows */}
      <box flexDirection="column" flexGrow={1} paddingX={1}>
        {dataRows.length > 0 ? (
          dataRows
        ) : (
          <box justifyContent="center" alignItems="center" flexGrow={1}>
            <text fg={COLORS.dim}>No data</text>
          </box>
        )}
      </box>

      {/* Horizontal scroll indicator */}
      {showHorizontalScrollbar && (
        <box height={1} paddingX={1}>
          <text>
            <span fg={COLORS.scrollTrack}>{"▁".repeat(hThumbPosition)}</span>
            <span fg={COLORS.scrollThumb}>{"▂".repeat(hThumbSize)}</span>
            <span fg={COLORS.scrollTrack}>{"▁".repeat(Math.max(0, hScrollbarWidth - hThumbPosition - hThumbSize))}</span>
          </text>
        </box>
      )}

      {/* Footer / Pagination */}
      <box height={1} paddingX={1} flexDirection="row" backgroundColor={COLORS.footerBg}>
        <text fg={COLORS.dim}>
          {rowRange}
          {"  "}
          <span fg={COLORS.pageActive}>{pageInfo}</span>
          {"  "}
          {colInfo}
          {hasColsLeft || hasColsRight ? "  " : ""}
          {hasColsLeft && <span fg={COLORS.pageActive}>◀</span>}
          {hasColsRight && <span fg={COLORS.pageActive}>▶</span>}
          {navHint ? (
            <>
              {"  "}
              <span fg={COLORS.hintKey}>[{hasPrevPage ? "p" : ""}{hasPrevPage && hasNextPage ? "/" : ""}{hasNextPage ? "n" : ""}]</span>
              <span fg={COLORS.pageInactive}> {hasPrevPage && hasNextPage ? "prev/next" : hasPrevPage ? "prev" : "next"}</span>
            </>
          ) : null}
          {filterBarActive ? (
            <>
              {"  "}
              <span fg={COLORS.hintKey}>[Enter]</span>
              <span fg={COLORS.pageInactive}> Run </span>
              <span fg={COLORS.hintKey}>[Esc]</span>
              <span fg={COLORS.pageInactive}> Close </span>
              <span fg={COLORS.hintKey}>[⌃L]</span>
              <span fg={COLORS.pageInactive}> Clear</span>
            </>
          ) : (
            <>
              {"  "}
              <span fg={COLORS.hintKey}>[/]</span>
              <span fg={COLORS.pageInactive}> Filter </span>
              <span fg={COLORS.hintKey}>[s]</span>
              <span fg={COLORS.pageInactive}> Sort</span>
            </>
          )}
          {showHorizontalScrollbar && (
            <>
              {"  "}
              <span fg={COLORS.hintKey}>[⇧+scroll]</span>
              <span fg={COLORS.pageInactive}> h-scroll</span>
            </>
          )}
        </text>
      </box>
    </box>
  )
}
