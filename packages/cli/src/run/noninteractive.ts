import {
  ClientError,
  type EventSubscribeOutput,
  type ExperimentalJobListOutput,
  type JsonValue,
  type LocationRef,
  type OpenCodeClient,
  type PermissionRequest,
  type SessionMessageAssistantTool,
  type SessionMessageIdle,
  type SessionMessageInfo,
  type ToolContent,
} from "@opencode/client/promise"
import { SessionMessage } from "@opencode/schema/session-message"
import { EOL } from "node:os"
import { readFile } from "node:fs/promises"
import { nonEmptyToolContent, toolOutputText, type MiniToolPart } from "@opencode/tui/mini/tool"
import { UI } from "./ui"

type File = {
  url: string
  filename: string
  mime: string
}

type Input = {
  client: OpenCodeClient
  sessionID: string
  location: LocationRef
  message: string
  files: File[]
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  thinking: boolean
  format: "default" | "json"
  auto: boolean
  /** True when the client is attached to a shared server rather than an exclusive in-process one. */
  attached: boolean
  compatibility?: "v1"
  /** Aborted on SIGINT or SIGTERM: the run cancels its Session and background jobs, then returns. */
  signal: AbortSignal
  renderTool: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError: (part: SessionMessageAssistantTool) => Promise<void>
}

type StartedPart = {
  id: string
  timestamp: number
}

type ToolState = StartedPart & {
  assistantMessageID: string
  tool: string
  input: Record<string, JsonValue>
  raw?: string
  provider?: unknown
  native?: SessionMessageAssistantTool["native"]
  metadata: Record<string, JsonValue>
  content: ToolContent[]
}

type V2Event = EventSubscribeOutput
type FormRequest = Extract<V2Event, { type: "form.created" }>["data"]["form"]
type Job = ExperimentalJobListOutput[number]
type RunError = { type: string; message: string }
type Outcome = Pick<SessionMessageIdle, "id" | "outcome" | "error">

// MCP elicitations are temporarily owned by the "global" sentinel instead of a real
// session. An exclusive local process may treat them as this run's blockers; an
// attached client must not cancel input that may belong to another session.
const GLOBAL_FORM_SESSION_ID = "global"

const QUESTION_CANCELLED_FEEDBACK =
  "This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them."

const PERMISSION_REJECTED_FEEDBACK =
  "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."

// A background job that never exits (a dev server, a watcher) would otherwise hold the run open forever.
const BACKGROUND_LIMIT_MINUTES = 10

/**
 * Runs one prompt to completion:
 *
 *   admitting → running → settling → waiting for this prompt's jobs → done(exit code)
 *   any state + abort (SIGINT/SIGTERM) → cancelling → done
 */
