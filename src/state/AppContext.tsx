import { createContext, useContext, useReducer, useEffect, useCallback, useRef, type ReactNode } from "react"
import type { ConnectionConfig, ConnectionState, ConnectionStatus, DbDriver, QueryResult } from "../db/types.ts"
import { createDriver } from "../db/registry.ts"
import { loadConnections, saveConnections, generateId } from "./connections.ts"
import { nodeId, type TreeNode } from "./tree.ts"
import type { ConsoleEntry, LogLevel, LogSource } from "./console.ts"
import { debug } from "../utils/debug.ts"
import { formatConnectionError, formatRuntimeError } from "../utils/errorFormatter.ts"

interface Tab {
  id: string
  label: string
  connectionId: string
  database: string
  collection: string
  kind?: "collection" | "query-console" | "query-result"
}

interface TabData {
  result: QueryResult | null
  loading: boolean
  error: string | null
  pageSize: number
  currentOffset: number
  filter: string // JSON for Mongo, SQL for MySQL, pattern for Redis
  sort: Record<string, 1 | -1> | null // Column sort state
  customQuery: boolean // Whether user entered custom query vs using builder
}

export interface AppState {
  connections: ConnectionState[]
  activeConnectionId: string | null
  treeExpanded: Set<string>
  treeSelected: string | null
  treeLoading: Set<string>
  treeChildren: Map<string, TreeNode[]>
  treeVisibleCount: Map<string, number> // nodeId -> visible item count for pagination
  treeNextCursor: Map<string, string | null>
  tabs: Tab[]
  activeTabId: string | null
  tabData: Map<string, TabData>
  consoleEntries: ConsoleEntry[]
  allDatabases: Map<string, string[]>
  visibleDatabases: Map<string, string[]>
  userSelectedDatabases: Set<string> // Track which connections have user-selected databases
}

const MAX_VISIBLE_DATABASES = 10
const MAX_ROWS_PER_TAB_CACHE = 500
const TABLE_PAGE_SIZE = 20

export type AppAction =
  | { type: "SET_CONNECTIONS"; configs: ConnectionConfig[] }
  | { type: "ADD_CONNECTION"; config: ConnectionConfig }
  | { type: "UPDATE_CONNECTION"; id: string; config: Omit<ConnectionConfig, "id"> }
  | { type: "REMOVE_CONNECTION"; id: string }
  | { type: "SET_STATUS"; id: string; status: ConnectionStatus; error?: string }
  | { type: "SET_ACTIVE"; id: string | null }
  | { type: "TREE_TOGGLE_EXPAND"; nodeId: string }
  | { type: "TREE_SET_SELECTED"; nodeId: string | null }
  | { type: "TREE_SET_LOADING"; nodeId: string; loading: boolean }
  | { type: "TREE_SET_CHILDREN"; nodeId: string; children: TreeNode[] }
  | { type: "TREE_SET_NEXT_CURSOR"; nodeId: string; cursor: string | null }
  | { type: "TREE_CLEAR_CONNECTION"; connectionId: string }
  | { type: "OPEN_TAB"; tab: Tab }
  | { type: "CLOSE_TAB"; tabId: string }
  | { type: "SET_ACTIVE_TAB"; tabId: string }
  | { type: "CLOSE_OTHER_TABS"; tabId: string }
  | { type: "CLOSE_ALL_TABS" }
  | { type: "NEXT_TAB" }
  | { type: "PREV_TAB" }
  | { type: "SET_TAB_DATA"; tabId: string; data: Partial<TabData> }
  | { type: "SET_TAB_FILTER"; tabId: string; filter: string }
  | { type: "SET_TAB_SORT"; tabId: string; sort: Record<string, 1 | -1> | null }
  | { type: "SET_TAB_PAGE_SIZE"; tabId: string; pageSize: number }
  | { type: "CONSOLE_LOG"; entry: ConsoleEntry }
  | { type: "SET_ALL_DATABASES"; connectionId: string; databases: string[] }
  | { type: "SET_VISIBLE_DATABASES"; connectionId: string; databases: string[]; userSelected?: boolean }
  | { type: "TREE_LOAD_MORE"; nodeId: string }

