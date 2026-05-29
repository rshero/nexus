import { expect, test } from "bun:test"
import { getQueryResultSourceCollection } from "../../src/utils/queryResultSource.ts"

test("extracts Mongo direct collection from query-console query", () => {
  expect(getQueryResultSourceCollection("mongo", 'db.users.find({"email":"a@example.com"})')).toBe("users")
})

test("extracts Mongo quoted collection from query-console query", () => {
  expect(getQueryResultSourceCollection("mongo", 'db.collection("audit_logs").find({})')).toBe("audit_logs")
})

test("does not infer a source collection for other database types", () => {
  expect(getQueryResultSourceCollection("postgres", "select * from users")).toBeNull()
})