export async function runNonInteractivePrompt(input: Input) {
  const controller = new AbortController()
  const stream = input.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  if ((await stream.next()).done) throw new Error("Event stream disconnected before prompt admission")

  const v1 = input.compatibility === "v1"
  const messageID = SessionMessage.ID.create()
  const render = renderer(input)
  let promoted = false
  let admission: Promise<{ time: { created: number } }> | undefined
  let consuming: Promise<void> | undefined
  // Exit-code inputs, read once when the run is done.
  let formError: RunError | undefined
  let prePromotion: RunError | undefined
  const outcomes: Outcome[] = []
  // V1 compatibility keeps the frozen V1 failure rules.
  let v1Rejected = false
  let v1Errored = false
  let v1InvalidOutput = false

  // Sessions in this run's tree that own jobs. Their executions ending is when background state can change.
  const jobSessions = new Set([input.sessionID])
  let ends = 0
  let ended = Promise.withResolvers<void>()
  let cancelling = false
  let finalizing = false

  // Subagents run in child sessions; their asks and questions belong to this run too. Other
  // sessions on a shared server (e.g. the TUI's) must be left alone.
  const owned = new Map<string, Promise<boolean>>([[input.sessionID, Promise.resolve(true)]])
  const ownsSession = (sessionID: string): Promise<boolean> => {
    const known = owned.get(sessionID)
    if (known) return known
    const result =
      sessionID === GLOBAL_FORM_SESSION_ID
        ? Promise.resolve(false)
        : input.client.session
            .get({ sessionID })
            .then((session) => (session.parentID ? ownsSession(session.parentID) : false))
            .catch(() => false)
    owned.set(sessionID, result)
    return result
  }

  const replyPermission = async (request: PermissionRequest) => {
    // Nobody can approve here. Outside V1 compatibility, reject with feedback so the tool fails
    // as ordinary model-visible output and the model continues without the action.
    if (!input.auto) {
      v1Rejected = v1
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL +
          `permission requested: ${request.action} (${request.resources.join(", ")}); auto-rejecting`,
      )
    }
    await input.client.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.id,
        decision: input.auto ? "once" : "reject",
        ...(!input.auto && !v1 ? { message: PERMISSION_REJECTED_FEEDBACK } : {}),
      })
      .catch(() => {})
    if (v1 && !input.auto) await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
  }

  const cancelForm = async (request: Pick<FormRequest, "id" | "sessionID" | "title" | "metadata">) => {
    // Nobody can answer a question here. Outside V1 compatibility, cancel it with a message so the
    // question tool fails as ordinary model-visible output and the model continues without an answer.
    const continuing = request.metadata?.kind === "question" && !v1
    try {
      await input.client.session.form.cancel(
        {
          sessionID: request.sessionID,
          formID: request.id,
          ...(continuing ? { message: QUESTION_CANCELLED_FEEDBACK } : {}),
        },
        ...(request.sessionID === GLOBAL_FORM_SESSION_ID
          ? [{ headers: { "x-opencode-directory": encodeURIComponent(input.location.directory) } }]
          : []),
      )
    } catch (error) {
      if (!formAlreadySettled(error)) throw error
    }
    if (continuing) return
    v1Rejected = v1
    formError ??= { type: "unknown", message: `Cancelled a request for input this run cannot answer: ${request.title}` }
  }

  const blocker = async (event: V2Event) => {
    if (event.type === "permission.asked" && (await ownsSession(event.data.sessionID))) {
      await replyPermission(event.data)
      return true
    }
    if (
      event.type === "form.created" &&
      ((await ownsSession(event.data.form.sessionID)) ||
        (!input.attached &&
          event.data.form.sessionID === GLOBAL_FORM_SESSION_ID &&
          sameLocation(event.location, input.location)))
    ) {
      await cancelForm(event.data.form)
      return true
    }
    return false
  }

  const nextEvent = () =>
    stream.next().catch((error) => {
      if (controller.signal.aborted) return { done: true as const, value: undefined }
      throw error
    })

  const consume = async () => {
    while (true) {
      const next = await nextEvent()
      if (next.done) {
        if (controller.signal.aborted) return
        throw new Error("Event stream disconnected during prompt execution")
      }
      const event = next.value
      if (await blocker(event)) continue
      if (!("sessionID" in event.data)) continue
      const sessionID = event.data.sessionID
      if (event.type === "session.execution.started" && cancelling && jobSessions.has(sessionID))
        void input.client.session.interrupt({ sessionID }).catch(() => {})
      const terminal = terminalOutcome(event)
      if (terminal && jobSessions.has(sessionID)) {
        ends++
        ended.resolve()
        ended = Promise.withResolvers()
      }
      if (sessionID !== input.sessionID) continue
      if (event.type === "session.inbox.delivered" && event.data.inboxID === messageID) {
        promoted = true
        continue
      }
      // A busy period that ends before this prompt is delivered leaves the prompt queued for good.
      if (terminal && !promoted && terminal.error) prePromotion ??= terminal.error
      if (terminal && promoted) outcomes.push(terminal)
      if (!promoted || finalizing) continue
      if (event.type === "session.retry.scheduled") {
        render.retry(event)
        continue
      }
      await render.event(event)
    }
  }

  const v1Fail = (error: RunError, timestamp: number) => {
    v1Errored = true
    process.exitCode = 1
    render.error(error, timestamp)
  }

  const consumeV1 = async () => {
    while (true) {
      const next = await nextEvent()
      if (next.done) {
        if (v1Errored || input.signal.aborted) return
        throw new Error("Event stream disconnected during prompt execution")
      }
      const event = next.value
      if (await blocker(event)) continue
      if (!("sessionID" in event.data) || event.data.sessionID !== input.sessionID) continue
      if (event.type === "session.inbox.delivered" && event.data.inboxID === messageID) {
        promoted = true
        continue
      }
      if (
        event.type === "session.execution.interrupted" &&
        event.data.reason === "user" &&
        (input.signal.aborted || v1Rejected)
      )
        return
      if (!promoted) continue
      if (event.type === "session.tool.failed" && v1Rejected) continue
      if (event.type === "session.step.failed") {
        if (event.data.error.message === "The provider response ended unexpectedly.") {
          render.dropStep()
          v1InvalidOutput = true
          continue
        }
        if (input.signal.aborted || v1Rejected) continue
        render.flushStep()
        v1Fail(event.data.error, event.created)
        continue
      }
      if (event.type === "session.execution.failed") {
        if (v1InvalidOutput || v1Rejected) return
        render.flushStep()
        if (!v1Errored) v1Fail(event.data.error, event.created)
        return
      }
      if (event.type === "session.execution.interrupted") {
        if (!v1Rejected && event.data.reason !== "user" && !v1Errored)
          v1Fail({ type: "aborted", message: `Session interrupted: ${event.data.reason}` }, event.created)
        return
      }
      if (event.type === "session.execution.succeeded") return
      await render.event(event)
    }
  }

  // Jobs this prompt started, in this Session or its subagents. Older jobs (a dev server left by an
  // earlier run) belong to someone else and must neither hold this run open nor be cancelled by it.
  const jobs = async () => {
    const since = await admission?.then((admitted) => admitted.time.created)
    if (since === undefined) return []
    const list = await input.client.experimental.job
      .list({ sessionID: input.sessionID, descendants: true })
      .catch((error) => {
        // Servers older than the job list endpoint answer 404 with no JSON body; they have no jobs to report.
        if (error instanceof ClientError && error.reason === "UnsupportedContentType") return []
        throw error
      })
    const started = list.filter((job) => job.time.started >= since)
    started.forEach((job) => {
      jobSessions.add(job.sessionID)
      if (job.kind === "subagent") jobSessions.add(job.childSessionID)
    })
    return started
  }

  // Work moves from job to inbox to active execution: a finished job queues its wake before its row
  // is removed, and a session is active before it takes a queued wake. Reading in that order, one
  // read at a time, means work moving along can't slip between two reads. A failed read throws.
  const background = async () => {
    const running = await jobs()
    if (running.length > 0) return running
    const inboxes = await Promise.all(
      [...jobSessions].map((sessionID) => input.client.session.inbox.list({ sessionID })),
    )
    if (inboxes.some((inbox) => inbox.length > 0)) return running
    const active = await input.client.session.active()
    for (const sessionID of Object.keys(active)) {
      if (await ownsSession(sessionID)) return running
    }
    return undefined
  }

  // Resolves true once an execution in the tree has ended after `seen`, or false at the deadline.
  // Rejects if the event stream fails, since no end could be seen after that.
  const nextEnd = (seen: number, deadline = Infinity) =>
    ends > seen
      ? Promise.resolve(true)
      : Promise.race([
          ended.promise.then(() => true),
          consuming!.then(() => new Promise<boolean>(() => {})),
          ...(deadline === Infinity
            ? []
            : [new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deadline - Date.now()).unref())]),
        ])

  const admit = async (consumer: () => Promise<void>) => {
    if (input.agent) {
      await input.client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
    }
    const selected = input.model
      ? { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant }
      : input.variant
        ? await input.client.session
            .get({ sessionID: input.sessionID })
            .then((result) => result.model)
            .then(async (model) => {
              if (model) return { ...model, variant: input.variant }
              const result = await input.client.model.default()
              const fallback = result.data
              return fallback ? { providerID: fallback.providerID, id: fallback.id, variant: input.variant } : undefined
            })
        : undefined
    if (input.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
    if (selected) {
      await input.client.session.switchModel({ sessionID: input.sessionID, model: selected })
    }
    const prepared = await Promise.all(input.files.map(prepareFile))
    if (input.signal.aborted) return
    consuming = consumer()
    consuming.catch(() => {})
    admission = input.client.session.prompt({
      sessionID: input.sessionID,
      id: messageID,
      text: [input.message, ...prepared.flatMap((file) => (file.text ? [file.text] : []))].join("\n\n"),
      files: prepared.flatMap((file) => (file.attachment ? [file.attachment] : [])),
      delivery: "steer",
    })
    await admission
    const [permissions, forms, globals] = await Promise.all([
      input.client.permission.list({ sessionID: input.sessionID }).catch(() => undefined),
      input.client.session.form.list({ sessionID: input.sessionID }).catch(() => undefined),
      input.attached
        ? Promise.resolve(undefined)
        : input.client.form.list({ location: { directory: input.location.directory } }).catch(() => undefined),
    ])
    await Promise.all([
      ...(permissions ?? []).map(replyPermission),
      ...(forms ?? []).map(cancelForm),
      ...(globals && sameLocation(globals.location, input.location)
        ? globals.data.filter((form) => form.sessionID === GLOBAL_FORM_SESSION_ID).map(cancelForm)
        : []),
    ])
    return true
  }

  // running → settling → waiting for this prompt's jobs. Returns the projected turn once the Session is
  // idle with a recorded outcome and none of this prompt's work is left.
  const settle = async () => {
    if (!(await admit(consume))) return
    let shown = 0
    let deadline = Infinity
    while (!input.signal.aborted) {
      const seen = ends
      await input.client.experimental.session.wait({ sessionID: input.sessionID })
      if (input.signal.aborted) return
      const projected = await projectedMessages(input.client, input.sessionID, messageID)
      const recorded =
        formError || prePromotion || outcomes.length > 0 || projected.messages.some((item) => item.type === "idle")
      if (!recorded) {
        await nextEnd(seen)
        continue
      }
      const pending = formError || prePromotion ? undefined : await background()
      if (!pending) return { ...projected, background: deadline !== Infinity, timedOut: 0 }
      if (pending.length > 0 && pending.length !== shown) render.waiting(pending, BACKGROUND_LIMIT_MINUTES)
      shown = pending.length || shown
      deadline = Math.min(deadline, Date.now() + BACKGROUND_LIMIT_MINUTES * 60_000)
      if (!(await nextEnd(seen, deadline))) return { ...projected, background: true, timedOut: (await jobs()).length }
    }
  }

  // cancelling: stop the turn and the jobs this prompt started. A wake can still start after the
  // interrupt (this prompt's own, or the notice each cancelled job queues), so the consumer interrupts
  // every execution that starts until the tree is quiet.
  const cancel = async () => {
    cancelling = true
    finalizing = true
    await admission?.catch(() => {})
    if (!admission) return
    if (!promoted)
      await input.client.session.inbox.cancel({ sessionID: input.sessionID, inboxID: messageID }).catch(() => {})
    const running = await jobs().catch(() => [])
    await Promise.all([
      input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {}),
      ...running.map((job) =>
        (job.kind === "shell"
          ? input.client.shell.remove({ id: job.shellID, location: { directory: input.location.directory } })
          : job.kind === "subagent"
            ? input.client.session.interrupt({ sessionID: job.childSessionID })
            : Promise.resolve()
        ).catch(() => {}),
      ),
    ])
    while (true) {
      const seen = ends
      await input.client.experimental.session.wait({ sessionID: input.sessionID })
      const pending = await background()
      // Image jobs can't be cancelled through the API, so waiting on them would only hold the exit.
      if (!pending || (pending.length > 0 && pending.every((job) => job.kind === "image"))) return
      await nextEnd(seen)
    }
  }

  try {
    if (v1) {
      input.signal.addEventListener(
        "abort",
        () =>
          void input.client.session
            .interrupt({ sessionID: input.sessionID })
            .then((result) => {
              if (!result.interrupted) controller.abort()
            })
            .catch(() => controller.abort()),
        { once: true },
      )
      if (await admit(consumeV1)) await consuming
      return
    }

    const lifecycle = settle()
    const cancelled = new Promise<undefined>((resolve) =>
      input.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
    )
    const settled = await Promise.race([lifecycle, cancelled])
    // Requests failing during or after cancellation (the private server shutting down, the Session
    // already gone) say nothing about the run, so they are ignored.
    if (!settled) {
      lifecycle.catch(() => {})
      return await cancel().catch(() => {})
    }
    finalizing = true
    await render.reconcile(settled.messages)
    if (settled.timedOut) await cancel().catch(() => {})
    const error = finalError({ ...settled, formError, prePromotion }, outcomes)
    if (!error) return
    process.exitCode = 1
    render.error(error, Date.now())
  } finally {
    controller.abort()
    if (v1) await stream.return?.(undefined).catch(() => {})
    else void stream.return?.(undefined).catch(() => {})
  }
}

