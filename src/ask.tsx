import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  Toast,
  confirmAlert,
  open,
  showToast,
} from "@raycast/api";
import { getFavicon, useCachedState, usePromise } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Model, ProxyError, Source, ask, fetchModels } from "./api";
import {
  Thread,
  Turn,
  answerWithSources,
  citationCount,
  domain,
  loadThreads,
  saveThreads,
  turnMarkdown,
} from "./threads";

type Settings = { model: string; search: boolean; effort: string };
type Run = { threadId: string; turnId: string; controller: AbortController; toast: Promise<Toast> };

const FLUSH_MS = 80; // batch text deltas so the pane re-renders about 12 times a second

export default function Command(props: LaunchProps<{ arguments: Arguments.Ask }>) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState<{ threadId: string; question: string } | null>(null);
  const [model, setModel] = useCachedState("model", "");
  const [search, setSearch] = useCachedState("search", true);
  const [effort, setEffort] = useCachedState("effort", "");
  const { data: models } = usePromise(fetchModels, [], {
    failureToastOptions: { title: "Could not load models" },
  });

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const runRef = useRef<Run | null>(null);
  const pendingText = useRef("");
  const flushTimer = useRef<NodeJS.Timeout | null>(null);

  const updateThread = useCallback((threadId: string, fn: (t: Thread) => Thread) => {
    setThreads((ts) => ts.map((t) => (t.id === threadId ? fn(t) : t)));
  }, []);

  const updateTurn = useCallback(
    (threadId: string, turnId: string, fn: (t: Turn) => Turn) =>
      updateThread(threadId, (th) => ({ ...th, turns: th.turns.map((t) => (t.id === turnId ? fn(t) : t)) })),
    [updateThread],
  );

  const flush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    const run = runRef.current;
    const text = pendingText.current;
    pendingText.current = "";
    if (run && text) updateTurn(run.threadId, run.turnId, (t) => ({ ...t, text: t.text + text }));
  }, [updateTurn]);

  /** Sends a question. With retryOf, the new turn replaces that turn and reuses its branch and settings. */
  const startTurn = useCallback(
    (question: string, threadId: string | null, settings: Settings, retryOf?: Turn) => {
      if (runRef.current) {
        showToast({ style: Toast.Style.Failure, title: "Still answering", message: "Stop it first with ⌘." });
        return;
      }
      const existing = threadId ? threadsRef.current.find((t) => t.id === threadId) : undefined;
      const thread: Thread = existing ?? { id: randomUUID(), title: question, turns: [], updatedAt: Date.now() };
      const turn: Turn = {
        id: randomUUID(),
        question,
        ...settings,
        parentBranch: retryOf ? retryOf.parentBranch : thread.branch,
        status: "running",
        activities: [],
        sources: [],
        text: "",
        startedAt: Date.now(),
      };
      const withTurn = (th: Thread): Thread => ({
        ...th,
        turns: retryOf ? th.turns.map((t) => (t.id === retryOf.id ? turn : t)) : [...th.turns, turn],
        updatedAt: Date.now(),
      });
      setThreads((ts) => (existing ? ts.map((t) => (t.id === thread.id ? withTurn(t) : t)) : [withTurn(thread), ...ts]));
      setActiveId(thread.id);
      setSearchText("");
      setSelectedId(turn.id);
      setRunning(true);

      const controller = new AbortController();
      const toast = showToast({
        style: Toast.Style.Animated,
        title: settings.search ? "Searching the web…" : "Answering…",
      });
      const run: Run = { threadId: thread.id, turnId: turn.id, controller, toast };
      runRef.current = run;
      const patch = (fn: (t: Turn) => Turn) => updateTurn(run.threadId, run.turnId, fn);
      // How the stream ended, tracked here because React state is not updated yet in finally().
      let outcome: { ok: true } | { ok: false; error: string } | null = null;
      const fail = (error: string) => {
        outcome = { ok: false, error };
        patch((t) => ({ ...t, status: "error", error, endedAt: Date.now() }));
      };
      let answering = false;

      ask(
        {
          query: question,
          model: settings.model || undefined,
          search: settings.search,
          reasoning_effort: settings.effort || undefined,
          branch: turn.parentBranch,
        },
        {
          thread: (e) => updateThread(run.threadId, (th) => ({ ...th, branch: e.branch, url: e.url })),
          title: (title) => updateThread(run.threadId, (th) => ({ ...th, title })),
          activity: (a) => {
            flush();
            patch((t) => {
              const i = t.activities.findIndex((x) => x.id === a.id);
              const activities = i === -1 ? [...t.activities, a] : t.activities.map((x, j) => (j === i ? a : x));
              return { ...t, activities };
            });
          },
          source: (s) => {
            flush();
            patch((t) => (t.sources.some((x) => x.n === s.n) ? t : { ...t, sources: [...t.sources, s] }));
          },
          text: (delta) => {
            if (!answering) {
              answering = true;
              toast.then((t) => (t.title = "Answering…"));
            }
            pendingText.current += delta;
            flushTimer.current ??= setTimeout(flush, FLUSH_MS);
          },
          done: (usage) => {
            flush();
            outcome = { ok: true };
            patch((t) => ({ ...t, status: "done", usage, endedAt: Date.now() }));
          },
          error: (e) => {
            flush();
            fail(e.message);
          },
        },
        controller.signal,
      )
        .catch((err: unknown) => {
          flush();
          if (!controller.signal.aborted) fail(describeError(err));
        })
        .finally(async () => {
          flush();
          runRef.current = null;
          if (controller.signal.aborted) {
            patch((t) => ({ ...t, status: "stopped", endedAt: Date.now() }));
          } else if (!outcome) {
            fail("The stream ended before the answer finished.");
          }
          setRunning(false);

          const t = await toast;
          const end = outcome as typeof outcome; // TS narrows `let` to null across callbacks
          if (controller.signal.aborted) {
            t.style = Toast.Style.Success;
            t.title = "Stopped";
          } else if (end?.ok) {
            t.style = Toast.Style.Success;
            t.title = "Answered";
          } else {
            t.style = Toast.Style.Failure;
            t.title = "Answer failed";
            t.message = end?.error;
            t.primaryAction = { title: "Retry", onAction: () => retryRef.current(run.threadId, turn) };
          }
        });
    },
    [flush, updateThread, updateTurn],
  );

  const retry = useCallback(
    (threadId: string, turn: Turn) =>
      startTurn(turn.question, threadId, { model: turn.model, search: turn.search, effort: turn.effort }, turn),
    [startTurn],
  );
  const retryRef = useRef(retry);
  retryRef.current = retry;

  const stop = useCallback(() => {
    setQueued(null);
    runRef.current?.controller.abort();
  }, []);

  // Load saved threads, then run the question from the command argument or fallback text.
  // The ref guard keeps this to one run when React runs mount effects twice in development.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    loadThreads().then((saved) => {
      setThreads(saved);
      threadsRef.current = saved;
      setLoaded(true);
      const q = (props.arguments.question || props.fallbackText || "").trim();
      if (!q) return;
      // Raycast refills the argument with its last value, so reopening would ask the same question
      // again. When it matches the newest question, open that thread instead (⌘R still re-asks).
      const latest = [...saved].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const last = latest?.turns.at(-1);
      if (last && last.question.trim().toLowerCase() === q.toLowerCase()) {
        setActiveId(latest.id);
        setSelectedId(last.id);
      } else {
        startTurn(q, null, { model, search, effort });
      }
    });
  }, []);

  // Save at most every 500 ms, also while streaming: Raycast may end the process on close
  // before a save started in the unmount cleanup below finishes.
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!loaded || saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveThreads(threadsRef.current);
    }, 500);
  }, [threads, loaded]);
  useEffect(
    () => () => {
      const run = runRef.current;
      if (!run) return;
      run.controller.abort();
      const text = pendingText.current;
      saveThreads(
        threadsRef.current.map((th) =>
          th.id !== run.threadId
            ? th
            : {
                ...th,
                turns: th.turns.map((t) =>
                  t.id === run.turnId ? { ...t, text: t.text + text, status: "stopped", endedAt: Date.now() } : t,
                ),
              },
        ),
      );
    },
    [],
  );

  // Send a queued follow-up once the current answer ends.
  useEffect(() => {
    if (running || !queued) return;
    setQueued(null);
    startTurn(queued.question, queued.threadId, { model, search, effort });
  }, [running, queued]);

  const active = threads.find((t) => t.id === activeId) ?? null;
  const settings: Settings = { model, search, effort };
  const selectedModel = models?.find((m) => m.id === model);
  const question = searchText.trim();

  function submit(text: string, opts: { web: boolean; newThread?: boolean }) {
    if (!text) return;
    if (running && active && !opts.newThread) {
      setQueued({ threadId: active.id, question: text });
      setSearchText("");
      showToast({ style: Toast.Style.Success, title: "Queued", message: "Sent after this answer" });
      return;
    }
    startTurn(text, opts.newThread ? null : (active?.id ?? null), { ...settings, search: opts.web });
  }

  const settingsSection = (
    <ActionPanel.Section title="Settings">
      <Action
        title={search ? "Turn Web Search Off" : "Turn Web Search On"}
        icon={Icon.Globe}
        shortcut={{ modifiers: ["cmd", "shift"], key: "w" }}
        onAction={() => setSearch(!search)}
      />
      <ActionPanel.Submenu title="Reasoning Effort" icon={Icon.LightBulb} shortcut={{ modifiers: ["cmd"], key: "e" }}>
        {["", ...(selectedModel?.reasoning_efforts ?? [])].map((e) => (
          <Action
            key={e || "default"}
            title={e ? e : `Default${selectedModel?.reasoning_effort_default ? ` (${selectedModel.reasoning_effort_default})` : ""}`}
            icon={e === effort ? Icon.Checkmark : Icon.Circle}
            onAction={() => setEffort(e)}
          />
        ))}
      </ActionPanel.Submenu>
    </ActionPanel.Section>
  );

  const stopAction = running ? (
    <Action title="Stop" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={stop} />
  ) : null;

  function threadSection(thread: Thread, turn?: Turn) {
    return (
      <ActionPanel.Section title="Thread">
        {turn?.status === "done" && (
          <Action
            title="Regenerate"
            icon={Icon.RotateClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => retry(thread.id, turn)}
          />
        )}
        {thread.url && (
          <Action.OpenInBrowser
            title="Open in Kagi"
            url={thread.url}
            shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
          />
        )}
        <Action
          title="New Thread"
          icon={Icon.PlusCircle}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={() => {
            setActiveId(null);
            setSearchText("");
            setSelectedId(undefined);
          }}
        />
      </ActionPanel.Section>
    );
  }

  function answerActions(thread: Thread, turn: Turn) {
    // After a stop or an error, Retry comes first, so ↵ and ⌘R both retry.
    const failed = turn.status === "error" || turn.status === "stopped";
    return (
      <ActionPanel>
        {stopAction}
        {failed && !running && (
          <Action
            title="Retry"
            icon={Icon.RotateClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => retry(thread.id, turn)}
          />
        )}
        <ActionPanel.Section title="Answer">
          <Action.CopyToClipboard title="Copy Answer" content={turn.text} />
          <Action.Paste title="Paste Answer" content={turn.text} />
          <Action.CopyToClipboard
            title="Copy with Sources"
            content={answerWithSources(turn)}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
          {turn.sources.length > 0 && (
            <Action
              title="Open All Sources"
              icon={Icon.Globe}
              shortcut={{ modifiers: ["cmd"], key: "o" }}
              onAction={() => turn.sources.forEach((s) => open(s.url))}
            />
          )}
        </ActionPanel.Section>
        {threadSection(thread, turn)}
        {settingsSection}
      </ActionPanel>
    );
  }

  const askRow = question ? (
    <List.Item
      id="ask"
      title={running && active ? `Ask next: “${question}”` : `Ask “${question}”`}
      icon={Icon.MagnifyingGlass}
      // The search bar already shows the question. While typing a follow-up, keep the current answer in view.
      detail={<List.Item.Detail markdown={active?.turns.length ? turnMarkdown(active.turns.at(-1)!, false) : ""} />}
      actions={
        <ActionPanel>
          <Action
            title={running && active ? "Queue Question" : "Ask"}
            icon={Icon.MagnifyingGlass}
            onAction={() => submit(question, { web: search })}
          />
          <Action title="Ask Without Web Search" icon={Icon.Bubble} onAction={() => submit(question, { web: false })} />
          {active && (
            <Action
              title="Ask in New Thread"
              icon={Icon.PlusCircle}
              shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
              onAction={() => submit(question, { web: search, newThread: true })}
            />
          )}
          {stopAction}
          {settingsSection}
        </ActionPanel>
      }
    />
  ) : null;

  const placeholder = !active
    ? "Ask the web…"
    : running
      ? "Type to queue the next question…"
      : search
        ? "Ask a follow-up…"
        : "Ask a follow-up (web search off)…";

  return (
    <List
      isLoading={!loaded || running}
      isShowingDetail
      filtering={false}
      searchText={searchText}
      onSearchTextChange={(text) => {
        setSearchText(text);
        if (text.trim()) setSelectedId("ask");
      }}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
      searchBarPlaceholder={placeholder}
      // Raycast's bottom bar shows only the primary action, so the ⌘↵ hint goes in the title slot (bottom left).
      navigationTitle={question && selectedId === "ask" ? "⌘↵  Ask Without Web Search" : active ? active.title : "Ask Kagi"}
      searchBarAccessory={
        <ModelDropdown
          models={models}
          model={model}
          search={search}
          onChange={(m, web) => {
            setModel(m);
            setSearch(web);
            const efforts = models?.find((x) => x.id === m)?.reasoning_efforts ?? [];
            if (!efforts.includes(effort)) setEffort("");
          }}
        />
      }
    >
      {askRow}
      {active ? (
        <ThreadView thread={active} running={running} answerActions={answerActions} sourceActions={sourceActions} />
      ) : (
        <HomeView
          threads={threads}
          filter={question}
          loaded={loaded}
          actions={(th) => (
            <ActionPanel>
              <Action
                title="Open Thread"
                icon={Icon.ArrowRight}
                onAction={() => {
                  setActiveId(th.id);
                  setSelectedId(th.turns.at(-1)?.id);
                }}
              />
              {th.turns.at(-1) && (
                <Action.CopyToClipboard
                  title="Copy Latest Answer"
                  content={th.turns.at(-1)!.text}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                />
              )}
              {th.url && (
                <Action.OpenInBrowser
                  title="Open in Kagi"
                  url={th.url}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
                />
              )}
              <Action
                title="Delete Thread"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={async () => {
                  const ok = await confirmAlert({
                    title: "Delete this thread?",
                    message: "It is removed from Raycast only. The Kagi thread stays.",
                    primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
                  });
                  if (ok) setThreads((ts) => ts.filter((t) => t.id !== th.id));
                }}
              />
              {settingsSection}
            </ActionPanel>
          )}
        />
      )}
    </List>
  );

  function sourceActions(thread: Thread, turn: Turn, s: Source) {
    return (
      <ActionPanel>
        <ActionPanel.Section title="Source">
          <Action.OpenInBrowser url={s.url} />
          <Action.CopyToClipboard title="Copy URL" content={s.url} shortcut={Keyboard.Shortcut.Common.Copy} />
          <Action.CopyToClipboard
            title="Copy as Markdown Link"
            content={`[${s.title}](${s.url})`}
            shortcut={{ modifiers: ["cmd"], key: "l" }}
          />
        </ActionPanel.Section>
        {stopAction}
        {threadSection(thread, turn)}
        {settingsSection}
      </ActionPanel>
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof ProxyError) {
    if (err.status === 401) return "The proxy rejected the API key. Check it in the extension preferences.";
    if (err.code === "proxy_busy") return "The proxy is busy with another question. Try again in a moment.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function turnIcon(turn: Turn) {
  switch (turn.status) {
    case "running":
      return { source: Icon.CircleProgress50, tintColor: Color.Blue };
    case "done":
      return Icon.Bubble;
    case "stopped":
      return { source: Icon.Stop, tintColor: Color.SecondaryText };
    case "error":
      return { source: Icon.Warning, tintColor: Color.Red };
  }
}

function turnStatus(turn: Turn): string {
  if (turn.status === "running") return turn.text ? "answering" : turn.search ? "searching" : "thinking";
  if (turn.status === "stopped") return "stopped";
  if (turn.status === "error") return "failed";
  return turn.search ? `${turn.sources.length} sources` : "no web";
}

function ThreadView(props: {
  thread: Thread;
  running: boolean;
  answerActions: (th: Thread, t: Turn) => React.ReactNode;
  sourceActions: (th: Thread, t: Turn, s: Source) => React.ReactNode;
}) {
  const { thread } = props;
  const current = thread.turns.at(-1);
  if (!current) return null;
  const earlier = thread.turns.slice(0, -1).reverse();
  return (
    <>
      <List.Section title="Question">
        <List.Item
          id={current.id}
          title={current.question}
          icon={turnIcon(current)}
          accessories={[{ text: turnStatus(current) }]}
          detail={<List.Item.Detail markdown={turnMarkdown(current, false)} />}
          actions={props.answerActions(thread, current)}
        />
      </List.Section>
      {current.sources.length > 0 && (
        <List.Section title="Sources" subtitle={String(current.sources.length)}>
          {current.sources.map((s) => (
            <List.Item
              key={s.n}
              id={`${current.id}-src-${s.n}`}
              title={`[${s.n}] ${s.title}`}
              icon={getFavicon(s.url, { fallback: Icon.Globe })}
              accessories={[{ text: domain(s.url) }]}
              detail={<SourceDetail source={s} turn={current} />}
              actions={props.sourceActions(thread, current, s)}
            />
          ))}
        </List.Section>
      )}
      {earlier.length > 0 && (
        <List.Section title="Earlier in This Thread">
          {earlier.map((t) => (
            <List.Item
              key={t.id}
              id={t.id}
              title={t.question}
              icon={turnIcon(t)}
              accessories={[{ text: turnStatus(t) }]}
              detail={<List.Item.Detail markdown={turnMarkdown(t, true)} />}
              actions={props.answerActions(thread, t)}
            />
          ))}
        </List.Section>
      )}
    </>
  );
}

function SourceDetail({ source: s, turn }: { source: Source; turn: Turn }) {
  const cited = citationCount(turn.text, s.n);
  const lines = [
    `### ${s.title}`,
    `${domain(s.url)} · ${cited === 0 ? "not cited yet" : `cited as [${s.n}], ${cited} ${cited === 1 ? "time" : "times"}`}`,
    s.snippet ? `> ${s.snippet.replace(/\n+/g, " ")}` : "_No snippet._",
  ];
  return (
    <List.Item.Detail
      markdown={lines.join("\n\n")}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Link title="URL" target={s.url} text={s.url} />
          {s.published_at && <List.Item.Detail.Metadata.Label title="Published" text={s.published_at} />}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function HomeView(props: {
  threads: Thread[];
  filter: string;
  loaded: boolean;
  actions: (th: Thread) => React.ReactNode;
}) {
  const f = props.filter.toLowerCase();
  const shown = [...props.threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((th) => !f || th.title.toLowerCase().includes(f) || th.turns.some((t) => t.question.toLowerCase().includes(f)));

  if (props.loaded && props.threads.length === 0 && !f) {
    return (
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title="Ask anything"
        description="Answers come from Kagi, with sources. Type a question and press ↵."
      />
    );
  }
  return (
    <List.Section title={f ? "Matching Threads" : "Recent Threads"}>
      {shown.map((th) => {
        const last = th.turns.at(-1);
        return (
          <List.Item
            key={th.id}
            id={th.id}
            title={th.title}
            icon={Icon.List}
            accessories={[
              { text: `${th.turns.length} ${th.turns.length === 1 ? "turn" : "turns"}` },
              { date: new Date(th.updatedAt) },
            ]}
            detail={<List.Item.Detail markdown={last ? turnMarkdown(last, true) : ""} />}
            actions={props.actions(th)}
          />
        );
      })}
    </List.Section>
  );
}

function ModelDropdown(props: {
  models?: Model[];
  model: string;
  search: boolean;
  onChange: (model: string, web: boolean) => void;
}) {
  const ids = ["", ...(props.models ?? []).map((m) => m.id)];
  if (!ids.includes(props.model)) ids.push(props.model);
  const item = (web: boolean, id: string) => (
    <List.Dropdown.Item key={`${web}-${id}`} value={`${web ? "web" : "off"}|${id}`} title={id || "Kagi Default"} />
  );
  return (
    <List.Dropdown
      tooltip="Model and Web Search"
      value={`${props.search ? "web" : "off"}|${props.model}`}
      onChange={(v) => {
        const [web, ...rest] = v.split("|");
        props.onChange(rest.join("|"), web === "web");
      }}
    >
      <List.Dropdown.Section title="Search the Web">{ids.map((id) => item(true, id))}</List.Dropdown.Section>
      <List.Dropdown.Section title="No Web Search">{ids.map((id) => item(false, id))}</List.Dropdown.Section>
    </List.Dropdown>
  );
}
