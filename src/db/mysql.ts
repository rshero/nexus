import mysql from "mysql2/promise"
import type {
  DbDriver,
  ColumnDef,
  CollectionPage,
  DatabaseQueryOpts,
  UpdateFieldOpts,
  UpdateFieldResult,
  InsertRowOpts,
  InsertRowResult,
} from "./types.ts"
import { parseMySQLQuery, sortToOrderBy } from "../utils/queryParser.ts"

export function createMysqlDriver(): DbDriver {
  let connection: mysql.Connection | null = null
  let connected = false

  return {
    type: "mysql",

    async connect(config) {
      connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
        ssl: config.tls ? {} : undefined,
      })
      connected = true
    },

    async disconnect() {
      if (connection) {
        await connection.end()
        connection = null
      }
      connected = false
    },

    isConnected() {
      return connected
    },

    async listDatabases() {
      if (!connection) throw new Error("Not connected")
      const [rows] = await connection.query("SHOW DATABASES")
      return (rows as Array<{ Database: string }>).map((r) => r.Database)
    },

    async listCollections(db) {
      if (!connection) throw new Error("Not connected")
      const [rows] = await connection.query(`SHOW TABLE STATUS FROM \`${db}\``)
      return (rows as Array<{ Name: string; Rows: number }>).map((r) => ({
        name: r.Name,
        type: "table" as const,
        count: r.Rows ?? undefined,
      }))
    },

    async searchCollectionsPage(db, query, cursor = null, limit = 200): Promise<CollectionPage> {
      if (!connection) throw new Error("Not connected")

      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0)
      const normalizedQuery = query.trim()

      const searchClause = normalizedQuery ? " AND TABLE_NAME LIKE ?" : ""
      const searchParams: unknown[] = normalizedQuery ? [`%${normalizedQuery}%`] : []

      const [countRows] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?${searchClause}`,
        [db, ...searchParams]
      )

      const [rows] = await connection.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?${searchClause} ORDER BY TABLE_NAME LIMIT ? OFFSET ?`,
        [db, ...searchParams, limit, offset]
      )

      const items = (rows as Array<{ name: string }>).map((r) => ({ name: r.name, type: "table" as const }))
      const totalCount = (countRows as Array<{ cnt: number }>)[0]?.cnt ?? items.length
      const nextOffset = offset + items.length

      return {
        items,
        nextCursor: nextOffset < totalCount ? String(nextOffset) : null,
        totalCount,
      }
    },

    async query(opts) {
      if (!connection) throw new Error("Not connected")

      const start = performance.now()

      // If rawQuery provided, parse it for WHERE/ORDER BY/LIMIT
      if (opts.rawQuery && opts.rawQuery.trim()) {
        const parsed = parseMySQLQuery(opts.rawQuery)
        if (parsed.error) {
          throw new Error(`Query parse error: ${parsed.error}`)
        }

        await connection.query(`USE \`${opts.database}\``)
        
        const table = `\`${opts.collection}\``
        const whereClause = parsed.where ? ` WHERE ${parsed.where}` : ""
        const orderClause = parsed.orderBy ? ` ORDER BY ${parsed.orderBy}` : ""
        const limitClause = parsed.limit ? ` LIMIT ${parsed.limit}` : ""
        
        const fullQuery = `SELECT * FROM ${table}${whereClause}${orderClause}${limitClause}`
        const [rows, fields] = await connection.query(fullQuery)
        const duration = Math.round(performance.now() - start)

        const resultRows = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
        const columns: ColumnDef[] = Array.isArray(fields)
          ? fields.map((f: any) => ({ name: f.name, type: String(f.type ?? "unknown") }))
          : []

        return {
          columns,
          rows: resultRows,
          totalCount: resultRows.length,
          duration,
          query: fullQuery,
        }
      }

      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0
      const table = `\`${opts.database}\`.\`${opts.collection}\``

      let whereClause = ""
      const whereValues: unknown[] = []
      if (opts.filter && Object.keys(opts.filter).length > 0) {
        const conditions = Object.entries(opts.filter).map(([key, value]) => {
          whereValues.push(value)
          return `\`${key}\` = ?`
        })
        whereClause = ` WHERE ${conditions.join(" AND ")}`
      }

      let orderClause = ""
      if (opts.sort && Object.keys(opts.sort).length > 0) {
        orderClause = ` ORDER BY ${sortToOrderBy(opts.sort)}`
      }

      const dataQuery = `SELECT * FROM ${table}${whereClause}${orderClause} LIMIT ${limit} OFFSET ${offset}`
      const countQuery = `SELECT COUNT(*) as cnt FROM ${table}${whereClause}`

      const [rows, fields] = await connection.query(dataQuery, whereValues)
      const [countRows] = await connection.query(countQuery, whereValues)

      const duration = Math.round(performance.now() - start)
      const resultRows = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
      const columns: ColumnDef[] = Array.isArray(fields)
        ? fields.map((f: any) => ({ name: f.name, type: String(f.type ?? "unknown"), nullable: f.flags ? !(f.flags & 1) : undefined }))
        : []

      const totalCount = (countRows as Array<{ cnt: number }>)[0]?.cnt ?? resultRows.length

      return { columns, rows: resultRows, totalCount, duration, query: dataQuery }
    },

    async queryDatabase(opts: DatabaseQueryOpts) {
      if (!connection) throw new Error("Not connected")

      const statement = opts.rawQuery.trim()
      if (!statement) {
        throw new Error("Query is empty")
      }

      await connection.query(`USE \`${opts.database}\``)

      const start = performance.now()
      const [rows, fields] = await connection.query(statement)
      const duration = Math.round(performance.now() - start)

      const resultRows = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
      const columns: ColumnDef[] = Array.isArray(fields)
        ? fields.map((f: any) => ({ name: f.name, type: String(f.type ?? "unknown") }))
        : []

      return {
        columns,
        rows: resultRows,
        totalCount: resultRows.length,
        duration,
        query: statement,
      }
    },

    async updateField(opts: UpdateFieldOpts): Promise<UpdateFieldResult> {
      if (!connection) throw new Error("Not connected")

      const [pkRows] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
        [opts.database, opts.collection]
      )

      const primaryKeys = (pkRows as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME)
      if (primaryKeys.length === 0) {
        throw new Error("Cannot edit row: table has no primary key")
      }

      const setSql = `\`${opts.field}\` = ?`
      const whereParts: string[] = []
      const whereValues: unknown[] = []

      for (const key of primaryKeys) {
        if (!(key in opts.row)) {
          throw new Error(`Cannot edit row: missing primary key column ${key}`)
        }
        const keyValue = opts.row[key]
        if (keyValue === null) {
          whereParts.push(`\`${key}\` IS NULL`)
        } else {
          whereParts.push(`\`${key}\` = ?`)
          whereValues.push(keyValue)
        }
      }

      await connection.query(`USE \`${opts.database}\``)

      const sql = `UPDATE \`${opts.collection}\` SET ${setSql} WHERE ${whereParts.join(" AND ")} LIMIT 1`
      const [result] = await connection.query(sql, [opts.value, ...whereValues])

      return {
        query: sql,
        affected: (result as mysql.ResultSetHeader).affectedRows,
      }
    },

    async insertRow(opts: InsertRowOpts): Promise<InsertRowResult> {
      if (!connection) throw new Error("Not connected")

      const entries = Object.entries(opts.row).filter(([, value]) => value !== undefined)
      if (entries.length === 0) {
        throw new Error("Cannot insert empty row")
      }

      await connection.query(`USE \`${opts.database}\``)

      const columns = entries.map(([key]) => `\`${key}\``).join(", ")
      const placeholders = entries.map(() => "?").join(", ")
      const values = entries.map(([, value]) => value)
      const sql = `INSERT INTO \`${opts.collection}\` (${columns}) VALUES (${placeholders})`
      const [result] = await connection.query(sql, values)

      return {
        query: sql,
        inserted: (result as mysql.ResultSetHeader).affectedRows,
      }
    },
  }
}
