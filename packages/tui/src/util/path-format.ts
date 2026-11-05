import path from "path"
import { graphemes, truncateWidth } from "./locale"
import { stringWidth } from "./string-width"

const LOCATION_SEPARATOR = " · "
const MIN_TITLE_CHARACTERS = 25

function truncateCharacters(value: string, max: number) {
  const characters = graphemes(value)
  if (characters.length <= max) return value
  return characters.slice(0, Math.max(0, max - 1)).join("") + "…"
}

/**
 * Bottom-left prompt footer label: session title first, then the directory basename.
 * When the full pair does not fit, keep at least `minTitleCharacters` characters of the
 * title and compress the directory instead of the title.
 */
export function promptLocationLabel(
  title: string | undefined,
  directory: string,
  width = Infinity,
  minTitleCharacters = MIN_TITLE_CHARACTERS,
) {
  const basename = path.basename(directory) || directory
  if (!title) return truncateWidth(basename, width)
  const full = `${title}${LOCATION_SEPARATOR}${basename}`
  if (stringWidth(full) <= width) return full

  const shownTitle = truncateCharacters(title, minTitleCharacters)
  const remaining = Math.max(1, width - stringWidth(shownTitle) - stringWidth(LOCATION_SEPARATOR))
  return `${shownTitle}${LOCATION_SEPARATOR}${truncateWidth(basename, remaining)}`
}

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const paths = windowsPath(home) ? path.win32 : path.posix
  const relative = paths.relative(home, input)
  if (!relative) return "~"
  if (relative === ".." || relative.startsWith(".." + paths.sep) || paths.isAbsolute(relative)) return input
  return "~/" + relative.split(paths.sep).join("/")
}

export function formatPath(
  input: string | undefined,
  options: { base: string; home?: string; forwardSlashes?: boolean },
) {
  if (!input) return ""
  const windows = windowsPath(options.base)
  if (!windows && windowsPath(input)) {
    return options.forwardSlashes ? input.replaceAll("\\", "/") : input
  }

  const paths = windows ? path.win32 : path.posix
  const absolute = paths.isAbsolute(input) ? input : paths.resolve(options.base, input)
  const relative = paths.relative(options.base, absolute)
  const formatted = !relative
    ? "."
    : relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative)
      ? relative
      : options.home
        ? abbreviateHome(absolute, options.home)
        : absolute
  return options.forwardSlashes ? formatted.replaceAll("\\", "/") : formatted
}

function windowsPath(input: string) {
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")
}
