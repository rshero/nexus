import { MongoClient, ObjectId, type Db } from "mongodb"
import type {
  ConnectionConfig,
  DatabaseQueryOpts,
  DbDriver,
  CollectionInfo,
  ColumnDef,
  CollectionPage,
  UpdateFieldOpts,
  UpdateFieldResult,
  InsertRowOpts,
  InsertRowResult,
} from "./types.ts"
import { canStartMongoRegexLiteral, parseMongoExtendedJson, parseMongoFilter, readMongoRegexLiteral } from "../utils/queryParser.ts"

export function createMongoDriver(): DbDriver {
  let client: MongoClient | null = null
  let connected = false

  function buildUri(config: ConnectionConfig): string {
    if (config.url) {
      return config.url
    }
    const auth = config.username
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@`
      : ""
    const tls = config.tls ? "?tls=true" : ""
    return `mongodb://${auth}${config.host}:${config.port}${tls}`
  }

  function getDb(name: string): Db {
    if (!client) throw new Error("Not connected")
    return client.db(name)
  }

  function getMongoRowId(row: Record<string, unknown>): unknown {
    if (!("_id" in row)) {
      throw new Error("MongoDB edit requires _id field in selected row")
    }
    const id = row._id
    if (typeof id === "string" && ObjectId.isValid(id)) {
      return new ObjectId(id)
    }
    return id
  }

  function normalizeMongoInsertRow(row: Record<string, unknown>): Record<string, unknown> {
    const next = { ...row }
    if (typeof next._id === "string" && ObjectId.isValid(next._id)) {
      next._id = new ObjectId(next._id)
    }
    return next
  }

  interface ParsedMongoShellQuery {
    collection: string
    operation: "find" | "findOne" | "countDocuments" | "aggregate" | "distinct" | "deleteOne" | "deleteMany"
    filter: Record<string, unknown>
    projection: Record<string, unknown> | null
    distinctField: string | null
    sort: Record<string, 1 | -1>
    skip: number
    limit: number
    pipeline: Array<Record<string, unknown>>
  }

  function splitTopLevelArgs(input: string): string[] {
    const args: string[] = []
    let start = 0
    let depth = 0
    let quote: '"' | "'" | null = null

    for (let i = 0; i < input.length; i++) {
      const char = input[i]!
      const prev = i > 0 ? input[i - 1] : ""

      if (quote) {
        if (char === quote && prev !== "\\") {
          quote = null
        }
        continue
      }

      if (char === '"' || char === "'") {
        quote = char
        continue
      }

      if (canStartMongoRegexLiteral(input, i)) {
        const literal = readMongoRegexLiteral(input, i)
        i = literal.end - 1
        continue
      }

      if (char === "{" || char === "[" || char === "(") depth++
      if (char === "}" || char === "]" || char === ")") depth--

      if (char === "," && depth === 0) {
        args.push(input.slice(start, i).trim())
        start = i + 1
      }
    }

    const last = input.slice(start).trim()
    if (last) args.push(last)
    return args
  }

  function parseMethodCalls(input: string): Array<{ name: string; args: string }> {
    const calls: Array<{ name: string; args: string }> = []
    let i = 0

    while (i < input.length) {
      while (i < input.length && /\s/.test(input[i]!)) i++
      if (i >= input.length) break
      if (input[i] === ";") {
        i++
        continue
      }

      if (input[i] !== ".") {
        throw new Error("Invalid query syntax")
      }
      i++

      const nameStart = i
      while (i < input.length && /[a-zA-Z]/.test(input[i]!)) i++
      const name = input.slice(nameStart, i)
      if (!name) throw new Error("Invalid query syntax")

      while (i < input.length && /\s/.test(input[i]!)) i++
      if (input[i] !== "(") throw new Error(`Method ${name} must use parentheses`)
      i++

      const argStart = i
      let depth = 1
      let quote: '"' | "'" | null = null
      while (i < input.length && depth > 0) {
        const char = input[i]!
        const prev = i > 0 ? input[i - 1] : ""

        if (quote) {
          if (char === quote && prev !== "\\") quote = null
          i++
          continue
        }

        if (char === '"' || char === "'") {
          quote = char
          i++
          continue
        }

        if (canStartMongoRegexLiteral(input, i)) {
          const literal = readMongoRegexLiteral(input, i)
          i = literal.end
          continue
        }

        if (char === "(") depth++
        if (char === ")") depth--
        i++
      }

      if (depth !== 0) throw new Error(`Unclosed parentheses in ${name}()`)

      const args = input.slice(argStart, i - 1).trim()
      calls.push({ name, args })
    }

    return calls
  }

  function parseIntArg(value: string, method: "skip" | "limit"): number {
    if (!/^\d+$/.test(value.trim())) {
      throw new Error(`${method}() expects a non-negative integer`)
    }
    return Number.parseInt(value.trim(), 10)
  }

  function parseStringArg(value: string, method: string): string {
    let parsed: unknown
    try {
      parsed = parseMongoExtendedJson(value.trim())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`${method}() string parse error: ${msg}`)
    }

    if (typeof parsed !== "string" || parsed.trim().length === 0) {
      throw new Error(`${method}() expects a non-empty string field name`)
    }

    return parsed
  }

  function parseMongoShellQuery(rawQuery: string): ParsedMongoShellQuery {
    const trimmed = rawQuery.trim()
    if (!trimmed) {
      throw new Error("Query is empty")
    }

    const collectionCallMatch = trimmed.match(/^db\.collection\s*\(\s*(["'])([A-Za-z0-9_]+)\1\s*\)(.*)$/s)
    const directMatch = trimmed.match(/^db\.([A-Za-z0-9_]+)(.*)$/s)
    const prefixMatch = collectionCallMatch ?? directMatch

    if (!prefixMatch) {
      throw new Error("Use shell-style syntax: db.collection.find({...}).limit(50)")
    }

    const collection = (collectionCallMatch ? collectionCallMatch[2] : directMatch?.[1]) ?? ""
    const suffix = (collectionCallMatch ? collectionCallMatch[3] : directMatch?.[2]) ?? ""
    const calls = parseMethodCalls(suffix)
    if (calls.length === 0) {
      throw new Error("Mongo query must include an operation, e.g. db.users.find({})")
    }

    const firstCall = calls[0]!

    let operation: ParsedMongoShellQuery["operation"]
    let filter: Record<string, unknown> = {}
    let projection: Record<string, unknown> | null = null
    let distinctField: string | null = null
    let pipeline: Array<Record<string, unknown>> = []

    if (firstCall.name === "find" || firstCall.name === "findOne") {
      operation = firstCall.name
      const findArgs = splitTopLevelArgs(firstCall.args)

      if (findArgs[0]) {
        const parsed = parseMongoFilter(findArgs[0])
        if (parsed.error) {
          throw new Error(`Filter parse error: ${parsed.error}`)
        }
        filter = parsed.filter ?? {}
      }

      if (findArgs[1]) {
        const parsedProjection = parseMongoFilter(findArgs[1])
        if (parsedProjection.error) {
          throw new Error(`Projection parse error: ${parsedProjection.error}`)
        }
        projection = parsedProjection.filter ?? {}
      }
    } else if (firstCall.name === "countDocuments") {
      operation = "countDocuments"
      if (firstCall.args) {
        const parsed = parseMongoFilter(firstCall.args)
        if (parsed.error) {
          throw new Error(`Filter parse error: ${parsed.error}`)
        }
        filter = parsed.filter ?? {}
      }
    } else if (firstCall.name === "distinct") {
      operation = "distinct"
      const distinctArgs = splitTopLevelArgs(firstCall.args)
      if (!distinctArgs[0]) {
        throw new Error("distinct() expects a field name")
      }
      if (distinctArgs.length > 2) {
        throw new Error("distinct() supports field and optional filter arguments")
      }

      distinctField = parseStringArg(distinctArgs[0], "distinct")

      if (distinctArgs[1]) {
        const parsed = parseMongoFilter(distinctArgs[1])
        if (parsed.error) {
          throw new Error(`Filter parse error: ${parsed.error}`)
        }
        filter = parsed.filter ?? {}
      }
    } else if (firstCall.name === "aggregate") {
      operation = "aggregate"
      if (!firstCall.args) {
        throw new Error("aggregate() expects a pipeline array")
      }

      let parsedPipeline: unknown
      try {
        parsedPipeline = parseMongoExtendedJson(firstCall.args)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`Aggregate parse error: ${msg}`)
      }

      if (!Array.isArray(parsedPipeline)) {
        throw new Error("aggregate() expects an array pipeline")
      }

      if (!parsedPipeline.every((stage) => typeof stage === "object" && stage !== null && !Array.isArray(stage))) {
        throw new Error("aggregate() pipeline stages must be objects")
      }

      pipeline = parsedPipeline as Array<Record<string, unknown>>
    } else if (firstCall.name === "deleteOne" || firstCall.name === "deleteMany") {
      operation = firstCall.name
      if (!firstCall.args) {
        throw new Error(`${firstCall.name}() expects a filter object`)
      }

      const deleteArgs = splitTopLevelArgs(firstCall.args)
      if (!deleteArgs[0]) {
        throw new Error(`${firstCall.name}() expects a filter object`)
      }
      if (deleteArgs.length > 1) {
        throw new Error(`${firstCall.name}() supports only a filter argument`)
      }

      const parsed = parseMongoFilter(deleteArgs[0])
      if (parsed.error) {
        throw new Error(`Filter parse error: ${parsed.error}`)
      }
      filter = parsed.filter ?? {}
    } else {
      throw new Error(`Unsupported operation: ${firstCall.name}()`)
    }

    let sort: Record<string, 1 | -1> = {}
    let skip = 0
    let limit = 50

    for (const call of calls.slice(1)) {
      if (call.name === "project") {
        if (operation !== "find" && operation !== "findOne") {
          throw new Error(`${operation}() does not support chained project()`)
        }

        const parsedProjection = parseMongoFilter(call.args || "{}")
        if (parsedProjection.error) {
          throw new Error(`Projection parse error: ${parsedProjection.error}`)
        }

        projection = parsedProjection.filter ?? {}
        continue
      }

      if (call.name === "toArray") {
        if (call.args.trim().length > 0) {
          throw new Error("toArray() does not accept arguments")
        }
        continue
      }

      if (operation !== "find") {
        throw new Error(`${operation}() does not support chained ${call.name}()`)
      }

      if (call.name === "sort") {
        const parsedSort = parseMongoFilter(call.args || "{}")
        if (parsedSort.error) {
          throw new Error(`Sort parse error: ${parsedSort.error}`)
        }

        const nextSort: Record<string, 1 | -1> = {}
        for (const [key, value] of Object.entries(parsedSort.filter ?? {})) {
          const numeric = typeof value === "number" ? value : Number(value)
          if (numeric !== 1 && numeric !== -1) {
            throw new Error("Sort values must be 1 or -1")
          }
          nextSort[key] = numeric as 1 | -1
        }
        sort = nextSort
        continue
      }

      if (call.name === "skip") {
        skip = parseIntArg(call.args, "skip")
        continue
      }

      if (call.name === "limit") {
        limit = parseIntArg(call.args, "limit")
        continue
      }

      throw new Error(`Unsupported method: ${call.name}()`)
    }

    return {
      collection,
      operation,
      filter,
      projection,
      distinctField,
      sort,
      skip,
      limit,
      pipeline,
    }
  }

  return {
    type: "mongo",

    async connect(config) {
      const uri = buildUri(config)
      client = new MongoClient(uri)
      await client.connect()
      connected = true
    },

    async disconnect() {
      if (client) {
        await client.close()
        client = null
      }
      connected = false
    },

    isConnected() {
      return connected
    },

    async listDatabases() {
      if (!client) throw new Error("Not connected")
      const result = await client.db("admin").admin().listDatabases()
      return result.databases.map((d) => d.name)
    },

    async listCollections(db) {
      const database = getDb(db)
      const collections = await database.listCollections().toArray()
      const infos: CollectionInfo[] = []

      for (const col of collections) {
        let count: number | undefined
        try {
          count = await database.collection(col.name).estimatedDocumentCount()
        } catch {
          // count unavailable
        }
        infos.push({ name: col.name, type: "collection", count })
      }

      return infos
    },

    async searchCollectionsPage(db, query, cursor = null, limit = 200): Promise<CollectionPage> {
      const database = getDb(db)
      const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0)
      const normalizedQuery = query.trim().toLowerCase()

      const collections = await database.listCollections().toArray()
      const filtered = normalizedQuery
        ? collections.filter((c) => c.name.toLowerCase().includes(normalizedQuery))
        : collections

      const pageCollections = filtered.slice(offset, offset + limit)
      const items: CollectionInfo[] = pageCollections.map((c) => ({ name: c.name, type: "collection" }))
      const nextOffset = offset + items.length

      return {
        items,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
        totalCount: filtered.length,
      }
    },

    async query(opts) {
      const database = getDb(opts.database)
      const collection = database.collection<Record<string, unknown>>(opts.collection)
      
      // Handle rawQuery as JSON filter string
      let filter = opts.filter ?? {}
      if (opts.rawQuery && opts.rawQuery.trim()) {
        const parsed = parseMongoFilter(opts.rawQuery)
        if (parsed.error) {
          throw new Error(`Filter parse error: ${parsed.error}`)
        }
        filter = parsed.filter ?? {}
      }
      
      const sort = opts.sort ?? {}
      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0

      const start = performance.now()

      const cursor = collection.find(filter).sort(sort).skip(offset).limit(limit)
      const rows = (await cursor.toArray()) as Record<string, unknown>[]
      const totalCount = await collection.countDocuments(filter)

      const duration = Math.round(performance.now() - start)

      const columns: ColumnDef[] = []
      if (rows.length > 0) {
        const first = rows[0]!
        for (const key of Object.keys(first)) {
          const val = first[key]
          columns.push({ name: key, type: val === null ? "null" : typeof val })
        }
      }

      const filterStr = Object.keys(filter).length > 0 ? JSON.stringify(filter) : "{}"
      const sortStr = Object.keys(sort).length > 0 ? `.sort(${JSON.stringify(sort)})` : ""
      const queryStr = `db.${opts.collection}.find(${filterStr})${sortStr}.skip(${offset}).limit(${limit})`

      return { columns, rows, totalCount, duration, query: queryStr }
    },

    async queryDatabase(opts: DatabaseQueryOpts) {
      const parsed = parseMongoShellQuery(opts.rawQuery)
      const database = getDb(opts.database)
      const collection = database.collection<Record<string, unknown>>(parsed.collection)

      const start = performance.now()
      let rows: Record<string, unknown>[] = []
      let totalCount = 0

      if (parsed.operation === "find") {
        const findOptions = parsed.projection ? { projection: parsed.projection } : undefined
        let cursor = collection.find(parsed.filter, findOptions)
        if (Object.keys(parsed.sort).length > 0) {
          cursor = cursor.sort(parsed.sort)
        }
        cursor = cursor.skip(parsed.skip).limit(parsed.limit)
        rows = (await cursor.toArray()) as Record<string, unknown>[]
        totalCount = await collection.countDocuments(parsed.filter)
      } else if (parsed.operation === "findOne") {
        const findOptions = parsed.projection ? { projection: parsed.projection } : undefined
        const doc = await collection.findOne(parsed.filter, findOptions)
        rows = doc ? [doc as Record<string, unknown>] : []
        totalCount = rows.length
      } else if (parsed.operation === "countDocuments") {
        const count = await collection.countDocuments(parsed.filter)
        rows = [{ count }]
        totalCount = 1
      } else if (parsed.operation === "distinct") {
        if (!parsed.distinctField) {
          throw new Error("distinct() expects a field name")
        }

        const values = await collection.distinct(parsed.distinctField, parsed.filter)
        rows = values.map((value) => ({ [parsed.distinctField!]: value }))
        totalCount = rows.length
      } else if (parsed.operation === "deleteOne") {
        const result = await collection.deleteOne(parsed.filter)
        rows = [{ acknowledged: result.acknowledged, deletedCount: result.deletedCount }]
        totalCount = rows.length
      } else if (parsed.operation === "deleteMany") {
        const result = await collection.deleteMany(parsed.filter)
        rows = [{ acknowledged: result.acknowledged, deletedCount: result.deletedCount }]
        totalCount = rows.length
      } else {
        rows = (await collection.aggregate(parsed.pipeline).toArray()) as Record<string, unknown>[]
        totalCount = rows.length
      }

      const duration = Math.round(performance.now() - start)

      const columns: ColumnDef[] = []
      if (rows.length > 0) {
        const first = rows[0]!
        for (const key of Object.keys(first)) {
          const val = first[key]
          columns.push({ name: key, type: val === null ? "null" : typeof val })
        }
      }

      let query = `db.${parsed.collection}.find(${JSON.stringify(parsed.filter)})`
      if (parsed.operation === "findOne") {
        query = `db.${parsed.collection}.findOne(${JSON.stringify(parsed.filter)})`
      } else if (parsed.operation === "countDocuments") {
        query = `db.${parsed.collection}.countDocuments(${JSON.stringify(parsed.filter)})`
      } else if (parsed.operation === "distinct") {
        query = `db.${parsed.collection}.distinct(${JSON.stringify(parsed.distinctField)}, ${JSON.stringify(parsed.filter)})`
      } else if (parsed.operation === "aggregate") {
        query = `db.${parsed.collection}.aggregate(${JSON.stringify(parsed.pipeline)})`
      } else if (parsed.operation === "deleteOne") {
        query = `db.${parsed.collection}.deleteOne(${JSON.stringify(parsed.filter)})`
      } else if (parsed.operation === "deleteMany") {
        query = `db.${parsed.collection}.deleteMany(${JSON.stringify(parsed.filter)})`
      }

      return { columns, rows, totalCount, duration, query }
    },

    async updateField(opts: UpdateFieldOpts): Promise<UpdateFieldResult> {
      const database = getDb(opts.database)
      const collection = database.collection(opts.collection)
      const rowId = getMongoRowId(opts.row)

      const result = await collection.updateOne({ _id: rowId as any }, { $set: { [opts.field]: opts.value } })
      const query = `db.${opts.collection}.updateOne({_id:${JSON.stringify(rowId)}}, {$set:{${opts.field}:...}})`

      return { query, affected: result.modifiedCount }
    },

    async insertRow(opts: InsertRowOpts): Promise<InsertRowResult> {
      const database = getDb(opts.database)
      const collection = database.collection(opts.collection)
      const row = normalizeMongoInsertRow(opts.row)

      const result = await collection.insertOne(row)
      const query = `db.${opts.collection}.insertOne(${JSON.stringify(opts.row)})`

      return { query, inserted: result.acknowledged ? 1 : 0 }
    },
  }
}
