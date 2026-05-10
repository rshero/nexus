import { useEffect, useReducer } from "react"
import { useKeyboard } from "@opentui/react"
import type { ConnectionConfig, DbType } from "../../db/types.ts"
import { DEFAULT_PORTS } from "../../db/types.ts"
import { parseConnectionUrl } from "../../db/url.ts"
import { debug } from "../../utils/debug.ts"
import { wrapDbTypeRows } from "./dbTypeRows.ts"
import { useTheme } from "../../theme/ThemeContext.tsx"

interface ConnectionFormProps {
  left?: number
  top?: number
  editMode?: boolean
  existingConfig?: ConnectionConfig
  onSubmit: (config: Omit<ConnectionConfig, "id">) => void
  onCancel: () => void
}

const DB_TYPES: { name: string; value: DbType }[] = [
  { name: "Elasticsearch", value: "elasticsearch" },
  { name: "MongoDB", value: "mongo" },
  { name: "MySQL", value: "mysql" },
  { name: "Postgres", value: "postgres" },
  { name: "Redis", value: "redis" },
]

const DEFAULT_DB_TYPE: DbType = DB_TYPES[0]!.value

const FIELD_COUNT = 9

type FormField = "name" | "url" | "host" | "port" | "username" | "password"

interface FormState {
  name: string
  dbType: DbType
  url: string
  host: string
  port: string
  username: string
  password: string
  tls: boolean
  focusIndex: number
  urlError: string
}

type FormAction =
  | { type: "setField"; field: FormField; value: string }
  | { type: "setTls"; value: boolean }
  | { type: "setDbType"; value: DbType; updateDefaultPort: boolean }
  | { type: "setFocusIndex"; value: number }
  | {
      type: "syncFromUrl"
      payload: {
        urlError: string
        host?: string
        port?: string
        username?: string
        password?: string
        tls?: boolean
      }
    }

function buildInitialState(existingConfig?: ConnectionConfig): FormState {
  const initialDbType = existingConfig?.type ?? DEFAULT_DB_TYPE

  return {
    name: existingConfig?.name ?? "",
    dbType: initialDbType,
    url: existingConfig?.url ?? "",
    host: existingConfig?.host ?? "localhost",
    port: String(existingConfig?.port ?? DEFAULT_PORTS[initialDbType]),
    username: existingConfig?.username ?? "",
    password: existingConfig?.password ?? "",
    tls: existingConfig?.tls ?? false,
    focusIndex: 0,
    urlError: "",
  }
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "setField":
      return { ...state, [action.field]: action.value }
    case "setTls":
      return { ...state, tls: action.value }
    case "setDbType":
      return {
        ...state,
        dbType: action.value,
        port: action.updateDefaultPort ? String(DEFAULT_PORTS[action.value]) : state.port,
      }
    case "setFocusIndex":
      return { ...state, focusIndex: action.value }
    case "syncFromUrl":
      return {
        ...state,
        urlError: action.payload.urlError,
        host: action.payload.host ?? state.host,
        port: action.payload.port ?? state.port,
        username: action.payload.username ?? state.username,
        password: action.payload.password ?? state.password,
        tls: action.payload.tls ?? state.tls,
      }
    default:
      return state
  }
}

