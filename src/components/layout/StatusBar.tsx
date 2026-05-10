import type { FocusZone } from "../../App.tsx"
import { useTheme } from "../../theme/ThemeContext.tsx"

interface StatusBarProps {
  focusZone: FocusZone
  showQueryLog: boolean
  showDetail: boolean
  width: number
}

const SEP = "  "

interface Shortcut {
  key: string
  desc: string
}

function getShortcuts(focusZone: FocusZone, showQueryLog: boolean): Shortcut[] {
  const base: Shortcut[] = [
    { key: "Tab", desc: "Switch Panel" },
    { key: "Ctrl+P", desc: "Commands" },
    { key: "Ctrl+B", desc: "Toggle Sidebar" },
    { key: "Ctrl+T", desc: "Toggle Theme" },
    { key: "`", desc: showQueryLog ? "Hide Console" : "Show Console" },
    { key: "1-4", desc: "Jump Panel" },
    { key: "Ctrl+Q", desc: "Quit" },
  ]

  const contextual: Record<FocusZone, Shortcut[]> = {
    sidebar: [
      { key: "a", desc: "Add" },
      { key: "Enter", desc: "Open/Expand" },
      { key: "h/l", desc: "Collapse/Expand" },
      { key: "e", desc: "Pick DBs" },
      { key: "s", desc: "Search" },
      { key: "d", desc: "Disconnect" },
      { key: "x", desc: "Remove" },
    ],
    main: [
      { key: "]/[", desc: "Switch Tab" },
      { key: "w", desc: "Close Tab" },
      { key: "r", desc: "Reload" },
      { key: "Enter/v", desc: "View Cell" },
    ],
    detail: [
      { key: "Ctrl+A", desc: "Apply" },
      { key: "Esc/q", desc: "Close" },
      { key: "Select", desc: "Copy" },
    ],
    querylog: [
      { key: "Select", desc: "Copy" },
      { key: "Enter", desc: "Re-run" },
    ],
  }

  return [...(contextual[focusZone] ?? []), ...base]
}

function fitShortcuts(shortcuts: Shortcut[], width: number): Shortcut[] {
  if (width <= 0) return []

  const fitted: Shortcut[] = []
  let used = 0

  for (let i = 0; i < shortcuts.length; i++) {
    const s = shortcuts[i]!
    const piece = `${i > 0 ? SEP : ""}[${s.key}] ${s.desc}`
    if (used + piece.length > width - 1) break
    fitted.push(s)
    used += piece.length
  }

  return fitted
}

export function StatusBar({ focusZone, showQueryLog, width }: StatusBarProps) {
  const { colors } = useTheme()
  const shortcuts = getShortcuts(focusZone, showQueryLog)
  const visibleShortcuts = fitShortcuts(shortcuts, width)

  return (
    <box height={1} flexDirection="row" paddingX={1} gap={0}>
      {visibleShortcuts.map((s, i) => (
        <text key={s.key}>
          {i > 0 ? SEP : ""}
          <span fg={colors.accent}>[{s.key}]</span>
          <span fg={colors.info}> {s.desc}</span>
        </text>
      ))}
    </box>
  )
}
