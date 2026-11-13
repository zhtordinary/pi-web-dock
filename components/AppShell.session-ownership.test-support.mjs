import * as React from "react";

const cwd = "/tmp/reader-ownership-project";
const session = (id) => ({ id, path: `/tmp/${id}.jsonl`, cwd, projectRoot: cwd, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: "question" });
const device = (id) => ({ id, name: id, online: true, lastSeenAt: "2026-01-01" });
const filters = { device: "all", archiveView: "active", project: [], status: "all", sort: "recent", days: "all", group: "project" };
const router = { replace() {}, push() {} };

export function useRouter() { return router; }
export function useSearchParams() { return React.useMemo(() => new URLSearchParams(window.location.search), [window.location.search]); }
export function readSharedFilters() { return filters; }
export function readSharedRevision() { return 0; }
export function readSharedOwnerEpoch() { return "test"; }
export function subscribeSharedFiltersBroadcast() { return () => {}; }
export function applyRemoteSharedFilters() { return false; }
export function updateSharedFilters() {}
export function useSharedActivityFilters() { return [filters, updateSharedFilters]; }
export function SessionSearchMatchFilterSelect() { return null; }
export function SubprojectContextMenu() { return null; }
export function SessionActivityPanel() { return null; }
export function ExplorerSection() { return null; }
export function PiWebTitle() { return React.createElement("span", null, "Reader"); }

export function SessionSidebar({ onCwdChange, onSelectSession }) {
  return React.createElement("div", null,
    React.createElement("button", { "data-test-cwd": "", onClick: () => onCwdChange(cwd) }, "cwd"),
    React.createElement("button", { "data-test-local": "", onClick: () => onSelectSession(session("local-a")) }, "local"),
  );
}

export function SessionActivitySidebar(props) {
  return React.createElement("div", null,
    React.createElement("button", { "data-test-favorites": "", onClick: props.onOpenFavorites }, "favorites"),
    React.createElement("button", { "data-test-hidden": "", onClick: props.onOpenHidden }, "hidden"),
    React.createElement("button", { "data-test-discuss": "", onClick: props.onOpenToDiscuss }, "discuss"),
    React.createElement("button", { "data-test-revise": "", onClick: props.onOpenToRevise }, "revise"),
    React.createElement("button", { "data-test-completed": "", onClick: props.onOpenCompleted }, "completed"),
    React.createElement("button", { "data-test-new-remote": "", onClick: () => props.onNewSession(cwd, device("peer-a")) }, "remote draft"),
    React.createElement("button", { "data-test-same-remote": "", onClick: () => props.onOpenSession({ device: device("peer-a"), session: session("promoted-a"), status: "running" }, undefined, "all") }, "same remote"),
    React.createElement("button", { "data-test-other-remote": "", onClick: () => props.onOpenSession({ device: device("peer-b"), session: session("promoted-a"), status: "running" }, undefined, "all") }, "other remote"),
  );
}

export function ChatWindow(props) {
  const [owner] = React.useState(() => ++globalThis.__readerOwnerProbe.next);
  const [live, setLive] = React.useState("");
  const latestProps = React.useRef(props);
  latestProps.current = props;
  React.useEffect(() => {
    const record = { emit: (text) => setLive((previous) => previous + text), fork: (result) => latestProps.current.onSessionForked?.(result), mounted: true };
    globalThis.__readerOwnerProbe.owners.set(owner, record);
    return () => { record.mounted = false; };
  }, [owner]);
  return React.createElement("section", { "data-test-chat": String(owner), "data-test-session": props.session?.id ?? "draft", "data-test-peer": props.remotePeer ?? "local", "data-test-path": props.session?.path ?? "" },
    React.createElement("span", { "data-test-live": "" }, live),
    React.createElement("button", { "data-test-emit": "", onClick: () => setLive((previous) => previous + "live") }, "emit"),
    props.session && props.onSessionForked && React.createElement("button", { "data-test-fork-first": "", onClick: () => props.onSessionForked({ restoreMessage: { role: "user", content: "fork question" } }) }, "fork"),
    props.session && props.onSessionForked && React.createElement("button", { "data-test-fork-session": "", onClick: () => props.onSessionForked({ newSessionId: "fork-from-a" }) }, "fork session"),
    !props.session && props.onSessionCreated && React.createElement("button", { "data-test-promote": "", onClick: () => props.onSessionCreated(session("promoted-a"), props.newSessionDraftKey) }, "promote"),
  );
}