/** The run's exit code comes from here alone, chiefly from the first stored idle marker after this run's prompt. */
function finalError(
  run: {
    found: boolean
    messages: SessionMessageInfo[]
    background: boolean
    timedOut: number
    formError?: RunError
    prePromotion?: RunError
  },
  live: Outcome[],
) {
  if (run.formError) return run.formError
  if (run.prePromotion) return run.prePromotion
  if (run.timedOut)
    return {
      type: "unknown",
      message: `Stopped after waiting ${BACKGROUND_LIMIT_MINUTES} minutes for background jobs; cancelled ${run.timedOut} still running`,
    }
  if (!run.found) return { type: "unknown", message: "Prompt was not promoted" }
  const idles = run.messages.filter((message) => message.type === "idle")
  // The live terminal events stand in for idle markers only on a server that doesn't store them.
  const recorded = idles.length > 0 ? idles : live
  // The first marker closes this prompt's turn. Later ones count only as replies woken by this
  // prompt's background jobs; otherwise they belong to other prompts, possibly from another client.
  const turns = run.background ? recorded : recorded.slice(0, 1)
  const final = turns.find((turn) => turn.outcome !== "succeeded") ?? turns[0]
  if (!final) return { type: "unknown", message: "Session ended without a recorded outcome" }
  if (final.outcome === "succeeded") return
  return (
    final.error ??
    live.find((turn) => turn.id === final.id)?.error ??
    (final.outcome === "failed"
      ? { type: "unknown", message: "Session failed" }
      : { type: "aborted", message: "Session interrupted" })
  )
}

