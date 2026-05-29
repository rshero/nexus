import { afterEach, expect, test } from "bun:test"
import { act, useEffect } from "react"
import { testRender } from "@opentui/react/test-utils"
import { Console } from "../../src/components/layout/QueryLog.tsx"
import { AppProvider, useApp } from "../../src/state/AppContext.tsx"
import { ThemeProvider } from "../../src/theme/ThemeContext.tsx"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

async function emitKey(name: string) {
  await act(async () => {
    testSetup?.renderer.keyInput.emit("keypress", {
      name,
      sequence: name,
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    })
  })
}

function ConsoleHarness({ focused }: { focused: boolean }) {
  const { log } = useApp()

  useEffect(() => {
    for (let index = 1; index <= 20; index++) {
      log("info", "query", `entry ${index}`)
    }
  }, [log])

  return <Console height={8} focused={focused} />
}

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = null
})

test("query log ignores j/k scrolling when unfocused", async () => {
  testSetup = await testRender(
    <ThemeProvider>
      <AppProvider>
        <ConsoleHarness focused={false} />
      </AppProvider>
    </ThemeProvider>,
    { width: 80, height: 12 }
  )

  await testSetup.renderOnce()
  await testSetup.renderOnce()

  const before = testSetup.captureCharFrame()
  await emitKey("k")
  await testSetup.renderOnce()
  const after = testSetup.captureCharFrame()

  expect(after).toBe(before)
})

test("query log scrolls with j/k only when focused", async () => {
  testSetup = await testRender(
    <ThemeProvider>
      <AppProvider>
        <ConsoleHarness focused />
      </AppProvider>
    </ThemeProvider>,
    { width: 80, height: 12 }
  )

  await testSetup.renderOnce()
  await testSetup.renderOnce()

  const before = testSetup.captureCharFrame()
  await emitKey("k")
  await testSetup.renderOnce()
  const after = testSetup.captureCharFrame()

  expect(after).not.toBe(before)
})