export function ConnectionForm({ left, top, editMode = false, existingConfig, onSubmit, onCancel }: ConnectionFormProps) {
  const { colors } = useTheme()
  const [state, dispatch] = useReducer(reducer, existingConfig, buildInitialState)

  const { name, dbType, url, host, port, username, password, tls, focusIndex, urlError } = state
  const hasUrl = url.trim().length > 0

  useEffect(() => {
    if (!hasUrl) {
      dispatch({ type: "syncFromUrl", payload: { urlError: "" } })
      return
    }

    const result = parseConnectionUrl(url, dbType)
    if (!result.valid) {
      dispatch({ type: "syncFromUrl", payload: { urlError: result.error ?? "Invalid URL" } })
      return
    }

    const parsed = result.parsed!
    dispatch({
      type: "syncFromUrl",
      payload: {
        urlError: "",
        host: parsed.host,
        port: String(parsed.port),
        username: parsed.username ?? "",
        password: parsed.password ?? "",
        tls: parsed.tls,
      },
    })
  }, [url, dbType, hasUrl])

  const disabledFields = hasUrl ? new Set([3, 4, 5, 6]) : new Set<number>()

  useKeyboard((key) => {
    debug(`[ConnectionForm] key pressed: name="${key.name}", focusIndex=${focusIndex}, hasUrl=${hasUrl}, urlError="${urlError}"`)

    if (key.name === "escape") {
      onCancel()
      return
    }

    if (key.name === "tab") {
      dispatch({
        type: "setFocusIndex",
        value: (() => {
          const dir = key.shift ? -1 : 1
          let next = (focusIndex + dir + FIELD_COUNT) % FIELD_COUNT
          while (disabledFields.has(next)) {
            next = (next + dir + FIELD_COUNT) % FIELD_COUNT
          }
          debug(`[ConnectionForm] tab: focusIndex ${focusIndex} -> ${next} (shift=${key.shift})`)
          return next
        })(),
      })
      return
    }

    if (key.name === "return") {
      debug(`[ConnectionForm] enter pressed: focusIndex=${focusIndex}, expected=8, match=${focusIndex === 8}`)

      if (focusIndex === 7) {
        dispatch({ type: "setTls", value: !tls })
        return
      }

      if (focusIndex === 8) {
        if (hasUrl && urlError) {
          debug(`[ConnectionForm] blocked: URL has error: "${urlError}"`)
          return
        }

        const config = {
          name: name || `${dbType} connection`,
          type: dbType,
          host,
          port: parseInt(port, 10) || DEFAULT_PORTS[dbType],
          username: username || undefined,
          password: password || undefined,
          tls,
          url: hasUrl ? url.trim() : undefined,
        }
        debug(`[ConnectionForm] calling onSubmit with:`, JSON.stringify(config))
        onSubmit(config)
      }
      return
    }

    if (focusIndex === 1 && (key.name === "left" || key.name === "right" || key.name === "j" || key.name === "k")) {
      const currentIdx = DB_TYPES.findIndex((t) => t.value === dbType)
      const dir = key.name === "left" || key.name === "k" ? -1 : 1
      const nextIdx = (currentIdx + dir + DB_TYPES.length) % DB_TYPES.length
      const next = DB_TYPES[nextIdx]!

      dispatch({ type: "setDbType", value: next.value, updateDefaultPort: !hasUrl })
      return
    }

    if (focusIndex === 7 && (key.name === "left" || key.name === "right" || key.name === "j" || key.name === "k" || key.name === "space")) {
      dispatch({ type: "setTls", value: !tls })
    }
  })

  const labelWidth = 11
  const inputWidth = 32
  const dbTypeRows = wrapDbTypeRows(DB_TYPES, inputWidth)
  const labelFg = colors.muted
  const activeLabelFg = colors.info
  const disabledFg = colors.border
  const inputBackground = colors.backgroundMuted
  const inputFocusedBackground = colors.surface
  const inputText = colors.textBright
  const focusBorder = colors.accent
  const selectedChipBg = colors.surfaceStrong
  const selectedChipFg = colors.textBright
  const actionBg = colors.surfaceStrong

  return (
    <box
      position="absolute"
      left={left ?? 2}
      top={top ?? 1}
      width={52}
      height={editMode ? 22 : 20}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={focusBorder}
      backgroundColor={colors.background}
      title=" New Connection "
      titleAlignment="center"
      zIndex={100}
    >
      <box flexDirection="column" padding={1} gap={0}>
        {editMode && (
          <box flexDirection="row" marginBottom={1}>
            <text fg={colors.warning}>Editing: {existingConfig?.name}</text>
          </box>
        )}
        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={focusIndex === 0 ? activeLabelFg : labelFg}>
            Name
          </text>
          <input
            value={name}
            onChange={(value) => dispatch({ type: "setField", field: "name", value })}
            placeholder="My Database"
            focused={focusIndex === 0}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={inputFocusedBackground}
            textColor={inputText}
          />
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={focusIndex === 1 ? activeLabelFg : labelFg}>
            Type
          </text>
          <box flexDirection="column" width={inputWidth}>
            {dbTypeRows.map((row, rowIndex) => (
              <box key={`type-row-${rowIndex}`} flexDirection="row" gap={1}>
                {row.map((t) => (
                  <text key={t.value} fg={dbType === t.value ? selectedChipFg : colors.text} bg={dbType === t.value ? selectedChipBg : colors.surface}>
                    {" "}
                    {t.name}{" "}
                  </text>
                ))}
              </box>
            ))}
          </box>
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={focusIndex === 2 ? activeLabelFg : labelFg}>
            URL
          </text>
          <input
            value={url}
            onChange={(value) => dispatch({ type: "setField", field: "url", value })}
            placeholder="mongodb://user:pass@host:port/db"
            focused={focusIndex === 2}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={inputFocusedBackground}
            textColor={inputText}
          />
        </box>

        {hasUrl && urlError ? (
          <box flexDirection="row" gap={1}>
            <text width={labelWidth}>{" "}</text>
            <text fg={colors.error} width={inputWidth}>
              {urlError}
            </text>
          </box>
        ) : null}

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={hasUrl ? disabledFg : focusIndex === 3 ? activeLabelFg : labelFg}>
            Host
          </text>
          <input
            value={host}
            onChange={hasUrl ? () => {} : (value) => dispatch({ type: "setField", field: "host", value })}
            placeholder="localhost"
            focused={!hasUrl && focusIndex === 3}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={hasUrl ? inputBackground : inputFocusedBackground}
            textColor={hasUrl ? disabledFg : inputText}
          />
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={hasUrl ? disabledFg : focusIndex === 4 ? activeLabelFg : labelFg}>
            Port
          </text>
          <input
            value={port}
            onChange={hasUrl ? () => {} : (value) => dispatch({ type: "setField", field: "port", value })}
            placeholder={String(DEFAULT_PORTS[dbType])}
            focused={!hasUrl && focusIndex === 4}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={hasUrl ? inputBackground : inputFocusedBackground}
            textColor={hasUrl ? disabledFg : inputText}
          />
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={hasUrl ? disabledFg : focusIndex === 5 ? activeLabelFg : labelFg}>
            Username
          </text>
          <input
            value={username}
            onChange={hasUrl ? () => {} : (value) => dispatch({ type: "setField", field: "username", value })}
            placeholder="optional"
            focused={!hasUrl && focusIndex === 5}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={hasUrl ? inputBackground : inputFocusedBackground}
            textColor={hasUrl ? disabledFg : inputText}
          />
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={hasUrl ? disabledFg : focusIndex === 6 ? activeLabelFg : labelFg}>
            Password
          </text>
          <input
            value={focusIndex === 6 ? password : password.replace(/./g, "*")}
            onChange={hasUrl ? () => {} : (value) => dispatch({ type: "setField", field: "password", value })}
            placeholder="optional"
            focused={!hasUrl && focusIndex === 6}
            width={inputWidth}
            backgroundColor={inputBackground}
            focusedBackgroundColor={hasUrl ? inputBackground : inputFocusedBackground}
            textColor={hasUrl ? disabledFg : inputText}
          />
        </box>

        <box flexDirection="row" gap={1}>
          <text width={labelWidth} fg={focusIndex === 7 ? activeLabelFg : labelFg}>
            TLS/SSL
          </text>
          <box width={inputWidth} flexDirection="row" gap={1}>
            <text fg={focusIndex === 7 ? selectedChipFg : colors.text} bg={focusIndex === 7 ? selectedChipBg : colors.surface}>
              {tls ? " Enabled " : " Disabled "}
            </text>
            <text fg={colors.muted}>(Space/Enter to toggle)</text>
          </box>
        </box>

        <box flexDirection="row" gap={1} marginTop={1}>
          <text width={labelWidth}>{" "}</text>
          <box width={inputWidth} backgroundColor={focusIndex === 8 ? actionBg : colors.surface} justifyContent="center">
            <text fg={focusIndex === 8 ? selectedChipFg : colors.text}> Save Connection </text>
          </box>
        </box>
      </box>

      <box paddingX={1}>
        <text fg={colors.info}>
          <span fg={colors.accent}>[Tab]</span> Next {"  "}
          <span fg={colors.accent}>[Enter]</span> Save {"  "}
          <span fg={colors.accent}>[Esc]</span> Cancel
        </text>
      </box>
    </box>
  )
}
