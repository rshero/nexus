import { useApp } from "../../state/AppContext.tsx"
import { formatTimestamp, type ConsoleEntry } from "../../state/console.ts"
import type { ThemeColors } from "../../theme/themes.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"

interface ConsoleProps {
  height: number
  focused: boolean
}

function getLevelLabel(level: ConsoleEntry["level"]): string {
  return level === "warning" ? "WARN" : level.toUpperCase()
}

function getSourceColor(source: ConsoleEntry["source"], colors: ThemeColors): string {
  switch (source) {
    case "query":
      return colors.info
    case "connection":
      return colors.purple
    case "system":
      return colors.teal
    default:
      return colors.muted
  }
}

function getLevelColor(level: ConsoleEntry["level"], colors: ThemeColors): string {
  switch (level) {
    case "error":
      return colors.error
    case "warning":
      return colors.warning
    case "info":
      return colors.info
    case "success":
      return colors.success
    default:
      return colors.text
  }
}

export function Console({ height, focused }: ConsoleProps) {
  const { state } = useApp()
  const { colors } = useTheme()
  const borderColor = focused ? colors.accent : colors.muted
  const entries = state.consoleEntries

  return (
    <box
      height={height}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderColor}
      title=" Console "
      titleAlignment="left"
    >
      {entries.length === 0 ? (
        <box flexGrow={1} paddingX={1}>
          <text fg={colors.text}>No activity yet</text>
        </box>
      ) : (
        <scrollbox
          flexGrow={1}
          paddingX={1}
          focused={focused}
          stickyScroll
          stickyStart="bottom"
          scrollY
          scrollX={false}
          verticalScrollbarOptions={{
            showArrows: false,
            trackOptions: {
              backgroundColor: colors.background,
              foregroundColor: colors.border,
            },
          }}
        >
          {entries.map((entry) => {
            const time = formatTimestamp(entry.timestamp)
            const source = entry.source.toUpperCase().padEnd(10)
            const levelLabel = getLevelLabel(entry.level).padEnd(8)
            const levelColor = getLevelColor(entry.level, colors)
            const sourceColor = getSourceColor(entry.source, colors)

            return (
              <text key={entry.id}>
                <span fg={colors.muted}>{time}</span>
                <span fg={colors.border}> │ </span>
                <span fg={sourceColor}>{source}</span>
                <span fg={colors.border}> │ </span>
                <span fg={levelColor}>{levelLabel}</span>
                <span fg={colors.text}>{entry.message}</span>
              </text>
            )
          })}
        </scrollbox>
      )}
    </box>
  )
}
