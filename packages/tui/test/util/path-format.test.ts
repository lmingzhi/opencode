import { expect, test } from "bun:test"
import { formatPath, promptLocationLabel } from "../../src/util/path-format"

test("formats relative, home, and foreign paths", () => {
  expect(formatPath(".", { base: "/work/project" })).toBe(".")
  expect(formatPath("../shared/a.ts", { base: "/work/project" })).toBe("/work/shared/a.ts")
  expect(formatPath("/home/test/project", { base: "/work", home: "/home/test" })).toBe("~/project")
  expect(formatPath("src\\a.ts", { base: "/work", forwardSlashes: true })).toBe("src/a.ts")
  expect(formatPath("C:/", { base: "/work" })).toBe("C:/")
  expect(formatPath("C:\\Users\\tester", { base: "/work", forwardSlashes: true })).toBe("C:/Users/tester")
  expect(formatPath("..\\shared\\a.ts", { base: "C:\\work\\project", forwardSlashes: true })).toBe(
    "C:/work/shared/a.ts",
  )
  expect(formatPath("C:\\Users\\test\\project", { base: "C:\\work", home: "C:\\Users\\test" })).toBe("~/project")
})

test("puts the session title before the directory basename in the prompt footer", () => {
  expect(promptLocationLabel("Demo session", "/Users/me/work/iflyplus")).toBe("Demo session · iflyplus")
  expect(promptLocationLabel(undefined, "/Users/me/work/iflyplus")).toBe("iflyplus")
  expect(promptLocationLabel("Demo session", "/")).toBe("Demo session · /")
})

test("truncates a long session title without hiding the directory basename", () => {
  expect(promptLocationLabel("a-very-long-session-title-that-does-not-fit", "/workspace")).toBe(
    "a-very-long-session… · workspace",
  )
})
