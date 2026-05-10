import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useKeyboard } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useApp } from "../../state/AppContext.tsx"
import { flattenTreeNodes, TreeRow, type FlatNode } from "../sidebar/TreeBrowser.tsx"
import { nodeId } from "../../state/tree.ts"
import {
  createDbIconPalette,
  DB_TYPE_ICONS,
  getIconColor,
  STATUS_INDICATORS,
  type DbIconPalette,
} from "../../constants/dbIcons.ts"
import type { ThemeColors } from "../../theme/themes.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"

interface SidebarProps {
  width: number
  height: number
  focused: boolean
  showConnectionForm: boolean
  showDatabasePicker: boolean
  showSearchDialog: boolean
  searchDialogDb: { connectionId: string; connectionName: string; database: string } | null
  onShowConnectionForm: () => void
  onShowDatabasePicker: (connectionId: string) => void
  onShowSearchDialog: (connectionId: string, connectionName: string, database: string) => void
  onFocusMain?: () => void
}

interface SidebarRowsProps {
  width: number
  focused: boolean
  selectedIndex: number
  rows: RowItem[]
  connections: ReturnType<typeof useApp>["state"]["connections"]
  allDatabases: ReturnType<typeof useApp>["state"]["allDatabases"]
  colors: ThemeColors
  iconPalette: DbIconPalette
}

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name
  if (maxLen <= 1) return "…"
  return name.slice(0, maxLen - 1) + "…"
}

type RowItem =
  | { kind: "connection"; index: number; connectionId: string }
  | { kind: "tree"; node: FlatNode }

function EmptyConnectionsState({ colors }: { colors: ThemeColors }): ReactNode {
  return (
    <box flexGrow={1} flexDirection="column" padding={1} gap={0}>
      <text fg={colors.muted}>No connections yet</text>
      <text fg={colors.muted}>
        Press <span fg={colors.accent}>a</span> to add one
      </text>
    </box>
  )
}

function SidebarFooter({ hasConnections, colors }: { hasConnections: boolean; colors: ThemeColors }): ReactNode {
  return (
    <box paddingX={1} flexDirection="column" flexShrink={0}>
      <text fg={colors.info}>
        <span fg={colors.accent}>[a]</span> Add
        {hasConnections && (
          <>
            {"  "}
            <span fg={colors.accent}>[e]</span> Edit
            {"  "}
            <span fg={colors.accent}>[s]</span> Search
          </>
        )}
      </text>
      {hasConnections && (
        <text fg={colors.info}>
          <span fg={colors.accent}>[Enter]</span> Open{"  "}
          <span fg={colors.accent}>[x]</span> Del
        </text>
      )}
    </box>
  )
}

function SidebarRows({
  width,
  focused,
  selectedIndex,
  rows,
  connections,
  allDatabases,
  colors,
  iconPalette,
}: SidebarRowsProps): ReactNode {
  return (
    <>
      {rows.map((row, rowIndex) => {
        const isSelected = rowIndex === selectedIndex && focused
        const bg = isSelected ? colors.surfaceAlt : "transparent"
        const fg = isSelected ? colors.textBright : colors.text

        if (row.kind === "connection") {
          const conn = connections[row.index]!
          const typeIcon = DB_TYPE_ICONS[conn.config.type]
          const iconColor = getIconColor(conn.config.type, conn.status, iconPalette)
          const allDbs = allDatabases.get(conn.config.id)
          const dbCount = allDbs ? allDbs.length : 0
          const dbCountLabel = dbCount > 0 ? ` (${dbCount})` : ""
          const statusIndicator = conn.status !== "connected" ? ` ${STATUS_INDICATORS[conn.status]}` : ""
          const maxNameLen = Math.max(3, width - 2 - 1 - 1 - dbCountLabel.length - statusIndicator.length - 2)
          const displayName = truncateName(conn.config.name, maxNameLen)

          return (
            <box key={conn.config.id} flexDirection="row" gap={1} paddingX={1} backgroundColor={bg} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text fg={iconColor}>{typeIcon}</text>
                <text fg={fg}>
                  {displayName}
                  {statusIndicator && <span fg={iconColor}>{statusIndicator}</span>}
                </text>
              </box>
              {dbCount > 0 && <text fg={colors.muted}>{dbCountLabel}</text>}
            </box>
          )
        }

        return (
          <TreeRow
            key={row.node.id}
            node={row.node}
            isSelected={isSelected}
            maxWidth={width - 4}
            colors={colors}
          />
        )
      })}
    </>
  )
}

