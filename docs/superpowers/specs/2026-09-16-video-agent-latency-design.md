# Video Agent Latency and Timeout Design

## Goal

Reduce video-agent latency for multi-asset requests and make stalled work fail
predictably with an actionable client outcome.

## Scope

This change covers three areas:

1. Parallelize independent asset analysis.
2. Replace the always-injected full storyboard skill with a concise routing
   prompt and task-specific reference files.
3. Add configurable phase timeouts, cancellation, and structured latency logs
   for model and tool execution.

The architecture remains a single ToolLoopAgent. This avoids additional model
round trips and context handoff required by a multi-agent orchestration layer.

## Asset Analysis

The agent will use a batch asset-analysis tool for independent assets. The tool
accepts multiple asset IDs and processes them with a concurrency limit of
three. Each asset result is independent:

- A successful analysis persists the asset summary and emits the completed
  process event.
- A failed or timed-out analysis records a per-asset error result without
  cancelling the other asset analyses.
- The agent receives the aggregated results and decides whether it has enough
  information to continue or needs user input.

Each external analysis request has a 90-second deadline. Its abort signal is
passed to the external request so timed-out work does not continue in the
background.

## Prompt Routing

The base system prompt will contain only:

- The assistant role and current session, asset, script, and task summaries.
- A concise task-routing table.
- A mapping from task type to the reference file that must be read.
- Persistence and user-confirmation invariants.

The full `life-service-storyboard-generator/SKILL.md` content will no longer be
inserted into every model request. Its content will be split into these
on-demand references:

| File | Loaded when |
| --- | --- |
| `routing.md` | Any creation or modification task |
| `character.md` | The request selects, changes, or constrains a character or outfit |
| `storyboard.md` | The request creates or modifies a storyboard |
| `seedance.md` | The request creates, saves, optimizes, or validates a Seedance prompt |

Existing specialist references remain readable through the existing
`read_file` tool. The tool output is part of only the current agent loop
context, not future requests unless persisted in a business entity.

## Timeouts and Errors

All configurable deadlines are expressed in milliseconds and use these
production defaults:

| Environment variable | Default | Scope |
| --- | ---: | --- |
| `VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS` | 180,000 | No first model-stream event |
| `VIDEO_AGENT_ASSET_PARSE_TIMEOUT_MS` | 180,000 | One asset analysis |
| `VIDEO_AGENT_TOOL_TIMEOUT_MS` | 60,000 | Normal tool execution |
| `VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS` | 90,000 | Script persistence tool |
| `VIDEO_AGENT_TOTAL_TIMEOUT_MS` | 900,000 | Entire agent request |
| `VIDEO_AGENT_ROLE_TIMEOUT_MS` | 240,000 | One role sub-agent in orchestration mode |

Multi-agent orchestration dispatches 编剧 → 分镜导演 → 摄影 (plus an optional
reviewer) sequentially, so `VIDEO_AGENT_TOTAL_TIMEOUT_MS` must exceed the sum of
the dispatched role budgets plus the script save and director steps. The budgets
above are the 2× values adopted for that mode.

The Nginx `proxy_read_timeout` for `/video` and `/ai` must be
`VIDEO_AGENT_TOTAL_TIMEOUT_MS` + 30 seconds (currently 930 seconds) so the
application can emit its structured timeout response before the proxy closes the
connection.

A model or tool timeout cancels the active agent request and returns one of:

- `MODEL_TIMEOUT`
- `TOOL_TIMEOUT`
- `ASSET_PARSE_TIMEOUT`
- `AGENT_TOTAL_TIMEOUT`

Timeouts before a side effect starts remain retryable. Once a tool mutation has
started, the result may be uncertain because TypeORM cannot reliably cancel an
in-flight query. Those requests return the non-retryable
`OPERATION_STATUS_UNKNOWN` outcome with `操作状态未知，请刷新查看结果`; the client
must refresh persisted state rather than resubmit. An incomplete assistant
message is not persisted.

## Observability

Every model and tool phase logs structured fields:

- `requestId`
- `sessionId`
- `phase`
- `toolName` when applicable
- `assetId` when applicable
- `durationMs`
- `outcome`
- `errorCode` when applicable

Logs must not include prompt text, image URLs, tokens, credentials, or full
tool output. The request ID is returned or correlated through the existing
stream response so one user request can be traced across model and tool logs.

## Verification

Unit tests will prove:

- Asset analysis observes the concurrency cap and continues after an
  independent asset failure.
- Timeouts before mutations remain retryable; post-mutation timeouts map to a
  non-retryable status-unknown outcome.
- The base prompt excludes the full skill content and routes each task to the
  necessary references.
- Sensitive prompt and URL content does not appear in latency logs.

Integration coverage will verify that a multi-image creation request starts
asset analyses concurrently, normal storyboard creation still persists a
script, and the frontend receives the structured timeout error.
