export type DbType = "elasticsearch" | "mongo" | "mysql" | "postgres" | "redis"

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  host: string
  port: number
  username?: string
  password?: string
  database?: string
  tls?: boolean
  url?: string
  visibleDatabases?: string[]
}

export type RedisKeyType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "none"

export interface CollectionInfo {
  name: string
  type: "collection" | "table" | "key" | "keyspace"
  count?: number
  redisType?: RedisKeyType
}

export interface CollectionPage {
  items: CollectionInfo[]
  nextCursor: string | null
  totalCount?: number
}

export interface ColumnDef {
  name: string
  type: string
  nullable?: boolean
}

interface QueryOpts {
  database: string
  collection: string
  filter?: Record<string, unknown>
  sort?: Record<string, 1 | -1>
  limit?: number
  offset?: number
  rawQuery?: string
}

export interface DatabaseQueryOpts {
  database: string
  rawQuery: string
  sort?: Record<string, 1 | -1>
  limit?: number
  offset?: number
}

export interface QueryResult {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  totalCount: number
  duration: number
  query: string
}

export interface UpdateFieldOpts {
  database: string
  collection: string
  row: Record<string, unknown>
  field: string
  value: unknown
}

export interface UpdateFieldResult {
  query: string
  affected: number
}

export interface InsertRowOpts {
  database: string
  collection: string
  row: Record<string, unknown>
}

export interface InsertRowResult {
  query: string
  inserted: number
}

export interface DbDriver {
  type: DbType
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  listDatabases(): Promise<string[]>
  listCollections(db: string): Promise<CollectionInfo[]>
  listCollectionsPage?(db: string, cursor?: string | null, limit?: number): Promise<CollectionPage>
  searchCollectionsPage?(db: string, query: string, cursor?: string | null, limit?: number): Promise<CollectionPage>
  countCollections?(db: string): Promise<number>
  query(opts: QueryOpts): Promise<QueryResult>
  queryDatabase?(opts: DatabaseQueryOpts): Promise<QueryResult>
  updateField?(opts: UpdateFieldOpts): Promise<UpdateFieldResult>
  insertRow?(opts: InsertRowOpts): Promise<InsertRowResult>
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

export interface ConnectionState {
  config: ConnectionConfig
  status: ConnectionStatus
  error?: string
  driver?: DbDriver
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  elasticsearch: 9200,
  mongo: 27017,
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
}
