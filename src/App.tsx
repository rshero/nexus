import { useState, useEffect, useCallback, useMemo } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { Selection } from "@opentui/core"
import { Sidebar } from "./components/layout/Sidebar.tsx"
import { MainPanel } from "./components/layout/MainPanel.tsx"
import { DetailPanel } from "./components/layout/DetailPanel.tsx"
import type { SelectedCell } from "./components/main/DataTable.tsx"
import { Console } from "./components/layout/QueryLog.tsx"
import { StatusBar } from "./components/layout/StatusBar.tsx"
import { ConnectionForm } from "./components/sidebar/ConnectionForm.tsx"
import { DatabasePicker } from "./components/sidebar/DatabasePicker.tsx"
import { useApp } from "./state/AppContext.tsx"
import { Toast } from "./components/layout/Toast.tsx"
import { CommandPalette, type CommandItem } from "./components/layout/CommandPalette.tsx"
import { QueryDatabasePicker, type QueryDatabaseOption } from "./components/layout/QueryDatabasePicker.tsx"
import { ThemePicker } from "./components/layout/ThemePicker.tsx"
import { emitPaste } from "./state/paste.ts"
import type { DbType } from "./db/types.ts"
import { useTheme } from "./theme/ThemeContext.tsx"

export type FocusZone = "sidebar" | "main" | "detail" | "querylog"

const ZONES: FocusZone[] = ["sidebar", "main", "detail", "querylog"]

interface DetailState {
  tabId: string
  tabLabel: string
  dbType: DbType
  cell: SelectedCell
}