function terminalOutcome(event: V2Event): Outcome | undefined {
  const id = SessionMessage.ID.fromEvent(event.id)
  if (event.type === "session.execution.succeeded") return { id, outcome: "succeeded" }
  if (event.type === "session.execution.failed") return { id, outcome: "failed", error: event.data.error }
  if (event.type === "session.execution.interrupted")
    return {
      id,
      outcome: "interrupted",
      error: { type: "aborted", message: `Session interrupted: ${event.data.reason}` },
    }
  return undefined
}

async function projectedMessages(client: OpenCodeClient, sessionID: string, messageID: string) {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  while (true) {
    const page = await client.message.list(
      cursor ? { sessionID, limit: 200, cursor } : { sessionID, limit: 200, order: "desc" },
    )
    for (const message of page.data) {
      if (message.id === messageID) return { found: true, messages: messages.toReversed() }
      messages.push(message)
    }
    cursor = page.cursor.next ?? undefined
    if (!cursor) return { found: false, messages: [] }
  }
}

function renderer(input: Input) {
  const starts = new Map<string, StartedPart>()
  const tools = new Map<string, ToolState>()
  // Text and reasoning printed so far, by kind and content position.
  const rendered = new Map<string, string>()
  const renderedTools = new Set<string>()
  // Live step events stop being read once the session goes idle, and the last step usually ends after
  // that. Reconcile uses this to emit only the step_start/step_finish lines the live stream missed.
  const steps = new Map<string, "started" | "ended">()
  // V1 compatibility prints a step header only once the step produces something.
  let pendingStep: { timestamp: number; part: Record<string, unknown>; label: string } | undefined

  const emit = (type: string, timestamp: number, data: Record<string, unknown>) => {
    if (input.format !== "json") return false
    process.stdout.write(JSON.stringify({ type, timestamp, sessionID: input.sessionID, ...data }) + EOL)
    return true
  }

  const write = (kind: "text" | "reasoning", part: { text: string; [key: string]: unknown }, timestamp: number) => {
    if (emit(kind, timestamp, { part })) return
    const text = part.text.trim()
    if (!text) return
    const line = kind === "text" ? text : `Thinking: ${text}`
    if (!process.stdout.isTTY) return void process.stdout.write(line + EOL)
    UI.empty()
    UI.println(kind === "text" ? line : `${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
    UI.empty()
  }

  const writeStep = (timestamp: number, part: Record<string, unknown>, label: string) => {
    if (emit("step_start", timestamp, { part })) return
    UI.empty()
    UI.println(label)
    UI.empty()
  }

  const flushStep = () => {
    if (!pendingStep) return
    const value = pendingStep
    pendingStep = undefined
    writeStep(value.timestamp, value.part, value.label)
  }

  const renderFailedTool = async (tool: SessionMessageAssistantTool & { state: { status: "error" } }) => {
    if (tool.state.content && toolOutputText(tool.name, tool.state.content).trim())
      await input.renderTool({
        ...tool,
        state: {
          status: "completed",
          input: tool.state.input,
          metadata: tool.state.metadata,
          content: tool.state.content,
        },
      })
    await input.renderToolError(tool)
    UI.error(tool.state.error.message)
  }

  return {
    flushStep,
    dropStep: () => {
      pendingStep = undefined
    },
    error: (error: RunError, timestamp: number) => {
      if (!emit("error", timestamp, { error })) UI.error(error.message)
    },
    retry: (event: Extract<V2Event, { type: "session.retry.scheduled" }>) => {
      const retry = {
        messageID: event.data.assistantMessageID,
        attempt: event.data.attempt,
        nextRetryAt: event.data.at,
        error: event.data.error,
      }
      if (emit("retry", event.created, retry)) return
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL + `retrying (attempt ${retry.attempt}): ${retry.error.message}`,
      )
    },
    waiting: (jobs: Job[], limitMinutes: number) => {
      const list = jobs.map((job) => ({ id: job.id, kind: job.kind, title: job.title }))
      if (emit("background_wait", Date.now(), { jobs: list, limitMinutes })) return
      UI.println(
        UI.Style.TEXT_DIM +
          `waiting for ${jobs.length} background job${jobs.length === 1 ? "" : "s"} (stops after ${limitMinutes} minutes)` +
          UI.Style.TEXT_NORMAL,
      )
    },

    event: async (event: V2Event) => {
      const time = "created" in event ? event.created : Date.now()

      if (event.type === "session.step.started") {
        const part = {
          id: partID(event.id),
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "step-start",
          snapshot: event.data.snapshot,
        }
        const label = `> ${event.data.agent} · ${event.data.model.id}`
        if (input.compatibility === "v1") {
          pendingStep = { timestamp: time, part, label }
          return
        }
        // Each retried attempt of a step starts it again.
        if (steps.has(event.data.assistantMessageID)) return
        steps.set(event.data.assistantMessageID, "started")
        writeStep(time, part, label)
        return
      }

      if (event.type === "session.text.started" || event.type === "session.reasoning.started") {
        flushStep()
        const kind = event.type === "session.text.started" ? "text" : "reasoning"
        starts.set(`${kind}\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`, {
          id: partID(event.id),
          timestamp: time,
        })
        return
      }
      if (event.type === "session.text.ended" || (event.type === "session.reasoning.ended" && input.thinking)) {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning"
        const key = `${kind}\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`
        const started = starts.get(key)
        starts.delete(key)
        rendered.set(key, event.data.text)
        write(
          kind,
          {
            id: started?.id ?? partID(event.id),
            sessionID: input.sessionID,
            messageID: event.data.assistantMessageID,
            type: kind,
            text: event.data.text,
            ...(event.type === "session.reasoning.ended" ? { metadata: event.data.native } : {}),
            time: { start: started?.timestamp ?? time, end: time },
          },
          time,
        )
        return
      }

      if (event.type === "session.tool.input.started") {
        flushStep()
        tools.set(toolKey(event.data.assistantMessageID, event.data.id), {
          id: partID(event.id),
          timestamp: time,
          assistantMessageID: event.data.assistantMessageID,
          tool: event.data.name,
          input: {},
          metadata: {},
          content: [],
        })
        return
      }
      if (event.type === "session.tool.input.ended") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) current.raw = event.data.text
        return
      }
      if (event.type === "session.tool.input.delta") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) current.raw = (current.raw ?? "") + event.data.delta
        return
      }
      if (event.type === "session.tool.called") {
        flushStep()
        const key = toolKey(event.data.assistantMessageID, event.data.id)
        const current = tools.get(key)
        tools.set(key, {
          id: current?.id ?? partID(event.id),
          timestamp: current?.timestamp ?? time,
          assistantMessageID: event.data.assistantMessageID,
          tool: current?.tool ?? "tool",
          input: event.data.input,
          raw: current?.raw,
          provider: { executed: event.data.executed, state: event.data.native },
          native: event.data.native,
          metadata: {},
          content: [],
        })
        return
      }
      if (event.type === "session.tool.progress") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) current.metadata = event.data.metadata
        return
      }
      if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        const key = toolKey(event.data.assistantMessageID, event.data.id)
        const current = tools.get(key) ?? fallbackTool(event)
        tools.delete(key)
        renderedTools.add(key)
        const part = {
          partID: current.id,
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "tool" as const,
          id: event.data.id,
          tool: current.tool,
        }
        const call = {
          providerCall: current.provider,
          providerResult: { executed: event.data.executed, state: event.data.native },
          rawInput: current.raw,
        }
        const tool = {
          type: "tool" as const,
          id: event.data.id,
          name: current.tool,
          executed: event.data.executed,
          native: event.data.native ? { ...current.native, ...event.data.native } : current.native,
          time: { created: current.timestamp, ran: current.timestamp, completed: time },
        }
        const span = { start: current.timestamp, end: time }
        if (event.type === "session.tool.success") {
          const state = {
            status: "completed" as const,
            input: current.input,
            output: toolOutputText(current.tool, event.data.content),
            title: current.tool,
            metadata: { metadata: event.data.metadata, content: event.data.content, ...call },
            time: span,
          }
          if (emit("tool_use", time, { part: { ...part, state } satisfies MiniToolPart })) return
          return input.renderTool({
            ...tool,
            state: {
              status: "completed",
              input: current.input,
              metadata: event.data.metadata,
              content: event.data.content,
            },
          })
        }
        const state = {
          status: "error" as const,
          input: current.input,
          error: event.data.error.message,
          metadata: call,
          time: span,
        }
        if (emit("tool_use", time, { part: { ...part, state } satisfies MiniToolPart })) return
        return renderFailedTool({
          ...tool,
          state: {
            status: "error",
            input: current.input,
            metadata: event.data.metadata ?? current.metadata,
            content: event.data.content ?? nonEmptyToolContent(current.content),
            error: event.data.error,
          },
        })
      }

      if (event.type === "session.step.ended") {
        flushStep()
        steps.set(event.data.assistantMessageID, "ended")
        emit("step_finish", time, {
          part: {
            id: partID(event.id),
            sessionID: input.sessionID,
            messageID: event.data.assistantMessageID,
            type: "step-finish",
            reason: event.data.finish,
            snapshot: event.data.snapshot,
            cost: event.data.cost,
            tokens: event.data.tokens,
          },
        })
      }
    },

    // Prints whatever of the projected turn the live stream missed.
    reconcile: async (messages: SessionMessageInfo[]) => {
      for (const message of messages) {
        if (message.type !== "assistant") continue
        const timestamp = message.time.completed ?? message.time.created
        const step = steps.get(message.id)
        if (!step) {
          emit("step_start", message.time.created, {
            part: {
              id: projectedPartID(message.id, "step-start"),
              sessionID: input.sessionID,
              messageID: message.id,
              type: "step-start",
              snapshot: message.snapshot?.start,
            },
          })
        }
        const ordinals = { text: 0, reasoning: 0 }
        for (const item of message.content) {
          if (item.type === "text" || item.type === "reasoning") {
            const ordinal = ordinals[item.type]++
            const key = `${item.type}\u0000${contentKey(message.id, ordinal)}`
            const previous = rendered.get(key) ?? ""
            if (item.type === "reasoning" && !input.thinking) continue
            if (previous === item.text || !item.text.startsWith(previous)) continue
            rendered.set(key, item.text)
            write(
              item.type,
              {
                id: projectedPartID(message.id, `${item.type}-${ordinal}`),
                sessionID: input.sessionID,
                messageID: message.id,
                type: item.type,
                text: item.text.slice(previous.length),
                ...(item.type === "reasoning" ? { metadata: item.native } : {}),
                time: { start: message.time.created, end: timestamp },
              },
              timestamp,
            )
            continue
          }

          const key = toolKey(message.id, item.id)
          if (renderedTools.has(key) || item.state.status === "streaming" || item.state.status === "running") continue
          renderedTools.add(key)
          const time = { start: item.time.ran ?? item.time.created, end: item.time.completed ?? timestamp }
          const metadata = { metadata: item.state.metadata, content: item.state.content }
          const part: MiniToolPart = {
            partID: projectedPartID(message.id, `tool-${item.id}`),
            sessionID: input.sessionID,
            messageID: message.id,
            type: "tool",
            id: item.id,
            tool: item.name,
            state:
              item.state.status === "completed"
                ? {
                    status: "completed",
                    input: item.state.input,
                    output: toolOutputText(item.name, item.state.content),
                    title: item.name,
                    metadata,
                    time,
                  }
                : { status: "error", input: item.state.input, error: item.state.error.message, metadata, time },
          }
          if (emit("tool_use", timestamp, { part })) continue
          if (item.state.status === "completed") await input.renderTool(item)
          else await renderFailedTool({ ...item, state: item.state })
        }

        if (step !== "ended" && message.finish && message.tokens) {
          emit("step_finish", timestamp, {
            part: {
              id: projectedPartID(message.id, "step-finish"),
              sessionID: input.sessionID,
              messageID: message.id,
              type: "step-finish",
              reason: message.finish,
              snapshot: message.snapshot?.end,
              cost: message.cost ?? 0,
              tokens: message.tokens,
            },
          })
        }
      }
    },
  }
}

function sameLocation(left: LocationRef | undefined, right: LocationRef) {
  return !!left && left.directory === right.directory
}

function formAlreadySettled(error: unknown) {
  return !!error && typeof error === "object" && "_tag" in error && error._tag === "FormAlreadySettledError"
}

function partID(eventID: string) {
  return `prt_${eventID.replace(/^evt_/, "")}`
}

function toolKey(messageID: string, id: string) {
  return `${messageID}\u0000${id}`
}

function contentKey(messageID: string, ordinal: number) {
  return `${messageID}\u0000${ordinal}`
}

function projectedPartID(messageID: string, part: string) {
  return `prt_${messageID.replace(/^msg_/, "")}_${part}`
}

function fallbackTool(event: {
  id: string
  created: number
  data: { assistantMessageID: string; id: string }
}): ToolState {
  return {
    id: partID(event.id),
    timestamp: event.created,
    assistantMessageID: event.data.assistantMessageID,
    tool: "tool",
    input: {},
    metadata: {},
    content: [],
  }
}

async function prepareFile(file: File) {
  if (file.mime !== "text/plain") {
    const uri = file.url.startsWith("data:")
      ? file.url
      : `data:${file.mime};base64,${(await readFile(new URL(file.url))).toString("base64")}`
    return { attachment: { uri, name: file.filename } }
  }
  const content = file.url.startsWith("data:")
    ? Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64").toString("utf8")
    : await readFile(new URL(file.url), "utf8")
  return { text: `<file name="${file.filename}">\n${content}\n</file>` }
}
