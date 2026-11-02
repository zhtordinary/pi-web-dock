# pi-web-session-control

This first-party, versioned package defines the protocol and idempotency
rules for Reader's native `session_control` session creation. It is bundled as
source with the Reader candidate so the artifact has a complete closure. The
Reader host adapter owns the live registry, `SessionManager` calls, native
`SessionManager.list()` readback, and runtime recovery.

The package only consumes the SDK manager interface. The Reader host first
initializes a zero-model native `SessionManager` through the public
`SessionManager.open()` empty-file path because the SDK otherwise waits for a
role=user/assistant message before creating a new transcript. The package then
writes the protocol marker and a durable custom creation record through the
SDK. When `initialMessage` is supplied, the Reader host subsequently submits it
as the first real role=user prompt, so the new session is a visible conversation
and the model starts its first turn. When it is omitted, the host records only
the explicit software initialization message `通过 session_control 新建会话；尚未提供初始任务`
and intentionally leaves the native parent empty.
The SDK owns the header and every JSONL entry; the package never serializes
JSONL, reads session files directly, or maintains a second persistence ledger.
`source=agent-message`/`messageKind=agent-initial-message` identifies the
creation marker for a supplied first question. `source=initialization`/`messageKind=generated-initialization`
identifies the durable record when no question was supplied; neither custom
record is itself the user transcript message.

Idempotency is scoped by the caller's native session id and canonical cwd. An
explicit key is preferred; the Reader tool derives a fallback from its real
tool call id. A retry is reusable after the native marker, exact message
digest, and native session-list entry have been read back. Runtime setup
failure is reported with the persisted/list-visible facts and is never called
successful. The host takes a `proper-lockfile` admission lock in the real
native session directory around find plus create/recover, using the exported
stable scope/key hash. The host captures heartbeat compromise and release
errors so a proper-lockfile timer cannot crash Reader. Acquisition failure
prevents native creation; a lease or release failure can happen after the
native append, so the observed facts are preserved and `created`/`reused` is
downgraded to `persisted-runtime-failed`. The protocol has no second ledger or
queue.

This is a project-local source package, not a shared Pi registration. No
global Package declaration or live installation is required for Reader to
import this versioned protocol source.