export function Sidebar({
  width,
  height,
  focused,
  showConnectionForm,
  showDatabasePicker,
  showSearchDialog,
  searchDialogDb: _searchDialogDb,
  onShowConnectionForm,
  onShowDatabasePicker,
  onShowSearchDialog,
  onFocusMain,
}: SidebarProps) {
  const { state, connectTo, disconnectFrom, removeConnection, toggleExpand, openCollection } = useApp()
  const { colors } = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const borderColor = focused ? colors.accent : colors.muted
  const iconPalette = useMemo(() => createDbIconPalette(colors), [colors])

  const treeState = {
    treeExpanded: state.treeExpanded,
    treeLoading: state.treeLoading,
    treeChildren: state.treeChildren,
    treeVisibleCount: state.treeVisibleCount,
    treeNextCursor: state.treeNextCursor,
  }

  const rows = useMemo<RowItem[]>(() => {
    const items: RowItem[] = []

    state.connections.forEach((conn, index) => {
      items.push({ kind: "connection", index, connectionId: conn.config.id })
      if (conn.status !== "connected") return

      const treeNodes = flattenTreeNodes(conn, treeState)
      for (const node of treeNodes) items.push({ kind: "tree", node })
    })

    return items
  }, [state.connections, state.treeExpanded, state.treeLoading, state.treeChildren, state.treeVisibleCount, state.treeNextCursor])

  useEffect(() => {
    for (const conn of state.connections) {
      if (conn.status !== "connected") continue

      const connNid = nodeId(conn.config.id)
      if (!state.treeExpanded.has(connNid) && !state.treeChildren.has(connNid)) {
        toggleExpand(connNid, conn.config.id)
      }
    }
  }, [state.connections, state.treeExpanded, state.treeChildren, toggleExpand])

  const footerRows = state.connections.length > 0 ? 2 : 1
  const listViewportHeight = Math.max(1, height - 2 - footerRows)

  useEffect(() => {
    if (rows.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0)
      return
    }

    if (rows.length > 0 && selectedIndex >= rows.length) {
      setSelectedIndex(rows.length - 1)
    }
  }, [rows.length, selectedIndex])

  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox || rows.length === 0) return

    const scrollTop = scrollbox.scrollTop
    const viewportHeight = scrollbox.viewport.height

    if (selectedIndex < scrollTop) {
      scrollbox.scrollTo({ x: 0, y: selectedIndex })
    } else if (selectedIndex >= scrollTop + viewportHeight) {
      scrollbox.scrollTo({ x: 0, y: selectedIndex - viewportHeight + 1 })
    }
  }, [selectedIndex, rows.length, listViewportHeight])

  useKeyboard((key) => {
    if (!focused || showConnectionForm || showDatabasePicker || showSearchDialog) return

    if (key.name === "a") {
      onShowConnectionForm()
      return
    }

    if (rows.length === 0) return

    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((index) => Math.min(rows.length - 1, index + 1))
      return
    }

    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((index) => Math.max(0, index - 1))
      return
    }

    if (key.name === "pagedown") {
      setSelectedIndex((index) => Math.min(rows.length - 1, index + listViewportHeight))
      return
    }

    if (key.name === "pageup") {
      setSelectedIndex((index) => Math.max(0, index - listViewportHeight))
      return
    }

    if (key.name === "home" || (key.name === "g" && !key.ctrl)) {
      setSelectedIndex(0)
      return
    }

    if (key.name === "end" || key.name === "G") {
      setSelectedIndex(rows.length - 1)
      return
    }

    const row = rows[selectedIndex]
    if (!row) return

    if (key.name === "e") {
      let connectionId: string | null = null

      if (row.kind === "connection") {
        const conn = state.connections[row.index]
        if (conn) connectionId = conn.config.id
      } else {
        connectionId = row.node.connectionId
      }

      if (connectionId) {
        onShowDatabasePicker(connectionId)
      }
      return
    }

    if (key.name === "s") {
      if (row.kind === "tree" && row.node.database) {
        const conn = state.connections.find((connection) => connection.config.id === row.node.connectionId)
        if (conn) onShowSearchDialog(row.node.connectionId, conn.config.name, row.node.database)
      }
      return
    }

    if (key.name === "return") {
      if (row.kind === "connection") {
        const conn = state.connections[row.index]
        if (!conn) return

        if (conn.status === "disconnected" || conn.status === "error") {
          connectTo(conn.config.id)
        } else if (conn.status === "connected") {
          toggleExpand(nodeId(conn.config.id), conn.config.id)
        }
      } else {
        const { node } = row

        if (node.type === "database" && !node.isLoading) {
          toggleExpand(node.id, node.connectionId, node.database)
        } else if (node.type === "collection" && node.collection && node.database) {
          openCollection(node.connectionId, node.database, node.collection)
          onFocusMain?.()
        }
      }
      return
    }

    if (key.name === "d") {
      if (row.kind === "connection") {
        const conn = state.connections[row.index]
        if (conn && (conn.status === "connected" || conn.status === "connecting")) {
          disconnectFrom(conn.config.id)
        }
      }
      return
    }

    if (key.name === "x") {
      if (row.kind === "connection") {
        const conn = state.connections[row.index]
        if (conn) {
          removeConnection(conn.config.id)
          setSelectedIndex((index) => Math.max(0, index - 1))
        }
      }
      return
    }

    if (key.name === "left" || key.name === "h") {
      if (row.kind === "tree" && row.node.type === "database" && state.treeExpanded.has(row.node.id)) {
        toggleExpand(row.node.id, row.node.connectionId, row.node.database)
      }
      return
    }

    if (key.name === "right" || key.name === "l") {
      if (row.kind === "tree" && row.node.type === "database" && !state.treeExpanded.has(row.node.id) && !row.node.isLoading) {
        toggleExpand(row.node.id, row.node.connectionId, row.node.database)
      } else if (row.kind === "connection") {
        const conn = state.connections[row.index]
        if (conn && conn.status === "connected") {
          const connNid = nodeId(conn.config.id)
          if (!state.treeExpanded.has(connNid)) toggleExpand(connNid, conn.config.id)
        }
      }
    }
  })

  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderColor}
      title=" Connections "
      titleAlignment="left"
    >
      {rows.length === 0 ? (
        <EmptyConnectionsState colors={colors} />
      ) : (
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          scrollY
          scrollX={false}
          verticalScrollbarOptions={{
            showArrows: false,
            trackOptions: {
              backgroundColor: colors.background,
              foregroundColor: colors.border,
            },
          }}
        >
          <SidebarRows
            width={width}
            focused={focused}
            selectedIndex={selectedIndex}
            rows={rows}
            connections={state.connections}
            allDatabases={state.allDatabases}
            colors={colors}
            iconPalette={iconPalette}
          />
        </scrollbox>
      )}

      <SidebarFooter hasConnections={state.connections.length > 0} colors={colors} />
    </box>
  )
}
