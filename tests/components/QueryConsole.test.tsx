import { afterEach, expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { QueryConsole } from "../../src/components/main/QueryConsole.tsx"
import { ThemeProvider } from "../../src/theme/ThemeContext.tsx"
import type { DbType } from "../../src/db/types.ts"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

async function emitKey({
  name,
  sequence = "",
  ctrl = false,
  shift = false,
}: {
  name: string
  sequence?: string
  ctrl?: boolean
  shift?: boolean
}) {
  await act(async () => {
    testSetup?.renderer.keyInput.emit("keypress", {
      name,
      sequence,
      ctrl,
      shift,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    })
  })
}

function QueryConsoleHarness({ initialQuery, dbType = "mongo" }: { initialQuery: string; dbType?: DbType }) {
  const [query, setQuery] = useState(initialQuery)

  return (
    <ThemeProvider>
      <QueryConsole
        focused
        query={query}
        error={null}
        dbType={dbType}
        database="testdb"
        schemaDatabases={[]}
        schemaCollections={[]}
        schemaCollectionFields={{}}
        onChange={setQuery}
        onExecute={() => {}}
        onBlur={() => {}}
      />
    </ThemeProvider>
  )
}

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = null
})

test("query console can move up a line with arrow keys before inserting", async () => {
  testSetup = await testRender(<QueryConsoleHarness initialQuery={"abcd\nef"} />, { width: 80, height: 12 })

  await testSetup.renderOnce()
  await emitKey({ name: "up" })
  await emitKey({ name: "x", sequence: "x" })
  await testSetup.renderOnce()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("abxcd")
  expect(frame).toContain("ef")
})

test("query console clears the query with Ctrl+L", async () => {
  testSetup = await testRender(<QueryConsoleHarness initialQuery={"abcdef"} />, { width: 80, height: 12 })

  await testSetup.renderOnce()
  await emitKey({ name: "l", ctrl: true })
  await emitKey({ name: "z", sequence: "z" })
  await testSetup.renderOnce()

  const frame = testSetup.captureCharFrame()
  expect(frame).toContain("z")
  expect(frame).not.toContain("abcdef")
})
