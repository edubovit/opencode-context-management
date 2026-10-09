import { HueStep, MarkdownToken, SyntaxToken, parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"

export function themeFixture(mode: "dark" | "light" = "dark") {
  const primary = "#aaccff"
  const muted = "#8899aa"
  const actions = { primary: { base: primary }, secondary: { base: muted }, destructive: { base: "#ff0000" } }
  const feedback = Object.fromEntries(["info", "warning", "success", "error"].map((kind) => [kind, { base: primary, muted }]))
  const backgrounds = { added: "#112233", removed: "#332211", context: "#101014" }
  const scale = (color: string) => Object.fromEntries(HueStep.literals.map((step) => [step, color]))
  const hue = { accent: scale("#ff0000"), interactive: scale("#00ff00"), neutral: scale(muted) }
  return resolveThemeDocument(parseThemeDocument({
    base: {
      categorical: ["accent"],
      text: { base: "#eeeeee", muted, action: actions, formfield: { base: "#dddddd", $focused: primary }, feedback },
      background: { base: "#101014", raised: { base: "#202028", high: "#303038", max: "#404048" }, action: actions, formfield: { base: "#101014", $selected: "#202028" }, feedback },
      border: { base: muted }, scrollbar: { base: muted },
      diff: { text: { ...backgrounds, hunkHeader: muted }, background: backgrounds, highlight: backgrounds, lineNumber: { text: muted, background: backgrounds } },
      syntax: Object.fromEntries(SyntaxToken.literals.map((token) => [token, "$hue.neutral.500"])),
      markdown: Object.fromEntries(MarkdownToken.literals.map((token) => [token, "$hue.neutral.500"])),
    },
    dark: { hue },
    light: { hue, text: { base: "#101014" }, background: { base: "#ffffff" } },
  }), mode)
}
