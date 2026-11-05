import type { Endpoint } from "@opencode/client/effect/service"
import { Effect } from "effect"
import path from "node:path"
import { Standalone } from "../services/standalone"
import { errorMessage } from "../util/error"
import { reportRunError, runNonInteractiveWithOptions, type RunCommandInput } from "./run"

export type V1RunCommandInput = {
  message: string[]
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  format: "default" | "json"
  file: string[]
  title?: string
  server?: string
  password?: string
  username?: string
  directory?: string
  variant?: string
  thinking?: boolean
  dangerouslySkipPermissions?: boolean
  standaloneCommand?: ReadonlyArray<string>
}

export function runV1Bridge(input: V1RunCommandInput) {
  const root = process.env.PWD ?? process.cwd()
  const attached = input.server !== undefined
  const local = !attached && input.directory ? path.resolve(root, input.directory) : root
  try {
    process.chdir(local)
  } catch {
    reportRunError(input, `Failed to change directory to ${local}`)
    return Promise.resolve()
  }

  // The V1 CLI has no signal handling of its own: the first Ctrl-C interrupts the Session, a second exits.
  const controller = new AbortController()
  const interrupt = () => {
    if (controller.signal.aborted) process.exit(130)
    process.exitCode = 130
    controller.abort()
  }
  process.on("SIGINT", interrupt)
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = attached
          ? explicitEndpoint(input)
          : yield* Standalone.start({ command: input.standaloneCommand })
        yield* Effect.promise(() =>
          runNonInteractiveWithOptions(
            nativeInput(input, endpoint),
            {
              root: local,
              directory: attached ? input.directory : local,
              useServerDirectory: attached && input.directory === undefined,
              variant: input.variant,
              attached,
              compatibility: "v1",
            },
            controller.signal,
          ),
        )
      }),
    ),
  )
    .catch((error) => reportRunError(input, errorMessage(error)))
    .finally(() => process.off("SIGINT", interrupt))
}

function nativeInput(input: V1RunCommandInput, endpoint: Endpoint): RunCommandInput {
  return {
    server: { endpoint },
    message: input.message,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    model: input.model,
    agent: input.agent,
    format: input.format,
    file: input.file,
    title: input.title,
    thinking: input.thinking,
    auto: input.dangerouslySkipPermissions,
  }
}

function explicitEndpoint(input: V1RunCommandInput): Endpoint {
  const url = input.server
  if (!url) throw new Error("Missing V1 server URL")
  return {
    url,
    auth: input.password
      ? { type: "basic", username: input.username ?? "opencode", password: input.password }
      : undefined,
  }
}
