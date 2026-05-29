import { expect, test } from "bun:test"
import { formatRowForClipboard, parseRowFromClipboard } from "../../src/utils/rowClipboard.ts"
import type { ColumnDef } from "../../src/db/types.ts"

const columns: ColumnDef[] = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "meta", type: "object" },
]

test("formats Mongo rows as pretty JSON in column order", () => {
  const text = formatRowForClipboard("mongo", columns, {
    extra: true,
    id: 1,
    name: "Ada",
    meta: { active: true },
  })

  expect(text).toBe('{\n  "id": 1,\n  "name": "Ada",\n  "meta": {\n    "active": true\n  },\n  "extra": true\n}')
})

test("formats SQL rows as tab-separated header and values", () => {
  const text = formatRowForClipboard("postgres", columns, {
    id: 1,
    name: "Ada",
    meta: { active: true },
  })

  expect(text).toBe('id\tname\tmeta\n1\tAda\t"{\n  ""active"": true\n}"')
})

test("escapes tabular values with tabs and newlines", () => {
  const text = formatRowForClipboard(
    "mysql",
    [
      { name: "id", type: "number" },
      { name: "note", type: "string" },
    ],
    { id: 2, note: "first\tsecond\nthird" }
  )

  expect(text).toBe('id\tnote\n2\t"first\tsecond\nthird"')
})

test("parses JSON row clipboard text", () => {
  expect(parseRowFromClipboard('{"id":1,"name":"Ada"}')).toEqual({
    row: { id: 1, name: "Ada" },
  })
})

test("parses tabular row clipboard text", () => {
  expect(parseRowFromClipboard('id\tname\tmeta\n1\tAda\t"{\n  ""active"": true\n}"')).toEqual({
    row: { id: 1, name: "Ada", meta: { active: true } },
  })
})
