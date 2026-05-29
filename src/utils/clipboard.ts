interface ClipboardRenderer {
  copyToClipboardOSC52(text: string): boolean
  isOsc52Supported(): boolean
}

interface RendererWithOutput extends ClipboardRenderer {
  writeOut?: (chunk: string) => void
}

export interface ClipboardCopyResult {
  copied: boolean
  osc52Supported: boolean
  rendererCopied: boolean
  fallbackAttempted: boolean
  fallbackCopied: boolean
  payloadBytes: number
  base64Bytes: number
  error?: string
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function copyWithDirectOsc52(renderer: RendererWithOutput, text: string): { copied: boolean; base64Bytes: number } {
  const payload = Buffer.from(text).toString("base64")
  renderer.writeOut?.(`\x1b]52;c;${payload}\x07`)
  return { copied: typeof renderer.writeOut === "function", base64Bytes: getByteLength(payload) }
}

export function copyTextToClipboard(renderer: ClipboardRenderer, text: string): ClipboardCopyResult {
  const payloadBytes = getByteLength(text)
  let base64Bytes = 0
  let osc52Supported = false
  let rendererCopied = false
  let fallbackAttempted = false
  let fallbackCopied = false

  try {
    osc52Supported = renderer.isOsc52Supported()
    rendererCopied = renderer.copyToClipboardOSC52(text)

    if (!rendererCopied) {
      fallbackAttempted = true
      const fallback = copyWithDirectOsc52(renderer as RendererWithOutput, text)
      fallbackCopied = fallback.copied
      base64Bytes = fallback.base64Bytes
    }

    return {
      copied: rendererCopied || fallbackCopied,
      osc52Supported,
      rendererCopied,
      fallbackAttempted,
      fallbackCopied,
      payloadBytes,
      base64Bytes,
    }
  } catch (error) {
    return {
      copied: false,
      osc52Supported,
      rendererCopied,
      fallbackAttempted,
      fallbackCopied,
      payloadBytes,
      base64Bytes,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
