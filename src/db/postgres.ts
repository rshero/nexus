import { Client } from "pg"
import type {
  ColumnDef,
  CollectionInfo,
  CollectionPage,
  ConnectionConfig,
  DatabaseQueryOpts,
  DbDriver,
  InsertRowOpts,
  InsertRowResult,
  UpdateFieldOpts,
  UpdateFieldResult,
} from "./types.ts"
import { parseMySQLQuery } from "../utils/queryParser.ts"

interface ParsedTableName {
  schema: string
  table: string
}

function parseTableName(input: string): ParsedTableName {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Table name is empty")
  }

  const parts = trimmed.split(".").map((part) => part.replace(/^"|"$/g, "").trim())
  if (parts.length === 1) {
    return { schema: "public", table: parts[0]! }
  }

  if (parts.length === 2) {
    return { schema: parts[0]!, table: parts[1]! }
  }

  throw new Error("Invalid table name")
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function quoteTableName(tableName: string): string {
  const parsed = parseTableName(tableName)
  return `${quoteIdentifier(parsed.schema)}.${quoteIdentifier(parsed.table)}`
}

function mapRowsToCollections(rows: Array<{ table_schema: string; table_name: string }>): CollectionInfo[] {
  return rows.map((row) => ({
    name: row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`,
    type: "table",
  }))
}

function buildConnectionConfig(base: ConnectionConfig, database?: string): {
  connectionString?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  ssl?: object
} {
  if (base.url) {
    const parsed = new URL(base.url)
    if (database) {
      parsed.pathname = `/${database}`
    }
    return {
      connectionString: parsed.toString(),
      ssl: base.tls ? { rejectUnauthorized: false } : undefined,
    }
  }

  return {
    host: base.host,
    port: base.port,
    user: base.username,
    password: base.password,
    database: database ?? base.database,
    ssl: base.tls ? { rejectUnauthorized: false } : undefined,
  }
}

export function createPostgresDriver(): DbDriver {
  let connected = false
  let baseConfig: ConnectionConfig | null = null
  const clients = new Map<string, Client>()

  function markClientClosed(database: string, client: Client) {
    if (clients.get(database) !== client) return

    clients.delete(database)
    connected = clients.size > 0
  }

  async function getClient(database?: string): Promise<Client> {
    if (!baseConfig) {
      throw new Error("Not connected")
    }

    const targetDatabase = database || baseConfig.database || "postgres"
    const existing = clients.get(targetDatabase)
    if (existing) return existing

    const client = new Client(buildConnectionConfig(baseConfig, targetDatabase))
    client.once("end", () => markClientClosed(targetDatabase, client))
    client.on("error", () => markClientClosed(targetDatabase, client))
    await client.connect()
    clients.set(targetDatabase, client)
    connected = true
    return client
  }

  async function closeAllClients() {
    const pending = [...clients.values()].map((client) => client.end().catch(() => {}))
    await Promise.all(pending)
    clients.clear()
  }

  return {
    type: "postgres",

    async connect(config) {
      await closeAllClients()
      baseConfig = config
      const initialDatabase = config.database || "postgres"
      await getClient(initialDatabase)
      connected = true
    },

    async disconnect() {
      await closeAllClients()
      baseConfig = null
      connected = false
    },

    isConnected() {
      return connected
    },

    async listDatabases() {
      const client = await getClient()
      const result = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datallowconn = true AND datistemplate = false ORDER BY datname`
      )
      return result.rows.map((row) => row.datname)
    },

    async listCollections(db) {
      const client = await getClient(db)
      const result = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name`
      )

      return mapRowsToCollections(result.rows)
    },

    async searchCollectionsPage(db, query, cursor = null, limit = 200): Promise<CollectionPage> {
      const client = await getClient(db)
      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0)
      const normalizedQuery = query.trim()

      const searchClause = normalizedQuery
        ? " AND (table_name ILIKE $1 OR (table_schema || '.' || table_name) ILIKE $1)"
        : ""

      const searchParams: unknown[] = normalizedQuery ? [`%${normalizedQuery}%`] : []
      const countParamOffset = searchParams.length

      const countResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')${searchClause}`,
        searchParams
      )

      const rowsResult = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')${searchClause}
         ORDER BY table_schema, table_name
         LIMIT $${countParamOffset + 1}
         OFFSET $${countParamOffset + 2}`,
        [...searchParams, limit, offset]
      )

      const items = mapRowsToCollections(rowsResult.rows)
      const totalCount = Number.parseInt(countResult.rows[0]?.cnt ?? String(items.length), 10)
      const nextOffset = offset + items.length

      return {
        items,
        nextCursor: nextOffset < totalCount ? String(nextOffset) : null,
        totalCount,
      }
    },

    async query(opts) {
      const client = await getClient(opts.database)
      const start = performance.now()

      if (opts.rawQuery && opts.rawQuery.trim()) {
        const parsed = parseMySQLQuery(opts.rawQuery)
        if (parsed.error) {
          throw new Error(`Query parse error: ${parsed.error}`)
        }

        const tableSql = quoteTableName(opts.collection)
        const whereClause = parsed.where ? ` WHERE ${parsed.where}` : ""
        const orderClause = parsed.orderBy ? ` ORDER BY ${parsed.orderBy}` : ""
        const limitClause = parsed.limit != null ? ` LIMIT ${parsed.limit}` : ""

        const statement = `SELECT * FROM ${tableSql}${whereClause}${orderClause}${limitClause}`
        const result = await client.query<Record<string, unknown>>(statement)
        const duration = Math.round(performance.now() - start)

        const columns: ColumnDef[] = result.fields.map((field) => ({
          name: field.name,
          type: String(field.dataTypeID),
        }))

        return {
          columns,
          rows: result.rows,
          totalCount: result.rows.length,
          duration,
          query: statement,
        }
      }

      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0
      const tableSql = quoteTableName(opts.collection)

      let whereClause = ""
      const whereValues: unknown[] = []
      if (opts.filter && Object.keys(opts.filter).length > 0) {
        const conditions = Object.entries(opts.filter).map(([key, value], index) => {
          whereValues.push(value)
          return `${quoteIdentifier(key)} = $${index + 1}`
        })
        whereClause = ` WHERE ${conditions.join(" AND ")}`
      }

      let orderClause = ""
      if (opts.sort && Object.keys(opts.sort).length > 0) {
        const parts = Object.entries(opts.sort).map(([column, direction]) => {
          const dir = direction === 1 ? "ASC" : "DESC"
          return `${quoteIdentifier(column)} ${dir}`
        })
        orderClause = ` ORDER BY ${parts.join(", ")}`
      }

      const dataQuery = `SELECT * FROM ${tableSql}${whereClause}${orderClause} LIMIT $${whereValues.length + 1} OFFSET $${whereValues.length + 2}`
      const countQuery = `SELECT COUNT(*)::text AS cnt FROM ${tableSql}${whereClause}`

      const [dataResult, countResult] = await Promise.all([
        client.query<Record<string, unknown>>(dataQuery, [...whereValues, limit, offset]),
        client.query<{ cnt: string }>(countQuery, whereValues),
      ])

      const duration = Math.round(performance.now() - start)
      const columns: ColumnDef[] = dataResult.fields.map((field) => ({
        name: field.name,
        type: String(field.dataTypeID),
      }))

      const totalCount = Number.parseInt(countResult.rows[0]?.cnt ?? String(dataResult.rows.length), 10)

      return {
        columns,
        rows: dataResult.rows,
        totalCount,
        duration,
        query: dataQuery,
      }
    },

    async queryDatabase(opts: DatabaseQueryOpts) {
      const client = await getClient(opts.database)
      const statement = opts.rawQuery.trim()
      if (!statement) {
        throw new Error("Query is empty")
      }

      const start = performance.now()
      const result = await client.query<Record<string, unknown>>(statement)
      const duration = Math.round(performance.now() - start)

      const columns: ColumnDef[] = result.fields.map((field) => ({
        name: field.name,
        type: String(field.dataTypeID),
      }))

      return {
        columns,
        rows: result.rows,
        totalCount: result.rows.length,
        duration,
        query: statement,
      }
    },

    async updateField(opts: UpdateFieldOpts): Promise<UpdateFieldResult> {
      const client = await getClient(opts.database)
      const table = parseTableName(opts.collection)

      const pkResult = await client.query<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2
         ORDER BY kcu.ordinal_position`,
        [table.schema, table.table]
      )

      const primaryKeys = pkResult.rows.map((row) => row.column_name)
      if (primaryKeys.length === 0) {
        throw new Error("Cannot edit row: table has no primary key")
      }

      const whereParts: string[] = []
      const values: unknown[] = [opts.value]

      for (const key of primaryKeys) {
        if (!(key in opts.row)) {
          throw new Error(`Cannot edit row: missing primary key column ${key}`)
        }

        const keyValue = opts.row[key]
        if (keyValue === null) {
          whereParts.push(`${quoteIdentifier(key)} IS NULL`)
        } else {
          values.push(keyValue)
          whereParts.push(`${quoteIdentifier(key)} = $${values.length}`)
        }
      }

      const tableSql = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`
      const sql = `UPDATE ${tableSql} SET ${quoteIdentifier(opts.field)} = $1 WHERE ${whereParts.join(" AND ")}`
      const result = await client.query(sql, values)

      return {
        query: sql,
        affected: result.rowCount ?? 0,
      }
    },

    async insertRow(opts: InsertRowOpts): Promise<InsertRowResult> {
      const client = await getClient(opts.database)
      const entries = Object.entries(opts.row).filter(([, value]) => value !== undefined)
      if (entries.length === 0) {
        throw new Error("Cannot insert empty row")
      }

      const columns = entries.map(([key]) => quoteIdentifier(key)).join(", ")
      const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ")
      const values = entries.map(([, value]) => value)
      const sql = `INSERT INTO ${quoteTableName(opts.collection)} (${columns}) VALUES (${placeholders})`
      const result = await client.query(sql, values)

      return {
        query: sql,
        inserted: result.rowCount ?? 0,
      }
    },
  }
}
