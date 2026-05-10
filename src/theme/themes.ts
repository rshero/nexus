export type ThemeName =
  | "tokyo-night"
  | "dracula"
  | "t3chat"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"

export interface ThemeColors {
  overlay: string
  background: string
  backgroundMuted: string
  surface: string
  surfaceAlt: string
  surfaceStrong: string
  completionBackground: string
  completionSurface: string
  border: string
  muted: string
  text: string
  textBright: string
  accent: string
  info: string
  success: string
  warning: string
  error: string
  purple: string
  teal: string
}

export interface ThemeDefinition {
  name: ThemeName
  label: string
  colors: ThemeColors
}

export const THEMES: Record<ThemeName, ThemeDefinition> = {
  "tokyo-night": {
    name: "tokyo-night",
    label: "Tokyo Night",
    colors: {
      overlay: "#000000",
      background: "#1a1b26",
      backgroundMuted: "#16161e",
      surface: "#24283b",
      surfaceAlt: "#292e42",
      surfaceStrong: "#3b4261",
      completionBackground: "#16161e",
      completionSurface: "#24283b",
      border: "#414868",
      muted: "#565f89",
      text: "#a9b1d6",
      textBright: "#c0caf5",
      accent: "#7aa2f7",
      info: "#7dcfff",
      success: "#9ece6a",
      warning: "#e0af68",
      error: "#f7768e",
      purple: "#bb9af7",
      teal: "#73daca",
    },
  },
  dracula: {
    name: "dracula",
    label: "Dracula",
    colors: {
      overlay: "#191a21",
      background: "#282a36",
      backgroundMuted: "#21222c",
      surface: "#343746",
      surfaceAlt: "#44475a",
      surfaceStrong: "#54576b",
      completionBackground: "#21222c",
      completionSurface: "#343746",
      border: "#6272a4",
      muted: "#7f86a6",
      text: "#d6d6e5",
      textBright: "#f8f8f2",
      accent: "#bd93f9",
      info: "#8be9fd",
      success: "#50fa7b",
      warning: "#f1fa8c",
      error: "#ff5555",
      purple: "#bd93f9",
      teal: "#8be9fd",
    },
  },
  t3chat: {
    name: "t3chat",
    label: "T3Chat",
    colors: {
      overlay: "#100a0e",
      background: "#221d27",
      backgroundMuted: "#28222d",
      surface: "#2c2632",
      surfaceAlt: "#362d3d",
      surfaceStrong: "#463753",
      completionBackground: "#100a0e",
      completionSurface: "#2c2632",
      border: "#3b3237",
      muted: "#c2b6cf",
      text: "#d2c4de",
      textBright: "#f8f1f5",
      accent: "#db2777",
      info: "#efc0d8",
      success: "#efc0d8",
      warning: "#e88c30",
      error: "#e23670",
      purple: "#a84370",
      teal: "#c2b6cf",
    },
  },
  "catppuccin-latte": {
    name: "catppuccin-latte",
    label: "Catppuccin Latte",
    colors: {
      overlay: "#dce0e8",
      background: "#eff1f5",
      backgroundMuted: "#e6e9ef",
      surface: "#ccd0da",
      surfaceAlt: "#bcc0cc",
      surfaceStrong: "#acb0be",
      completionBackground: "#dce0e8",
      completionSurface: "#ccd0da",
      border: "#8c8fa1",
      muted: "#6c6f85",
      text: "#5c5f77",
      textBright: "#4c4f69",
      accent: "#8839ef",
      info: "#1e66f5",
      success: "#40a02b",
      warning: "#df8e1d",
      error: "#d20f39",
      purple: "#8839ef",
      teal: "#179299",
    },
  },
  "catppuccin-frappe": {
    name: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    colors: {
      overlay: "#232634",
      background: "#303446",
      backgroundMuted: "#292c3c",
      surface: "#414559",
      surfaceAlt: "#51576d",
      surfaceStrong: "#626880",
      completionBackground: "#232634",
      completionSurface: "#414559",
      border: "#838ba7",
      muted: "#737994",
      text: "#b5bfe2",
      textBright: "#c6d0f5",
      accent: "#ca9ee6",
      info: "#8caaee",
      success: "#a6d189",
      warning: "#e5c890",
      error: "#e78284",
      purple: "#ca9ee6",
      teal: "#81c8be",
    },
  },
  "catppuccin-macchiato": {
    name: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    colors: {
      overlay: "#181926",
      background: "#24273a",
      backgroundMuted: "#1e2030",
      surface: "#363a4f",
      surfaceAlt: "#494d64",
      surfaceStrong: "#5b6078",
      completionBackground: "#181926",
      completionSurface: "#363a4f",
      border: "#8087a2",
      muted: "#6e738d",
      text: "#b8c0e0",
      textBright: "#cad3f5",
      accent: "#c6a0f6",
      info: "#8aadf4",
      success: "#a6da95",
      warning: "#eed49f",
      error: "#ed8796",
      purple: "#c6a0f6",
      teal: "#8bd5ca",
    },
  },
  "catppuccin-mocha": {
    name: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    colors: {
      overlay: "#11111b",
      background: "#1e1e2e",
      backgroundMuted: "#181825",
      surface: "#313244",
      surfaceAlt: "#45475a",
      surfaceStrong: "#585b70",
      completionBackground: "#11111b",
      completionSurface: "#313244",
      border: "#7f849c",
      muted: "#6c7086",
      text: "#bac2de",
      textBright: "#cdd6f4",
      accent: "#cba6f7",
      info: "#89b4fa",
      success: "#a6e3a1",
      warning: "#f9e2af",
      error: "#f38ba8",
      purple: "#cba6f7",
      teal: "#94e2d5",
    },
  },
}

export const THEME_ORDER: ThemeName[] = [
  "tokyo-night",
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dracula",
  "t3chat",
]

export function getNextThemeName(current: ThemeName): ThemeName {
  const index = THEME_ORDER.indexOf(current)
  const next = (index + 1) % THEME_ORDER.length
  return THEME_ORDER[next] ?? "tokyo-night"
}
