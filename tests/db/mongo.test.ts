import { afterEach, expect, mock, test } from "bun:test"

const deleteMany = mock(async (_filter: Record<string, unknown>) => ({
  acknowledged: true,
  deletedCount: 2,
}))

const mockCollection = {
  deleteMany,
}

class MockMongoClient {
  constructor(_uri: string) {}

  async connect() {}

  async close() {}

  db() {
    return {
      collection: () => mockCollection,
    }
  }
}

class MockObjectId {
  static isValid() {
    return false
  }
}

mock.module("mongodb", () => ({
  MongoClient: MockMongoClient,
  ObjectId: MockObjectId,
}))

afterEach(() => {
  mock.clearAllMocks()
})

test("mongo query console supports deleteMany shell queries", async () => {
  const { createMongoDriver } = await import("../../src/db/mongo.ts")
  const driver = createMongoDriver()

  await driver.connect({
    id: "mongo-1",
    name: "Mongo",
    type: "mongo",
    host: "localhost",
    port: 27017,
  })

  const result = await driver.queryDatabase!({
    database: "theratech",
    rawQuery: 'db.users.deleteMany({ status: "inactive" })',
  })

  expect(deleteMany).toHaveBeenCalledWith({ status: "inactive" })
  expect(result.rows).toEqual([{ acknowledged: true, deletedCount: 2 }])
  expect(result.totalCount).toBe(1)
  expect(result.query).toBe('db.users.deleteMany({"status":"inactive"})')
})