export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const { state, addConnection, updateTabCell, openQueryConsole } = useApp()
  const { themeName, committedThemeName, theme, colors, previewTheme, commitTheme, cancelPreview } = useTheme()
  const [focusZone, setFocusZone] = useState<FocusZone>("sidebar")
  const [showQueryLog, setShowQueryLog] = useState(true)
  const [detailState, setDetailState] = useState<DetailState | null>(null)
  const [showConnectionForm, setShowConnectionForm] = useState(false)
  const [databasePickerConnectionId, setDatabasePickerConnectionId] = useState<string | null>(null)
  const [searchDialogDb, setSearchDialogDb] = useState<{ connectionId: string; connectionName: string; database: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [recentCommands, setRecentCommands] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showQueryDatabasePicker, setShowQueryDatabasePicker] = useState(false)
  const [showThemePicker, setShowThemePicker] = useState(false)
  const [isQueryInputFocused, setIsQueryInputFocused] = useState(false)

  const queryDatabaseOptions = useMemo<QueryDatabaseOption[]>(() => {
    const options: QueryDatabaseOption[] = []

    for (const conn of state.connections) {
      if (conn.status !== "connected") continue

      const allDatabases = state.allDatabases.get(conn.config.id) ?? []
      const visibleDatabases = state.visibleDatabases.get(conn.config.id) ?? []
      const fallback = conn.config.type === "redis" ? ["0"] : conn.config.database ? [conn.config.database] : []
      const databases = (visibleDatabases.length > 0 ? visibleDatabases : allDatabases.length > 0 ? allDatabases : fallback).filter(Boolean)

      for (const database of databases) {
        options.push({
          key: `${conn.config.id}/${database}`,
          connectionId: conn.config.id,
          connectionName: conn.config.name,
          database,
        })
      }
    }

    return options
  }, [state.connections, state.allDatabases, state.visibleDatabases])

  const isNarrow = width < 100
  const showDetail = detailState !== null

  const showToast = useCallback((message: string) => {
    setToast(message)
  }, [])

  const runCommand = useCallback((id: string, run: () => void) => {
    run()
    setRecentCommands((prev) => [id, ...prev.filter((cmdId) => cmdId !== id)].slice(0, 8))
  }, [])

  const commandItems = useMemo<CommandItem[]>(() => {
    const base: CommandItem[] = [
      {
        id: "query-database",
        title: "Query Database",
        shortcut: "Ctrl+K",
        run: () =>
          runCommand("query-database", () => {
            const hasConnectedConnection = state.connections.some((conn) => conn.status === "connected")
            if (!hasConnectedConnection) {
              showToast("Connect to a database first")
              return
            }

            setShowQueryDatabasePicker(true)
          }),
      },
      {
        id: "new-connection",
        title: "Add new connection",
        shortcut: "a",
        run: () => runCommand("new-connection", () => setShowConnectionForm(true)),
      },
      {
        id: "toggle-console",
        title: showQueryLog ? "Hide console" : "Show console",
        shortcut: "`",
        run: () => runCommand("toggle-console", () => setShowQueryLog((v) => !v)),
      },
      {
        id: "focus-sidebar",
        title: "Focus sidebar",
        shortcut: "1",
        run: () => runCommand("focus-sidebar", () => setFocusZone("sidebar")),
      },
      {
        id: "focus-main",
        title: "Focus main panel",
        shortcut: "2",
        run: () => runCommand("focus-main", () => setFocusZone("main")),
      },
      {
        id: "toggle-sidebar",
        title: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
        shortcut: "Ctrl+B",
        run: () => runCommand("toggle-sidebar", () => setSidebarCollapsed((prev) => !prev)),
      },
      {
        id: "focus-detail",
        title: "Focus detail panel",
        shortcut: "3",
        run: () => {
          if (showDetail) runCommand("focus-detail", () => setFocusZone("detail"))
        },
      },
      {
        id: "focus-console",
        title: "Focus console",
        shortcut: "4",
        run: () => {
          if (showQueryLog) runCommand("focus-console", () => setFocusZone("querylog"))
        },
      },
      {
        id: "close-detail",
        title: "Close detail panel",
        shortcut: "Esc",
        run: () => {
          if (detailState) {
            runCommand("close-detail", () => {
              setDetailState(null)
              setFocusZone("main")
            })
          }
        },
      },
      {
        id: "theme-picker",
        title: `Theme (${theme.label})`,
        shortcut: "Ctrl+T",
        run: () =>
          runCommand("theme-picker", () => {
            setShowThemePicker(true)
          }),
      },
      {
        id: "quit",
        title: "Quit application",
        shortcut: "Ctrl+Q",
        run: () => runCommand("quit", () => renderer.destroy()),
      },
    ]

    const rank = new Map(recentCommands.map((id, idx) => [id, idx]))
    return base.toSorted((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : 999
      const rb = rank.has(b.id) ? rank.get(b.id)! : 999
      return ra - rb
    })
  }, [
    runCommand,
    showQueryLog,
    showDetail,
    detailState,
    renderer,
    recentCommands,
    sidebarCollapsed,
    state.connections,
    showToast,
    theme.label,
  ])

  // Auto-copy selected text to clipboard when mouse selection finishes
  useEffect(() => {
    const handleSelection = (selection: Selection) => {
      const text = selection.getSelectedText()
      if (text) {
        renderer.copyToClipboardOSC52(text)
        // Clear selection so user sees visual feedback
        setTimeout(() => renderer.clearSelection(), 50)
        showToast("Copied to clipboard")
      }
    }

    const handlePaste = (event: { text: string }) => {
      emitPaste(event.text)
    }

    renderer.on("selection", handleSelection)
    renderer.keyInput.on("paste", handlePaste)
    return () => {
      renderer.off("selection", handleSelection)
      renderer.keyInput.off("paste", handlePaste)
    }
  }, [renderer, showToast])

  useKeyboard((key) => {
    const isRepeat = key.eventType === "repeat" || key.repeated
    const hasBlockingModal =
      showConnectionForm || !!databasePickerConnectionId || !!searchDialogDb || showCommandPalette || showQueryDatabasePicker || showThemePicker

    if (key.ctrl && key.name === "q") {
      if (isRepeat) return
      renderer.destroy()
      return
    }

    if (key.ctrl && key.name === "p") {
      if (isRepeat || hasBlockingModal) return
      setShowCommandPalette(true)
      return
    }

    if (key.ctrl && key.name === "b") {
      if (isRepeat || hasBlockingModal) return
      setSidebarCollapsed((prev) => !prev)
      return
    }

    if (key.ctrl && key.name === "t") {
      if (isRepeat || hasBlockingModal) return
      setShowThemePicker(true)
      return
    }

    if (showCommandPalette) return

    // Block all other keys when modal is open
    if (hasBlockingModal) return

    const shouldBlockMainPanelShortcuts = focusZone === "main" && isQueryInputFocused
    if (shouldBlockMainPanelShortcuts) return

    if (key.name === "`") {
      setShowQueryLog((v) => !v)
      return
    }

    if (key.name === "tab" && !key.ctrl) {
      setFocusZone((z) => {
        const available = ZONES.filter((zone) => {
          if (zone === "detail" && !showDetail) return false
          if (zone === "querylog" && !showQueryLog) return false
          return true
        })
        const idx = available.indexOf(z)
        const next = key.shift ? (idx - 1 + available.length) % available.length : (idx + 1) % available.length
        return available[next]!
      })
      return
    }

    if (key.name === "1") setFocusZone("sidebar")
    if (key.name === "2") setFocusZone("main")
    if (key.name === "3" && showDetail) setFocusZone("detail")
    if (key.name === "4" && showQueryLog) setFocusZone("querylog")
  })

  const sidebarWidth = sidebarCollapsed ? 0 : isNarrow ? 24 : 30
  const detailBaseWidth = isNarrow ? 22 : 31
  const detailWidth = showDetail ? Math.ceil(detailBaseWidth * 1.1) : 0
  const queryLogHeight = showQueryLog ? 8 : 0
  const statusBarHeight = 1
  const bottomMarginHeight = 1
  const hasModalOpen =
    showConnectionForm || !!databasePickerConnectionId || !!searchDialogDb || showCommandPalette || showQueryDatabasePicker || showThemePicker
  const topAreaHeight = Math.max(6, height - queryLogHeight - statusBarHeight - bottomMarginHeight)

  // Center the connection form modal
  const formWidth = 52
  const formHeight = 16
  const formLeft = Math.max(0, Math.floor((width - formWidth) / 2))
  const formTop = Math.max(0, Math.floor((height - formHeight) / 2))

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.background}>
      {/* Top area: sidebar + main + detail */}
      <box flexDirection="row" height={topAreaHeight}>
        {!sidebarCollapsed && (
          <Sidebar
            width={sidebarWidth}
            height={topAreaHeight}
            focused={focusZone === "sidebar" && !hasModalOpen}
            showConnectionForm={showConnectionForm}
            showDatabasePicker={!!databasePickerConnectionId}
            showSearchDialog={!!searchDialogDb}
            searchDialogDb={searchDialogDb}
            onShowConnectionForm={() => setShowConnectionForm(true)}
            onShowDatabasePicker={(connectionId) => setDatabasePickerConnectionId(connectionId)}
            onShowSearchDialog={(connectionId, connectionName, database) =>
              setSearchDialogDb({ connectionId, connectionName, database })
            }
            onFocusMain={() => setFocusZone("main")}
          />
        )}

        <MainPanel
          focused={focusZone === "main" && !hasModalOpen}
          sidebarWidth={sidebarWidth}
          detailWidth={detailWidth}
          onShowToast={showToast}
          onQueryInputFocusChange={setIsQueryInputFocused}
          onOpenDetail={(tabId, cell) => {
            const tab = state.tabs.find((t) => t.id === tabId)
            const conn = tab ? state.connections.find((c) => c.config.id === tab.connectionId) : undefined
            if (!tab || !conn) return
            setDetailState({ tabId, tabLabel: `${tab.database}.${tab.collection}`, dbType: conn.config.type, cell })
            setFocusZone("detail")
          }}
        />

        {showDetail && detailState && (
          <DetailPanel
            width={detailWidth}
            height={topAreaHeight}
            focused={focusZone === "detail" && !hasModalOpen}
            dbType={detailState.dbType}
            tabLabel={detailState.tabLabel}
            fieldName={detailState.cell.columnName}
            rowData={detailState.cell.row}
            originalValue={detailState.cell.value}
            onClose={() => {
              setDetailState(null)
              setFocusZone("main")
            }}
            onApply={async (value) => {
              await updateTabCell(detailState.tabId, detailState.cell.row, detailState.cell.columnName, value)
              setDetailState((prev) => (prev ? { ...prev, cell: { ...prev.cell, value } } : prev))
            }}
          />
        )}
      </box>

      {/* Console */}
      {showQueryLog && <Console height={queryLogHeight} focused={focusZone === "querylog" && !hasModalOpen} />}

      {/* Status bar */}
      <StatusBar focusZone={focusZone} showQueryLog={showQueryLog} showDetail={showDetail} width={width} />

      {/* Bottom margin */}
      <box height={1} />

      {/* Toast notification */}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      {/* Modal overlay + connection form */}
      {showConnectionForm && (
        <>
          {/* Full-screen dim overlay */}
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            backgroundColor={colors.overlay}
            opacity={0.6}
            zIndex={50}
          />
          {/* Centered connection form */}
          <ConnectionForm
            left={formLeft}
            top={formTop}
            onSubmit={(config) => {
              addConnection(config)
              setShowConnectionForm(false)
            }}
            onCancel={() => setShowConnectionForm(false)}
          />
        </>
      )}

      {/* Modal overlay + database picker */}
      {databasePickerConnectionId && (() => {
        const conn = state.connections.find((c) => c.config.id === databasePickerConnectionId)
        if (!conn) return null
        const pickerWidth = 44
        const pickerLeft = Math.max(0, Math.floor((width - pickerWidth) / 2))
        const pickerTop = Math.max(0, Math.floor((height - 22) / 2))
        return (
          <>
            <box
              position="absolute"
              left={0}
              top={0}
              width="100%"
              height="100%"
              backgroundColor={colors.overlay}
              opacity={0.6}
              zIndex={50}
            />
            <DatabasePicker
              connectionId={databasePickerConnectionId}
              connectionName={conn.config.name}
              left={pickerLeft}
              top={pickerTop}
              onClose={() => setDatabasePickerConnectionId(null)}
            />
          </>
        )
      })()}

      {/* Modal overlay + search/filter dialog for collections */}
      {searchDialogDb && (() => {
        const dialogWidth = 50
        const dialogHeight = 22
        const dialogLeft = Math.max(0, Math.floor((width - dialogWidth) / 2))
        const dialogTop = Math.max(0, Math.floor((height - dialogHeight) / 2))
        return (
          <>
            <box
              position="absolute"
              left={0}
              top={0}
              width="100%"
              height="100%"
              backgroundColor={colors.overlay}
              opacity={0.6}
              zIndex={50}
            />
            <DatabasePicker
              connectionId={searchDialogDb.connectionId}
              connectionName={searchDialogDb.connectionName}
              database={searchDialogDb.database}
              mode="search"
              left={dialogLeft}
              top={dialogTop}
              onClose={() => {
                setSearchDialogDb(null)
                setFocusZone("main")
              }}
            />
          </>
        )
      })()}

      <CommandPalette
        visible={showCommandPalette}
        width={width}
        height={height}
        commands={commandItems}
        onClose={() => setShowCommandPalette(false)}
      />

      <QueryDatabasePicker
        visible={showQueryDatabasePicker}
        width={width}
        height={height}
        options={queryDatabaseOptions}
        onSelect={(option) => {
          openQueryConsole(option.connectionId, option.database)
          setShowQueryDatabasePicker(false)
          setFocusZone("main")
        }}
        onClose={() => setShowQueryDatabasePicker(false)}
      />

      <ThemePicker
        visible={showThemePicker}
        width={width}
        height={height}
        currentTheme={themeName}
        committedTheme={committedThemeName}
        onPreview={previewTheme}
        onSelect={(selectedTheme) => {
          commitTheme(selectedTheme)
          setShowThemePicker(false)
        }}
        onCancel={() => {
          cancelPreview()
          setShowThemePicker(false)
        }}
      />
    </box>
  )
}
