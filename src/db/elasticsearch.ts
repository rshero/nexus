import { Client, HttpConnection } from "@elastic/elasticsearch"
import type {
  ConnectionConfig,
  DatabaseQueryOpts,
  DbDriver,
  ColumnDef,
  CollectionPage,
  UpdateFieldOpts,
  UpdateFieldResult,
  InsertRowOpts,
  InsertRowResult,
} from "./types.ts"
import { parseElasticSearchFilter } from "../utils/queryParser.ts"

export function createElasticSearchDriver(): DbDriver {
  let client: Client | null = null
  let connected = false

  function buildClientOptions(config: ConnectionConfig) {
    if (config.url) {
      return {
        nodes: config.url,
        auth: config.username
          ? { username: config.username, password: config.password ?? "" }
          : undefined,
        tls: config.tls ? { rejectUnauthorized: false } : undefined,
        Connection: HttpConnection,
      }
    }

    const protocol = config.tls ? "https" : "http"
    return {
      node: `${protocol}://${config.host}:${config.port}`,
      auth: config.username
        ? { username: config.username, password: config.password ?? "" }
        : undefined,
      tls: config.tls ? { rejectUnauthorized: false } : undefined,
      Connection: HttpConnection,
    }
  }

  function sortToElasticSort(sort: Record<string, 1 | -1>): Array<Record<string, { order: string }>> {
    return Object.entries(sort).map(([field, dir]) => ({
      [field]: { order: dir === 1 ? "asc" : "desc" },
    }))
  }

  function hitsToRows(hits: Array<Record<string, unknown>>): Record<string, unknown>[] {
    return hits.map((hit: Record<string, unknown>) => ({
      _id: hit._id,
      _index: hit._index,
      _score: hit._score,
      ...(hit._source as Record<string, unknown> ?? {}),
    }))
  }

  function extractTotalCount(total: unknown): number {
    if (typeof total === "number") return total
    if (typeof total === "object" && total !== null && "value" in (total as Record<string, unknown>)) {
      return (total as Record<string, unknown>).value as number
    }
    return 0
  }

  function inferColumns(rows: Record<string, unknown>[]): ColumnDef[] {
    const columns: ColumnDef[] = []
    if (rows.length > 0) {
      const first = rows[0]!
      for (const key of Object.keys(first)) {
        const val = first[key]
        columns.push({ name: key, type: val === null ? "null" : typeof val })
      }
    }
    return columns
  }

  return {
    type: "elasticsearch",

    async connect(config) {
      const options = buildClientOptions(config)
      client = new Client(options)
      await client.ping()
      connected = true
    },

    async disconnect() {
      // The @elastic/elasticsearch client doesn't have an explicit close method.
      // Release the reference so the transport connections are garbage collected.
      client = null
      connected = false
    },

    isConnected() {
      return connected
    },

    async listDatabases() {
      // Elasticsearch doesn't have a database concept.
      // Return a single virtual database representing the cluster.
      return ["_cluster"]
    },

    async listCollections(db) {
      if (!client) throw new Error("Not connected")

      const result = await client.cat.indices({ format: "json" })
      const indices = result as unknown as Array<Record<string, string>>

      return indices
        .filter((idx) => !idx.index?.startsWith("."))
        .map((idx) => ({
          name: idx.index ?? "",
          type: "collection" as const,
          count: idx.docsCount ? Number.parseInt(idx.docsCount, 10) : undefined,
        }))
        .filter((idx) => idx.name.length > 0)
    },

    async searchCollectionsPage(db, query, cursor = null, limit = 200): Promise<CollectionPage> {
      if (!client) throw new Error("Not connected")

      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0)
      const normalizedQuery = query.trim().toLowerCase()

      const result = await client.cat.indices({ format: "json" })
      const indices = (result as unknown as Array<Record<string, string>>)
        .filter((idx) => !idx.index?.startsWith("."))
        .filter((idx) => !normalizedQuery || (idx.index ?? "").toLowerCase().includes(normalizedQuery))
        .map((idx) => ({
          name: idx.index ?? "",
          type: "collection" as const,
          count: idx.docsCount ? Number.parseInt(idx.docsCount, 10) : undefined,
        }))
        .filter((idx) => idx.name.length > 0)

      const pageItems = indices.slice(offset, offset + limit)
      const nextOffset = offset + pageItems.length

      return {
        items: pageItems,
        nextCursor: nextOffset < indices.length ? String(nextOffset) : null,
        totalCount: indices.length,
      }
    },

    async query(opts) {
      if (!client) throw new Error("Not connected")

      const index = opts.collection
      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0

      const start = performance.now()

      let esQuery: Record<string, unknown>

      // Handle rawQuery as Elasticsearch query DSL
      if (opts.rawQuery && opts.rawQuery.trim()) {
        const parsed = parseElasticSearchFilter(opts.rawQuery)
        if (parsed.error) {
          throw new Error(`Query parse error: ${parsed.error}`)
        }
        esQuery = parsed.query ?? { match_all: {} }
      } else if (opts.filter && Object.keys(opts.filter).length > 0) {
        // Convert simple filter to ES query
        const must: Record<string, unknown>[] = []
        for (const [key, value] of Object.entries(opts.filter)) {
          if (key === "_id") {
            must.push({ term: { _id: value } })
          } else {
            must.push({ match: { [key]: value } })
          }
        }
        esQuery = must.length === 1 ? must[0]! : { bool: { must } }
      } else {
        esQuery = { match_all: {} }
      }

      const searchParams: Record<string, unknown> = {
        index,
        query: esQuery,
        size: limit,
        from: offset,
      }

      if (opts.sort && Object.keys(opts.sort).length > 0) {
        searchParams.sort = sortToElasticSort(opts.sort)
      }

      const result = await client.search(searchParams)

      const rows = hitsToRows(result.hits.hits as unknown as Array<Record<string, unknown>>)
      const totalCount = extractTotalCount(result.hits.total)
      const duration = Math.round(performance.now() - start)

      const columns = inferColumns(rows)

      const queryStr = `GET ${index}/_search\n${JSON.stringify({ query: esQuery, ...(searchParams.sort ? { sort: searchParams.sort } : {}), size: limit, from: offset }, null, 2)}`

      return { columns, rows, totalCount, duration, query: queryStr }
    },

    async queryDatabase(opts: DatabaseQueryOpts) {
      if (!client) throw new Error("Not connected")

      const rawQuery = opts.rawQuery.trim()
      if (!rawQuery) {
        throw new Error("Query is empty")
      }

      // Parse the raw query as Elasticsearch DSL JSON
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(rawQuery) as Record<string, unknown>
      } catch (e) {
        throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Query must be a JSON object")
      }

      const start = performance.now()

      // Determine the target index and search body:
      // 1. If the JSON has an "index" field, use it and strip it from the body
      // 2. Otherwise, use the database parameter (or "_all" if it's "_cluster")
      let targetIndex: string
      let searchBody: Record<string, unknown>

      if ("index" in parsed && typeof parsed.index === "string") {
        targetIndex = parsed.index
        const { index: _, ...rest } = parsed
        searchBody = rest
      } else {
        targetIndex = opts.database === "_cluster" ? "_all" : opts.database
        searchBody = parsed
      }

      // If the body doesn't look like a search body (no query/size/from/sort/aggs),
      // treat it as a query object and wrap it
      const searchBodyKeys = ["query", "size", "from", "sort", "aggs", "aggregations", "_source", "highlight", "post_filter"]
      const hasSearchKeys = Object.keys(searchBody).some((key) => searchBodyKeys.includes(key))

      if (!hasSearchKeys) {
        searchBody = { query: searchBody }
      }

      // Apply optional sort/limit/offset from opts
      if (opts.sort && Object.keys(opts.sort).length > 0) {
        searchBody.sort = sortToElasticSort(opts.sort)
      }
      if (opts.limit != null) {
        searchBody.size = opts.limit
      }
      if (opts.offset != null) {
        searchBody.from = opts.offset
      }

      const result = await client.search({
        index: targetIndex,
        ...searchBody,
      })

      const rows = hitsToRows(result.hits.hits as unknown as Array<Record<string, unknown>>)
      const totalCount = extractTotalCount(result.hits.total)
      const duration = Math.round(performance.now() - start)

      const columns = inferColumns(rows)

      return { columns, rows, totalCount, duration, query: rawQuery }
    },

    async updateField(opts: UpdateFieldOpts): Promise<UpdateFieldResult> {
      if (!client) throw new Error("Not connected")

      if (!("_id" in opts.row)) {
        throw new Error("Elasticsearch edit requires _id field in selected row")
      }

      const docId = String(opts.row._id)
      const index = opts.collection

      const result = await client.update({
        index,
        id: docId,
        doc: { [opts.field]: opts.value },
      })

      const query = `POST ${index}/_update/${docId}\n${JSON.stringify({ doc: { [opts.field]: opts.value } }, null, 2)}`

      return {
        query,
        affected: (result.result as string) === "updated" ? 1 : 0,
      }
    },

    async insertRow(opts: InsertRowOpts): Promise<InsertRowResult> {
      if (!client) throw new Error("Not connected")

      const { _id, _index, _score, ...document } = opts.row
      const docId = typeof _id === "string" && _id.length > 0 ? _id : undefined
      const result = await client.index({
        index: opts.collection,
        ...(docId ? { id: docId } : {}),
        document,
        refresh: true,
      })
      const query = `POST ${opts.collection}/_doc${docId ? `/${docId}` : ""}\n${JSON.stringify(document, null, 2)}`

      return {
        query,
        inserted: (result.result as string) === "created" || (result.result as string) === "updated" ? 1 : 0,
      }
    },
  }
}