interface AppContextValue {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  connectTo: (id: string) => Promise<void>
  disconnectFrom: (id: string) => Promise<void>
  addConnection: (config: Omit<ConnectionConfig, "id">) => void
  updateConnection: (id: string, config: Omit<ConnectionConfig, "id">) => void
  removeConnection: (id: string) => void
  getDriver: (id: string) => DbDriver | undefined
  toggleExpand: (nid: string, connectionId: string, database?: string) => void
  selectNode: (nid: string | null) => void
  openCollection: (connectionId: string, database: string, collection: string) => void
  openQueryConsole: (connectionId: string, database: string) => string
  closeTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeAllTabs: () => void
  nextTab: () => void
  prevTab: () => void
  fetchTabData: (tabId: string, offset?: number, pageSize?: number, filter?: string) => Promise<QueryResult | null>
  updateTabCell: (tabId: string, row: Record<string, unknown>, field: string, value: unknown) => Promise<void>
  insertTabRow: (tabId: string, row: Record<string, unknown>) => Promise<void>
  setTabFilter: (tabId: string, filter: string) => void
  setTabSort: (tabId: string, sort: Record<string, 1 | -1> | null) => void
  setTabPageSize: (tabId: string, pageSize: number) => void
  setVisibleDatabases: (connectionId: string, databases: string[]) => void
  loadMoreChildren: (nodeId: string) => void
  log: (level: LogLevel, source: LogSource, message: string) => void
}

function cloneSet<T>(s: Set<T>): Set<T> {
  return new Set(s)
}

function cloneMap<K, V>(m: Map<K, V>): Map<K, V> {
  return new Map(m)
}

