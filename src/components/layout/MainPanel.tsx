import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useApp } from "../../state/AppContext.tsx"
import { DataTable, type RowCopyContext, type SelectedCell } from "../main/DataTable.tsx"
import { FilterBar } from "../main/FilterBar.tsx"
import { QueryConsole } from "../main/QueryConsole.tsx"
import { DB_TYPE_ICONS, getDbTypeColors } from "../../constants/dbIcons.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"
import { nodeId } from "../../state/tree.ts"
import { getQueryResultSourceCollection } from "../../utils/queryResultSource.ts"
import { debug } from "../../utils/debug.ts"
import { copyTextToClipboard } from "../../utils/clipboard.ts"
import { parseRowFromClipboard } from "../../utils/rowClipboard.ts"

interface MainPanelProps {
  focused: boolean
  sidebarWidth: number
  detailWidth: number
  onOpenDetail: (tabId: string, cell: SelectedCell) => void
  onShowToast: (message: string) => void
  onQueryInputFocusChange?: (focused: boolean) => void
}

export function MainPanel({
  focused,
  sidebarWidth,
  detailWidth,
  onOpenDetail,
  onShowToast,
  onQueryInputFocusChange,
}: MainPanelProps) {
  const renderer = useRenderer()
  const { state, dispatch, closeTab, nextTab, prevTab, fetchTabData, insertTabRow, setTabFilter, setTabSort, getDriver } = useApp()
  const { colors } = useTheme()
  const borderColor = focused ? colors.accent : colors.border
  const { tabs, activeTabId, tabData, connections } = state
  const fetchedTabs = useRef(new Set<string>())
  const [filterBarFocused, setFilterBarFocused] = useState(false)
  const [queryInputFocused, setQueryInputFocused] = useState(true)
  const [querySchemaCollections, setQuerySchemaCollections] = useState<string[]>([])
  const [copiedRowText, setCopiedRowText] = useState<string | null>(null)
  const querySchemaCacheRef = useRef(new Map<string, string[]>())

  const applyQuerySchemaCollections = useCallback((collections: string[]) => {
    setQuerySchemaCollections(collections)
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeData = activeTabId ? tabData.get(activeTabId) : undefined
  const isQueryConsoleTab = activeTab?.kind === "query-console"
  const isQueryResultTab = activeTab?.kind === "query-result"
  const activeConnection = activeTab ? connections.find((c) => c.config.id === activeTab.connectionId) : undefined
  const dbType = activeConnection?.config.type ?? "mongo"

  const schemaDatabases = useMemo(() => {
    if (!activeTab) return []
    return state.allDatabases.get(activeTab.connectionId) ?? []
  }, [activeTab, state.allDatabases])

  const schemaCollectionsFromTree = useMemo(() => {
    if (!activeTab) return []
    const dbNode = nodeId(activeTab.connectionId, activeTab.database)
    const treeCollections = state.treeChildren.get(dbNode) ?? []
    return treeCollections.map((item) => item.label)
  }, [activeTab, state.treeChildren])

  const schemaCollectionFields = useMemo(() => {
    if (!activeTab) return {}

    const fields: Record<string, string[]> = {}
    for (const tab of tabs) {
      if (tab.connectionId !== activeTab.connectionId || tab.database !== activeTab.database || tab.kind !== "collection") {
        continue
      }

      const columns = tabData.get(tab.id)?.result?.columns.map((column) => column.name) ?? []
      if (columns.length === 0) continue

      const existing = fields[tab.collection] ?? []
      fields[tab.collection] = Array.from(new Set([...existing, ...columns]))
    }

    return fields
  }, [activeTab, tabs, tabData])

  useEffect(() => {
    if (activeTabId && !fetchedTabs.current.has(activeTabId)) {
      const tab = tabs.find((t) => t.id === activeTabId)
      if (tab?.kind === "query-console" || tab?.kind === "query-result") return

      const data = tabData.get(activeTabId)
      if (!data || (!data.result && !data.loading && !data.error)) {
        fetchedTabs.current.add(activeTabId)
        void fetchTabData(activeTabId)
      }
    }
  }, [activeTabId, fetchTabData, tabData, tabs])

  useEffect(() => {
    const hasMainTextInputFocus = (isQueryConsoleTab && queryInputFocused) || (!isQueryConsoleTab && filterBarFocused)
    onQueryInputFocusChange?.(hasMainTextInputFocus)
  }, [isQueryConsoleTab, queryInputFocused, filterBarFocused, onQueryInputFocusChange])

  useEffect(() => {
    if (!isQueryConsoleTab || !activeTab) {
      applyQuerySchemaCollections([])
      return
    }

    const cacheKey = `${activeTab.connectionId}/${activeTab.database}`

    if (schemaCollectionsFromTree.length > 0) {
      querySchemaCacheRef.current.set(cacheKey, schemaCollectionsFromTree)
      applyQuerySchemaCollections(schemaCollectionsFromTree)
      return
    }

    const cached = querySchemaCacheRef.current.get(cacheKey)
    if (cached && cached.length > 0) {
      applyQuerySchemaCollections(cached)
      return
    }

    const driver = getDriver(activeTab.connectionId)
    if (!driver) {
      applyQuerySchemaCollections([])
      return
    }

    let cancelled = false

    driver
      .listCollections(activeTab.database)
      .then((collections) => {
        if (cancelled) return
        const names = collections.map((collection) => collection.name)
        querySchemaCacheRef.current.set(cacheKey, names)
        applyQuerySchemaCollections(names)
      })
      .catch(() => {
        if (!cancelled) {
          applyQuerySchemaCollections([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeTab, applyQuerySchemaCollections, getDriver, isQueryConsoleTab, schemaCollectionsFromTree])

  useKeyboard((key) => {
    if (!focused) return

    if (isQueryConsoleTab) {
      if (!queryInputFocused) {
        if (key.name === "]") {
          nextTab()
          return
        }
        if (key.name === "[") {
          prevTab()
          return
        }
        if (key.name === "return" || key.name === "enter") {
          setQueryInputFocused(true)
          return
        }
        if ((key.ctrl && key.name === "w") || key.name === "w") {
          if (activeTabId) {
            fetchedTabs.current.delete(activeTabId)
            closeTab(activeTabId)
          }
          return
        }
      }
      return
    }

    if ((key.name === "f" || key.name === "/") && activeTab && !filterBarFocused && !isQueryResultTab) {
      setFilterBarFocused(true)
      return
    }

    if (filterBarFocused) return

    if (key.name === "]") {
      nextTab()
      return
    }
    if (key.name === "[") {
      prevTab()
      return
    }

    if ((key.ctrl && key.name === "w") || key.name === "w") {
      if (activeTabId) {
        fetchedTabs.current.delete(activeTabId)
        closeTab(activeTabId)
      }
      return
    }

    if (key.name === "r") {
      if (activeTabId && !isQueryResultTab) {
        fetchedTabs.current.delete(activeTabId)
        void fetchTabData(activeTabId)
      }
      return
    }
  })

  const handlePageChange = useCallback(
    (offset: number) => {
      if (activeTabId && activeData && !isQueryResultTab) {
        void fetchTabData(activeTabId, offset, activeData.pageSize)
      }
    },
    [activeTabId, activeData, isQueryResultTab, fetchTabData]
  )

  const handleSortChange = useCallback(
    (sort: Record<string, 1 | -1> | null) => {
      if (activeTabId) {
        setTabSort(activeTabId, sort)
      }
    },
    [activeTabId, setTabSort]
  )

  const handleFilterExecute = useCallback(
    async (filter: string) => {
      if (!activeTabId || !activeTab) return

      setTabFilter(activeTabId, filter)
      fetchedTabs.current.delete(activeTabId)

      const result = await fetchTabData(activeTabId, 0, undefined, filter)
      if (!result) return

      if (result.rows.length === 0) {
        onShowToast("No data returned")
        return
      }

      if (activeTab.kind === "query-console") {
        const resultTabId = `${activeTab.connectionId}/${activeTab.database}/__query_result__/${Date.now()}`
        const sourceCollection = getQueryResultSourceCollection(dbType, filter) ?? "__query_result__"
        dispatch({
          type: "OPEN_TAB",
          tab: {
            id: resultTabId,
            label: `Query result [${activeTab.database}]`,
            connectionId: activeTab.connectionId,
            database: activeTab.database,
            collection: sourceCollection,
            kind: "query-result",
          },
        })
        dispatch({
          type: "SET_TAB_DATA",
          tabId: resultTabId,
          data: {
            result,
            loading: false,
            error: null,
            pageSize: 20,
            currentOffset: 0,
            filter,
            sort: null,
            customQuery: true,
          },
        })
        return
      }

      setFilterBarFocused(false)
    },
    [activeTabId, activeTab, dispatch, fetchTabData, onShowToast, setTabFilter]
  )

  const handleFilterClear = useCallback(() => {
    if (!activeTabId) return
    if (activeTab?.kind === "query-result") return

    setTabFilter(activeTabId, "")

    if (activeTab?.kind === "query-console") {
      return
    }

    setTabSort(activeTabId, null)
    fetchedTabs.current.delete(activeTabId)
    void fetchTabData(activeTabId, 0, undefined, "")
  }, [activeTabId, activeTab, setTabFilter, setTabSort, fetchTabData])

  const handleColumnSort = useCallback(
    (column: string, direction: 1 | -1) => {
      if (activeTabId && !isQueryResultTab) {
        setTabSort(activeTabId, { [column]: direction })
        fetchedTabs.current.delete(activeTabId)
        void fetchTabData(activeTabId, 0)
      }
    },
    [activeTabId, isQueryResultTab, setTabSort, fetchTabData]
  )

  const handleCellSelect = useCallback(
    (cell: SelectedCell) => {
      if (!activeTabId || isQueryConsoleTab) return
      onOpenDetail(activeTabId, cell)
    },
    [activeTabId, isQueryConsoleTab, onOpenDetail]
  )

  const handleRowCopy = useCallback(
    (text: string, context: RowCopyContext) => {
      const tabLabel = activeTab ? `${activeTab.database}.${activeTab.collection}` : "unknown"
      setCopiedRowText(text)

      const result = copyTextToClipboard(renderer, text)

      if (result.error) {
        debug(
          `[MainPanel.copyRow] failed tab=${tabLabel} dbType=${context.dbType} rowIndex=${context.rowIndex} bytes=${context.byteLength} error=${JSON.stringify(result.error)}`
        )
      } else {
        debug(
          `[MainPanel.copyRow] tab=${tabLabel} kind=${activeTab?.kind ?? "unknown"} dbType=${context.dbType} rowIndex=${context.rowIndex} chars=${context.textLength} bytes=${context.byteLength} osc52Supported=${result.osc52Supported} rendererCopied=${result.rendererCopied} fallbackAttempted=${result.fallbackAttempted} fallbackCopied=${result.fallbackCopied} base64Bytes=${result.base64Bytes} copied=${result.copied}`
        )
      }

      onShowToast(result.copied ? "Copied row to clipboard" : "Clipboard copy failed")
    },
    [activeTab, renderer, onShowToast]
  )

  const handleRowPaste = useCallback(
    (text?: string) => {
      if (!activeTabId || !activeTab) return

      const clipboardText = text ?? copiedRowText
      if (!clipboardText) {
        onShowToast("No copied row to paste")
        return
      }

      const parsed = parseRowFromClipboard(clipboardText)
      if (parsed.error || !parsed.row) {
        debug(`[MainPanel.pasteRow] parse failed tab=${activeTab.database}.${activeTab.collection}: ${parsed.error}`)
        onShowToast(parsed.error ?? "Invalid row clipboard data")
        return
      }

      const keys = Object.keys(parsed.row)
      debug(
        `[MainPanel.pasteRow] inserting tab=${activeTab.database}.${activeTab.collection} kind=${activeTab.kind ?? "collection"} dbType=${dbType} keys=${keys.length} source=${text ? "paste-event" : "internal"}`
      )

      void insertTabRow(activeTabId, parsed.row)
        .then(() => {
          onShowToast("Inserted row")
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          debug(`[MainPanel.pasteRow] insert failed tab=${activeTab.database}.${activeTab.collection}:`, message)
          onShowToast(`Insert failed: ${message}`)
        })
    },
    [activeTabId, activeTab, copiedRowText, dbType, insertTabRow, onShowToast]
  )

  return (
    <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={borderColor}>
      <box height={1} paddingX={1} flexDirection="row" gap={0}>
        {tabs.length === 0 ? (
          <text fg={colors.muted}>No tabs open</text>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const connection = state.connections.find((c) => c.config.id === tab.connectionId)
            const dbTypeIcon = connection ? DB_TYPE_ICONS[connection.config.type] : ""
            const iconColor = connection ? getDbTypeColors(colors)[connection.config.type] : colors.info
            const connectionName = connection?.config.name || ""
            const maxLabelLen = 24
            const label = tab.label.length > maxLabelLen ? tab.label.slice(0, maxLabelLen - 2) + "…" : tab.label

            if (isActive) {
              return (
                <text key={tab.id} bg={colors.surface}>
                  <span fg={colors.purple}>▎</span>
                  <span fg={iconColor}>{dbTypeIcon}</span>
                  <span fg={colors.textBright}> {label} </span>
                  <span fg={colors.muted}>[{connectionName}]</span>
                  <span fg={colors.border}>▕</span>
                </text>
              )
            }

            return (
              <text key={tab.id}>
                <span fg={colors.surface}>▎</span>
                <span fg={colors.muted}>
                  {dbTypeIcon} {label} [{connectionName}]
                </span>
                <span fg={colors.surface}>▕</span>
              </text>
            )
          })
        )}
      </box>

      <box height={1} paddingX={0}>
        <text fg={colors.border}>{"─".repeat(200)}</text>
      </box>

      {activeTab ? (
        isQueryConsoleTab ? (
          <QueryConsole
            focused={focused && queryInputFocused}
            query={activeData?.filter || ""}
            error={activeData?.error}
            dbType={dbType}
            database={activeTab.database}
            schemaDatabases={schemaDatabases}
            schemaCollections={querySchemaCollections}
            schemaCollectionFields={schemaCollectionFields}
            onChange={(next) => setTabFilter(activeTab.id, next)}
            onExecute={handleFilterExecute}
            onBlur={() => setQueryInputFocused(false)}
          />
        ) : activeData?.loading ? (
          <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
            <text fg={colors.warning}>Loading {activeTab.database}.{activeTab.collection}...</text>
            <text fg={colors.muted}>Please wait while query executes</text>
          </box>
        ) : activeData?.error ? (
          <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
            <text fg={colors.error}>Error: {activeData.error}</text>
            <text fg={colors.muted}>
              Press <span fg={colors.info}>r</span> to retry
            </text>
          </box>
        ) : activeData?.result ? (
          <box flexGrow={1} flexDirection="column">
            {!isQueryResultTab && (
              <FilterBar
                focused={filterBarFocused}
                dbType={dbType}
                database={activeTab.database}
                collection={activeTab.collection}
                schemaDatabases={schemaDatabases}
                schemaCollections={schemaCollectionsFromTree}
                schemaCollectionFields={schemaCollectionFields}
                currentFilter={activeData.filter || ""}
                currentSort={activeData.sort}
                onSortChange={handleSortChange}
                onExecute={handleFilterExecute}
                onClear={handleFilterClear}
                onUnfocus={() => setFilterBarFocused(false)}
              />
            )}
            <DataTable
              result={activeData.result}
              focused={focused && !filterBarFocused}
              currentOffset={activeData.currentOffset}
              pageSize={activeData.pageSize}
              currentSort={activeData.sort}
              dbType={dbType}
              onPageChange={isQueryResultTab ? undefined : handlePageChange}
              onColumnSort={isQueryResultTab ? undefined : handleColumnSort}
              onCellSelect={handleCellSelect}
              onRowCopy={handleRowCopy}
              onRowPaste={handleRowPaste}
              sidebarWidth={sidebarWidth}
              detailWidth={detailWidth}
              filterBarActive={filterBarFocused}
            />
          </box>
        ) : (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={colors.muted}>Loading...</text>
          </box>
        )
      ) : (
        <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
          <text fg={colors.muted}>Connect to a database to get started</text>
          <text fg={colors.border}>
            Press <span fg={colors.info}>1</span> to focus sidebar, then <span fg={colors.info}>a</span> to add a connection
          </text>
        </box>
      )}
    </box>
  )
}
