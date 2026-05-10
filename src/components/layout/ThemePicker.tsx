import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { CenteredModal } from "./CenteredModal.tsx"
import { useTheme } from "../../theme/ThemeContext.tsx"
import { THEME_ORDER, THEMES, type ThemeColors, type ThemeName } from "../../theme/themes.ts"

interface ThemePickerProps {
  visible: boolean
  width: number
  height: number
  currentTheme: ThemeName
  committedTheme: ThemeName
  onPreview: (themeName: ThemeName) => void
  onSelect: (themeName: ThemeName) => void
  onCancel: () => void
}

function ThemeSwatch({ colors }: { colors: ThemeColors }) {
  return (
    <text>
      <span fg={colors.accent}>●</span>
      <span fg={colors.success}>●</span>
      <span fg={colors.warning}>●</span>
      <span fg={colors.error}>●</span>
      <span fg={colors.purple}>●</span>
    </text>
  )
}

export function ThemePicker({
  visible,
  width,
  height,
  currentTheme,
  committedTheme,
  onPreview,
  onSelect,
  onCancel,
}: ThemePickerProps) {
  const { colors } = useTheme()
  const [selected, setSelected] = useState(0)
  const openedAtRef = useRef(0)
  const lastPreviewRef = useRef<ThemeName | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!visible) return
    openedAtRef.current = Date.now()
    lastPreviewRef.current = null
    initializedRef.current = false
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const currentIndex = Math.max(0, THEME_ORDER.indexOf(committedTheme))
    setSelected(currentIndex)
  }, [visible, committedTheme])

  useEffect(() => {
    if (!visible) return
    const themeName = THEME_ORDER[selected] ?? currentTheme
    if (!initializedRef.current && themeName !== committedTheme) return
    initializedRef.current = true
    if (lastPreviewRef.current !== themeName) {
      lastPreviewRef.current = themeName
      onPreview(themeName)
    }
  }, [visible, selected, currentTheme, committedTheme, onPreview])

  useKeyboard((key) => {
    if (!visible) return
    if (Date.now() - openedAtRef.current < 120) return

    const isRepeat = key.eventType === "repeat" || key.repeated
    if (isRepeat) return

    if (key.name === "escape") {
      onCancel()
      return
    }

    if (key.name === "up" || key.name === "k") {
      setSelected((prev) => Math.max(0, prev - 1))
      return
    }

    if (key.name === "down" || key.name === "j") {
      setSelected((prev) => Math.min(THEME_ORDER.length - 1, prev + 1))
      return
    }

    if (key.name === "return" || key.name === "enter") {
      const themeName = THEME_ORDER[selected] ?? currentTheme
      onSelect(themeName)
      return
    }
  })

  if (!visible) return null

  const selectedTheme = THEME_ORDER[selected] ?? currentTheme
  const selectedDefinition = THEMES[selectedTheme]

  return (
    <CenteredModal
      width={width}
      height={height}
      minWidth={48}
      maxWidth={66}
      minHeight={10}
      maxHeight={13}
      widthPadding={10}
      heightPadding={8}
      title="Theme"
      onPaste={() => {}}
    >
      <box height={1} paddingX={1} flexDirection="row" justifyContent="space-between">
        <text fg={colors.muted}>
          Previewing: <span fg={colors.textBright}>{selectedDefinition.label}</span>
        </text>
        <ThemeSwatch colors={selectedDefinition.colors} />
      </box>
      <box height={1} paddingX={1}>
        <text fg={colors.border}>{"─".repeat(200)}</text>
      </box>
      <box height={THEME_ORDER.length} flexDirection="column" paddingX={1}>
        {THEME_ORDER.map((themeName, index) => {
          const active = index === selected
          const theme = THEMES[themeName]
          return (
            <box
              key={themeName}
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={active ? colors.surfaceAlt : undefined}
            >
              <text fg={active ? colors.textBright : colors.text}>{theme.label}</text>
              <ThemeSwatch colors={theme.colors} />
            </box>
          )
        })}
      </box>
      <box height={1} paddingX={1}>
        <text fg={colors.info}>
          <span fg={colors.accent}>[↑/↓]</span> Preview{"  "}
          <span fg={colors.accent}>[Enter]</span> Apply{"  "}
          <span fg={colors.accent}>[Esc]</span> Cancel
        </text>
      </box>
    </CenteredModal>
  )
}
