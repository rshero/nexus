import type { DbType } from "../db/types.ts"

export function getQueryResultSourceCollection(dbType: DbType, query: string): string | null {
  if (dbType !== "mongo") return null

  const trimmed = query.trim()
  const collectionCall = trimmed.match(/^db\.collection\s*\(\s*(["'])([A-Za-z0-9_]+)\1\s*\)\s*\./s)
  if (collectionCall) return collectionCall[2] ?? null

  const directCollection = trimmed.match(/^db\.([A-Za-z0-9_]+)\s*\./s)
  return directCollection?.[1] ?? null
}