const MAX_CONSOLE_ENTRIES = 200

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_CONNECTIONS":
      return {
        ...state,
        connections: action.configs.map((config) => ({
          config,
          status: "disconnected" as const,
        })),
      }
    case "ADD_CONNECTION":
      return {
        ...state,
        connections: [...state.connections, { config: action.config, status: "disconnected" }],
      }
    case "UPDATE_CONNECTION":
      return {
        ...state,
        connections: state.connections.map((c) =>
          c.config.id === action.id
            ? {
                ...c,
                config: { ...action.config, id: action.id },
                status: "disconnected",
                error: undefined,
              }
            : c
        ),
        activeConnectionId: state.activeConnectionId === action.id ? null : state.activeConnectionId,
      }
    case "REMOVE_CONNECTION":
      return {
        ...state,
        connections: state.connections.filter((c) => c.config.id !== action.id),
        activeConnectionId: state.activeConnectionId === action.id ? null : state.activeConnectionId,
      }
    case "SET_STATUS":
      return {
        ...state,
        connections: state.connections.map((c) =>
          c.config.id === action.id ? { ...c, status: action.status, error: action.error } : c
        ),
      }
    case "SET_ACTIVE":
      return { ...state, activeConnectionId: action.id }

    case "TREE_TOGGLE_EXPAND": {
      const expanded = cloneSet(state.treeExpanded)
      if (expanded.has(action.nodeId)) {
        expanded.delete(action.nodeId)
      } else {
        expanded.add(action.nodeId)
      }
      return { ...state, treeExpanded: expanded }
    }
    case "TREE_SET_SELECTED":
      return { ...state, treeSelected: action.nodeId }
    case "TREE_SET_LOADING": {
      const loading = cloneSet(state.treeLoading)
      if (action.loading) {
        loading.add(action.nodeId)
      } else {
        loading.delete(action.nodeId)
      }
      return { ...state, treeLoading: loading }
    }
    case "TREE_SET_CHILDREN": {
      const children = cloneMap(state.treeChildren)
      children.set(action.nodeId, action.children)
      return { ...state, treeChildren: children }
    }
    case "TREE_SET_NEXT_CURSOR": {
      const nextCursor = cloneMap(state.treeNextCursor)
      nextCursor.set(action.nodeId, action.cursor)
      return { ...state, treeNextCursor: nextCursor }
    }
    case "TREE_CLEAR_CONNECTION": {
      const expanded = cloneSet(state.treeExpanded)
      const loading = cloneSet(state.treeLoading)
      const children = cloneMap(state.treeChildren)
      const nextCursor = cloneMap(state.treeNextCursor)
      for (const key of expanded) {
        if (key.startsWith(action.connectionId)) expanded.delete(key)
      }
      for (const key of loading) {
        if (key.startsWith(action.connectionId)) loading.delete(key)
      }
      for (const key of children.keys()) {
        if (key.startsWith(action.connectionId)) children.delete(key)
      }
      for (const key of nextCursor.keys()) {
        if (key.startsWith(action.connectionId)) nextCursor.delete(key)
      }
      return { ...state, treeExpanded: expanded, treeLoading: loading, treeChildren: children, treeNextCursor: nextCursor }
    }

    case "OPEN_TAB": {
      const exists = state.tabs.find((t) => t.id === action.tab.id)
      if (exists) {
        return { ...state, activeTabId: action.tab.id }
      }
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id }
    }
    case "CLOSE_TAB": {
      const tabs = state.tabs.filter((t) => t.id !== action.tabId)
      const tabData = cloneMap(state.tabData)
      tabData.delete(action.tabId)
      let activeTabId = state.activeTabId
      if (state.activeTabId === action.tabId) {
        // Find next best tab: prefer the tab to the right, then left, then null
        const oldIndex = state.tabs.findIndex((t) => t.id === action.tabId)
        if (tabs.length === 0) {
          activeTabId = null
        } else if (oldIndex < tabs.length) {
          activeTabId = tabs[oldIndex]!.id
        } else {
          activeTabId = tabs[tabs.length - 1]!.id
        }
      }
      return { ...state, tabs, activeTabId, tabData }
    }
    case "SET_ACTIVE_TAB":
      return { ...state, activeTabId: action.tabId }
    case "CLOSE_OTHER_TABS": {
      const kept = state.tabs.filter((t) => t.id === action.tabId)
      const tabData = new Map<string, TabData>()
      const existing = state.tabData.get(action.tabId)
      if (existing) tabData.set(action.tabId, existing)
      return { ...state, tabs: kept, activeTabId: action.tabId, tabData }
    }
    case "CLOSE_ALL_TABS":
      return { ...state, tabs: [], activeTabId: null, tabData: new Map() }
    case "NEXT_TAB": {
      if (state.tabs.length <= 1) return state
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const nextIdx = (idx + 1) % state.tabs.length
      return { ...state, activeTabId: state.tabs[nextIdx]!.id }
    }
    case "PREV_TAB": {
      if (state.tabs.length <= 1) return state
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const prevIdx = (idx - 1 + state.tabs.length) % state.tabs.length
      return { ...state, activeTabId: state.tabs[prevIdx]!.id }
    }
    case "SET_TAB_DATA": {
      const tabData = cloneMap(state.tabData)
      const existing = tabData.get(action.tabId) ?? {
        result: null,
        loading: false,
        error: null,
        pageSize: 20,
        currentOffset: 0,
        filter: "",
        sort: null,
        customQuery: false,
      }
      let nextData = { ...existing, ...action.data }
      if (nextData.result && nextData.result.rows.length > MAX_ROWS_PER_TAB_CACHE) {
        nextData = {
          ...nextData,
          result: {
            ...nextData.result,
            rows: nextData.result.rows.slice(0, MAX_ROWS_PER_TAB_CACHE),
          },
        }
      }
      tabData.set(action.tabId, nextData)
      return { ...state, tabData }
    }
    case "SET_ALL_DATABASES": {
      const allDatabases = cloneMap(state.allDatabases)
      allDatabases.set(action.connectionId, action.databases)
      // Only set visible databases if they haven't been set yet (to preserve saved preferences)
      const visibleDatabases = cloneMap(state.visibleDatabases)
      if (!visibleDatabases.has(action.connectionId)) {
        visibleDatabases.set(action.connectionId, action.databases.slice(0, MAX_VISIBLE_DATABASES))
      }
      return { ...state, allDatabases, visibleDatabases }
    }
    case "SET_VISIBLE_DATABASES": {
      const visibleDatabases = cloneMap(state.visibleDatabases)
      visibleDatabases.set(action.connectionId, action.databases)

      // Track if this is user-selected
      const userSelectedDatabases = cloneSet(state.userSelectedDatabases)
      if (action.userSelected) {
        userSelectedDatabases.add(action.connectionId)
      }

      return { ...state, visibleDatabases, userSelectedDatabases }
    }
    case "TREE_LOAD_MORE": {
      const visibleCount = cloneMap(state.treeVisibleCount)
      const current = visibleCount.get(action.nodeId) ?? 0
      const increment = current > 0 ? current : MAX_VISIBLE_DATABASES
      visibleCount.set(action.nodeId, current + increment)
      return { ...state, treeVisibleCount: visibleCount }
    }
    case "CONSOLE_LOG": {
      const entries = [...state.consoleEntries, action.entry]
      if (entries.length > MAX_CONSOLE_ENTRIES) {
        entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES)
      }
      return { ...state, consoleEntries: entries }
    }
    case "SET_TAB_FILTER": {
      const tabData = cloneMap(state.tabData)
      const existing = tabData.get(action.tabId)
      if (existing) {
        tabData.set(action.tabId, { ...existing, filter: action.filter, customQuery: true })
      }
      return { ...state, tabData }
    }
    case "SET_TAB_SORT": {
      const tabData = cloneMap(state.tabData)
      const existing = tabData.get(action.tabId)
      if (existing) {
        tabData.set(action.tabId, { ...existing, sort: action.sort })
      }
      return { ...state, tabData }
    }
    case "SET_TAB_PAGE_SIZE": {
      const tabData = cloneMap(state.tabData)
      const existing = tabData.get(action.tabId)
      if (existing) {
        tabData.set(action.tabId, { ...existing, pageSize: action.pageSize })
      }
      return { ...state, tabData }
    }
    default:
      return state
  }
}

const AppContext = createContext<AppContextValue | null>(null)

const driverMap = new Map<string, DbDriver>()

export async function disconnectAllDrivers() {
  const promises = [...driverMap.values()].map((driver) => driver.disconnect().catch(() => {}))
  await Promise.all(promises)
  driverMap.clear()
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, {
    connections: [],
    activeConnectionId: null,
    treeExpanded: new Set<string>(),
    treeSelected: null,
    treeLoading: new Set<string>(),
    treeChildren: new Map<string, TreeNode[]>(),
    treeVisibleCount: new Map<string, number>(),
    treeNextCursor: new Map<string, string | null>(),
    tabs: [],
    activeTabId: null,
    tabData: new Map<string, TabData>(),
    consoleEntries: [],
    allDatabases: new Map<string, string[]>(),
    visibleDatabases: new Map<string, string[]>(),
    userSelectedDatabases: new Set<string>(),
  })

  useEffect(() => {
    loadConnections().then((configs) => {
      if (configs.length > 0) {
        dispatch({ type: "SET_CONNECTIONS", configs })
        // Initialize visibleDatabases from saved configs
        configs.forEach((config) => {
          if (config.visibleDatabases) {
            dispatch({ type: "SET_VISIBLE_DATABASES", connectionId: config.id, databases: config.visibleDatabases, userSelected: true })
          }
        })
      }
    })
  }, [])

  useEffect(() => {
    if (state.connections.length > 0) {
      saveConnections(state.connections.map((c) => c.config))
    }
  }, [state.connections])

  const entryIdRef = useRef(0)
  const log = useCallback((level: LogLevel, source: LogSource, message: string) => {
    const entry: ConsoleEntry = {
      id: ++entryIdRef.current,
      timestamp: new Date(),
      level,
      source,
      message,
    }
    dispatch({ type: "CONSOLE_LOG", entry })
  }, [])

  const connectTo = async (id: string) => {
    const conn = state.connections.find((c) => c.config.id === id)
    if (!conn) return

    const label = conn.config.name
    log("info", "connection", `Connecting to ${label}...`)
    dispatch({ type: "SET_STATUS", id, status: "connecting" })
    try {
      const driver = createDriver(conn.config.type)
      await driver.connect(conn.config)
      driverMap.set(id, driver)
      dispatch({ type: "SET_STATUS", id, status: "connected" })
      dispatch({ type: "SET_ACTIVE", id })
      log("success", "connection", `Connected to ${label}`)
    } catch (e) {
      const userMsg = formatConnectionError(e)
      dispatch({ type: "SET_STATUS", id, status: "error", error: userMsg })
      log("error", "connection", `Failed to connect to ${label}: ${userMsg}`)
    }
  }

  const disconnectFrom = async (id: string) => {
    const conn = state.connections.find((c) => c.config.id === id)
    const label = conn ? conn.config.name : id
    const driver = driverMap.get(id)
    if (driver) {
      try {
        await driver.disconnect()
      } catch {
        // best effort
      }
      driverMap.delete(id)
    }
    dispatch({ type: "SET_STATUS", id, status: "disconnected" })
    dispatch({ type: "TREE_CLEAR_CONNECTION", connectionId: id })
    if (state.activeConnectionId === id) {
      dispatch({ type: "SET_ACTIVE", id: null })
    }
    log("info", "connection", `Disconnected from ${label}`)
  }

  const addConnection = (config: Omit<ConnectionConfig, "id">) => {
    const full: ConnectionConfig = { ...config, id: generateId() }
    dispatch({ type: "ADD_CONNECTION", config: full })
    log("info", "system", `Added connection "${config.name}"`)
  }

  const updateConnection = (id: string, config: Omit<ConnectionConfig, "id">) => {
    const conn = state.connections.find((c) => c.config.id === id)
    const oldName = conn?.config.name ?? id

    const existingDriver = driverMap.get(id)
    if (existingDriver) {
      existingDriver.disconnect().catch(() => {})
      driverMap.delete(id)
    }

    dispatch({ type: "UPDATE_CONNECTION", id, config })
    dispatch({ type: "TREE_CLEAR_CONNECTION", connectionId: id })
    log("info", "system", `Updated connection "${oldName}" to "${config.name}"`)

    // Persist to disk
    const allConfigs = state.connections.map((c) => {
      if (c.config.id === id) {
        return { ...config, id }
      }
      return c.config
    })
    saveConnections(allConfigs)
  }

  const removeConnection = (id: string) => {
    const conn = state.connections.find((c) => c.config.id === id)
    const label = conn ? conn.config.name : id
    const driver = driverMap.get(id)
    if (driver) {
      driver.disconnect().catch(() => {})
      driverMap.delete(id)
    }
    dispatch({ type: "TREE_CLEAR_CONNECTION", connectionId: id })
    dispatch({ type: "REMOVE_CONNECTION", id })
    log("info", "system", `Removed connection "${label}"`)
  }

  const getDriver = (id: string) => driverMap.get(id)

  const toggleExpand = useCallback(
    (nid: string, connectionId: string, database?: string) => {
      const isExpanded = state.treeExpanded.has(nid)
      dispatch({ type: "TREE_TOGGLE_EXPAND", nodeId: nid })

      // If expanding and we don't have children cached, fetch them
      if (!isExpanded && !state.treeChildren.has(nid)) {
        const driver = driverMap.get(connectionId)
        if (!driver) return

        dispatch({ type: "TREE_SET_LOADING", nodeId: nid, loading: true })

        if (!database) {
          // Fetch databases — store full list, show only first MAX_VISIBLE_DATABASES in tree
          const conn = state.connections.find((c) => c.config.id === connectionId)
          const connLabel = conn ? conn.config.name : connectionId
          log("info", "connection", `Fetching databases from ${connLabel}...`)
          driver
            .listDatabases()
            .then((dbs) => {
              dispatch({ type: "SET_ALL_DATABASES", connectionId, databases: dbs })

              // Check if we have saved visible databases
              const savedVisible = state.visibleDatabases.get(connectionId)

              const visible = savedVisible && savedVisible.length > 0 
                ? savedVisible 
                : dbs.slice(0, MAX_VISIBLE_DATABASES)

              const nodes: TreeNode[] = visible.map((db) => ({
                id: nodeId(connectionId, db),
                label: db,
                type: "database" as const,
                connectionId,
                database: db,
              }))
              dispatch({ type: "TREE_SET_CHILDREN", nodeId: nid, children: nodes })
              const extra = dbs.length > visible.length ? ` (showing ${visible.length} of ${dbs.length})` : ""
              log("info", "query", `Listed ${dbs.length} databases${extra}`)
            })
            .catch((e) => {
              dispatch({ type: "TREE_SET_CHILDREN", nodeId: nid, children: [] })
              const msg = formatRuntimeError(e)
              log("error", "query", `Failed to list databases: ${msg}`)
            })
            .finally(() => {
              dispatch({ type: "TREE_SET_LOADING", nodeId: nid, loading: false })
            })
        } else {
          // Fetch collections for a database
          const conn = state.connections.find((c) => c.config.id === connectionId)
          const dbType = conn?.config.type ?? "unknown"
          const itemType = dbType === "mysql" || dbType === "postgres" ? "tables" : dbType === "redis" ? "keys" : "collections"
          log("info", "connection", `Fetching ${itemType} from database: ${database}...`)
          const listCollections = driver.listCollectionsPage
            ? driver.listCollectionsPage(database)
            : driver.listCollections(database).then((items) => ({ items, nextCursor: null }))

          listCollections
            .then((cols) => {
              const nodes: TreeNode[] = cols.items.map((col) => ({
                id: nodeId(connectionId, database, col.name),
                label: col.name,
                type: "collection" as const,
                connectionId,
                database,
                collection: col.name,
                count: col.count,
                redisType: col.redisType,
              }))
              dispatch({ type: "TREE_SET_CHILDREN", nodeId: nid, children: nodes })
              dispatch({ type: "TREE_SET_NEXT_CURSOR", nodeId: nid, cursor: cols.nextCursor })
              log("info", "connection", `Accessed database: ${database} (${cols.items.length} ${itemType})`)
            })
            .catch((e) => {
              debug(`[toggleExpand] Failed loading ${itemType} connection=${connectionId} database=${database}:`, e)
              dispatch({ type: "TREE_SET_CHILDREN", nodeId: nid, children: [] })
              dispatch({ type: "TREE_SET_NEXT_CURSOR", nodeId: nid, cursor: null })
              const msg = formatRuntimeError(e)
              log("error", "query", `Failed to list ${itemType} in ${database}: ${msg}`)
            })
            .finally(() => {
              dispatch({ type: "TREE_SET_LOADING", nodeId: nid, loading: false })
            })
        }
      }
    },
    [state.treeExpanded, state.treeChildren, state.visibleDatabases, state.connections, log]
  )

  const selectNode = useCallback((nid: string | null) => {
    dispatch({ type: "TREE_SET_SELECTED", nodeId: nid })
  }, [])

  const openCollection = useCallback(
    (connectionId: string, database: string, collection: string) => {
      const conn = state.connections.find((c) => c.config.id === connectionId)
      const dbType = conn?.config.type ?? "unknown"
      const itemName = dbType === "mysql" || dbType === "postgres" ? "table" : dbType === "redis" ? "keys" : "collection"
      log("info", "connection", `Opened ${itemName}: ${collection} in database ${database}`)
      const tabId = `${connectionId}/${database}/${collection}`
      const tab: Tab = {
        id: tabId,
        label: collection,
        connectionId,
        database,
        collection,
        kind: "collection",
      }
      dispatch({ type: "OPEN_TAB", tab })
    },
    [log, state.connections]
  )

  const openQueryConsole = useCallback(
    (connectionId: string, database: string): string => {
      const tabId = `${connectionId}/${database}/__query_console__/${Date.now()}`
      const tab: Tab = {
        id: tabId,
        label: `Query console [${database}]`,
        connectionId,
        database,
        collection: "__query_console__",
        kind: "query-console",
      }

      dispatch({ type: "OPEN_TAB", tab })
      dispatch({
        type: "SET_TAB_DATA",
        tabId,
        data: {
          result: null,
          loading: false,
          error: null,
          filter: "",
          currentOffset: 0,
          customQuery: true,
        },
      })

      const conn = state.connections.find((c) => c.config.id === connectionId)
      const connLabel = conn?.config.name ?? connectionId
      log("info", "query", `Opened query console for ${connLabel}/${database}`)
      return tabId
    },
    [log, state.connections]
  )

  const closeTab = useCallback((tabId: string) => {
    dispatch({ type: "CLOSE_TAB", tabId })
  }, [])

  const closeOtherTabs = useCallback((tabId: string) => {
    dispatch({ type: "CLOSE_OTHER_TABS", tabId })
  }, [])

  const closeAllTabs = useCallback(() => {
    dispatch({ type: "CLOSE_ALL_TABS" })
  }, [])

  const nextTab = useCallback(() => {
    dispatch({ type: "NEXT_TAB" })
  }, [])

  const prevTab = useCallback(() => {
    dispatch({ type: "PREV_TAB" })
  }, [])

  const fetchTabData = useCallback(
    async (tabId: string, offset?: number, pageSize?: number, filter?: string): Promise<QueryResult | null> => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) return null

      const driver = driverMap.get(tab.connectionId)
      if (!driver) return null

      const conn = state.connections.find((c) => c.config.id === tab.connectionId)
      if (!conn) return null

      const dbType = conn.config.type
      const executesRawQuery = tab.kind === "query-console" || tab.kind === "query-result"
      const itemName = executesRawQuery
        ? "database"
        : dbType === "mysql" || dbType === "postgres"
          ? "table"
          : dbType === "redis"
            ? "keys"
            : "collection"

      const tabDataEntry = state.tabData.get(tabId)
      const limit = TABLE_PAGE_SIZE
      const off = offset ?? tabDataEntry?.currentOffset ?? 0
      const activeFilter = filter !== undefined ? filter : (tabDataEntry?.filter || "")

      if (executesRawQuery && !activeFilter.trim()) {
        dispatch({
          type: "SET_TAB_DATA",
          tabId,
          data: { result: null, loading: false, error: null, filter: "", currentOffset: 0 },
        })
        return null
      }

      dispatch({
        type: "SET_TAB_DATA",
        tabId,
        data: { loading: true, error: null, pageSize: TABLE_PAGE_SIZE, currentOffset: off },
      })

      try {
        if (!driver.isConnected()) {
          log("warning", "connection", `Connection dropped for ${conn.config.name}, reconnecting...`)
          await driver.connect(conn.config)
          log("success", "connection", `Reconnected to ${conn.config.name}`)
        }

        const result =
          executesRawQuery
            ? await driver.queryDatabase?.({
                database: tab.database,
                rawQuery: activeFilter,
                limit,
                offset: off,
                sort: tabDataEntry?.sort || undefined,
              })
            : await driver.query({
                database: tab.database,
                collection: tab.collection,
                limit,
                offset: off,
                rawQuery: activeFilter || undefined,
                sort: tabDataEntry?.sort || undefined,
              })

        if (!result) {
          throw new Error("This database driver does not support database-level queries")
        }

        dispatch({ type: "SET_TAB_DATA", tabId, data: { result, loading: false } })
        log("info", "query", `${result.query} — ${result.duration}ms, ${result.rows.length} rows`)
        return result
      } catch (e) {
        const msg = formatRuntimeError(e)
        dispatch({ type: "SET_TAB_DATA", tabId, data: { loading: false, error: msg } })
        const targetLabel = executesRawQuery ? tab.database : tab.collection
        log("error", "query", `Failed to query ${itemName} ${targetLabel}: ${msg}`)
        return null
      }
    },
    [state.tabs, state.connections, state.tabData, log]
  )

  const updateTabCell = useCallback(
    async (tabId: string, row: Record<string, unknown>, field: string, value: unknown) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) throw new Error("Tab not found")

      const driver = driverMap.get(tab.connectionId)
      if (!driver) throw new Error("No active driver for tab connection")
      if (!driver.updateField) throw new Error("This database driver does not support editing")
      if (tab.kind === "query-result" && tab.collection === "__query_result__") {
        throw new Error("Cannot edit this query result because its source collection could not be determined")
      }

      log("info", "query", `Applying edit to ${tab.collection}.${field}...`)

      const result = await driver.updateField({
        database: tab.database,
        collection: tab.collection,
        row,
        field,
        value,
      })

      log("success", "query", `${result.query} — affected ${result.affected}`)

      const tabDataEntry = state.tabData.get(tabId)
      fetchTabData(tabId, tabDataEntry?.currentOffset ?? 0, tabDataEntry?.pageSize)
    },
    [state.tabs, state.tabData, fetchTabData, log]
  )

  const insertTabRow = useCallback(
    async (tabId: string, row: Record<string, unknown>) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) throw new Error("Tab not found")
      if (tab.kind === "query-console" || tab.kind === "query-result") {
        throw new Error("Rows can only be pasted into collection/table tabs")
      }

      const driver = driverMap.get(tab.connectionId)
      if (!driver) throw new Error("No active driver for tab connection")
      if (!driver.insertRow) throw new Error("This database driver does not support row inserts")

      log("info", "query", `Inserting row into ${tab.collection}...`)

      const result = await driver.insertRow({
        database: tab.database,
        collection: tab.collection,
        row,
      })

      log("success", "query", `${result.query} — inserted ${result.inserted}`)

      const tabDataEntry = state.tabData.get(tabId)
      fetchTabData(tabId, tabDataEntry?.currentOffset ?? 0, tabDataEntry?.pageSize)
    },
    [state.tabs, state.tabData, fetchTabData, log]
  )

  const setVisibleDatabases = useCallback(
    (connectionId: string, databases: string[]) => {
      const conn = state.connections.find((c) => c.config.id === connectionId)
      if (conn) {
        log("info", "connection", `Selected ${databases.length} database(s) for ${conn.config.name}`)
      }
      dispatch({ type: "SET_VISIBLE_DATABASES", connectionId, databases, userSelected: true })
      // Rebuild tree children for this connection
      const connNid = nodeId(connectionId)
      const nodes: TreeNode[] = databases.map((db) => ({
        id: nodeId(connectionId, db),
        label: db,
        type: "database" as const,
        connectionId,
        database: db,
      }))
      dispatch({ type: "TREE_SET_CHILDREN", nodeId: connNid, children: nodes })

      // Persist to disk
      const updatedConnections = state.connections.map((c) =>
        c.config.id === connectionId ? { ...c, config: { ...c.config, visibleDatabases: databases } } : c
      )
      saveConnections(updatedConnections.map((c) => c.config))
    },
    [state.connections, log]
  )

  const loadMoreChildren = useCallback(
    (treeNodeId: string) => {
      const [connectionId, ...databaseParts] = treeNodeId.split("/")
      if (!connectionId) return

      const database = databaseParts.join("/")
      const conn = state.connections.find((c) => c.config.id === connectionId)
      const driver = connectionId ? driverMap.get(connectionId) : undefined
      const nextCursor = state.treeNextCursor.get(treeNodeId)

      if (database && driver?.listCollectionsPage && nextCursor) {
        const existingChildren = state.treeChildren.get(treeNodeId) ?? []
        const itemType = conn?.config.type === "redis" ? "keys" : conn?.config.type === "mysql" || conn?.config.type === "postgres" ? "tables" : "collections"

        dispatch({ type: "TREE_SET_LOADING", nodeId: treeNodeId, loading: true })

        driver
          .listCollectionsPage(database, nextCursor, 20)
          .then((page) => {
            const nextNodes: TreeNode[] = page.items.map((col) => ({
              id: nodeId(connectionId, database, col.name),
              label: col.name,
              type: "collection" as const,
              connectionId,
              database,
              collection: col.name,
              count: col.count,
              redisType: col.redisType,
            }))
            const mergedChildren = [...existingChildren, ...nextNodes]

            dispatch({ type: "TREE_SET_CHILDREN", nodeId: treeNodeId, children: mergedChildren })
            dispatch({ type: "TREE_SET_NEXT_CURSOR", nodeId: treeNodeId, cursor: page.nextCursor })
            log("info", "connection", `Loaded ${nextNodes.length} more ${itemType} from database ${database}`)
          })
          .catch((e) => {
            debug(`[loadMoreChildren] Failed next page connection=${connectionId} database=${database}:`, e)
            const msg = formatRuntimeError(e)
            log("error", "query", `Failed to load more items in ${database}: ${msg}`)
          })
          .finally(() => {
            dispatch({ type: "TREE_SET_LOADING", nodeId: treeNodeId, loading: false })
          })

        return
      }

      dispatch({ type: "TREE_LOAD_MORE", nodeId: treeNodeId })
    },
    [state.connections, state.treeChildren, state.treeNextCursor, log]
  )

  const setTabFilter = useCallback((tabId: string, filter: string) => {
    dispatch({ type: "SET_TAB_FILTER", tabId, filter })
  }, [])

  const setTabSort = useCallback((tabId: string, sort: Record<string, 1 | -1> | null) => {
    dispatch({ type: "SET_TAB_SORT", tabId, sort })
  }, [])

  const setTabPageSize = useCallback((tabId: string, pageSize: number) => {
    dispatch({ type: "SET_TAB_PAGE_SIZE", tabId, pageSize })
  }, [])

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        connectTo,
        disconnectFrom,
        addConnection,
        updateConnection,
        removeConnection,
        getDriver,
        toggleExpand,
        selectNode,
        openCollection,
        openQueryConsole,
        closeTab,
        closeOtherTabs,
        closeAllTabs,
        nextTab,
        prevTab,
        fetchTabData,
        updateTabCell,
        insertTabRow,
        setTabFilter,
        setTabSort,
        setTabPageSize,
        setVisibleDatabases,
        loadMoreChildren,
        log,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useApp must be used within AppProvider")
  return ctx
}
