import readline from "node:readline";

const provider = process.argv[2];
const providerArgs = process.argv.slice(3);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let activeTurnId = null;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function claudeSessionId() {
  const flag = providerArgs.findIndex((arg) => arg === "--resume" || arg === "--session-id");
  return flag >= 0 ? providerArgs[flag + 1] : "claude-session";
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (provider === "claude") {
    send({ ...request, session_id: claudeSessionId() });
    const text = request.message?.content?.[0]?.text;
    if (text === "delta") {
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "message_start", message: { id: "claude-message-1" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
    }
    if (text === "siblings") {
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "message_start", message: { id: "claude-siblings" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "working" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } });
      send({ type: "assistant", session_id: claudeSessionId(), uuid: "claude-record", message: {
        id: "claude-siblings",
        role: "assistant",
        content: [{ type: "thinking", thinking: "working" }, { type: "text", text: "answer" }],
      } });
    }
    if (text === "missing-id") {
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "message_start", message: {} } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "must be dropped" } } });
      send({ type: "assistant", session_id: claudeSessionId(), uuid: "record-only", message: {
        role: "assistant", content: [{ type: "text", text: "must also be dropped" }],
      } });
    }
    if (text === "crash") {
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "message_start", message: { id: "claude-before-crash" } } });
      send({ type: "stream_event", session_id: claudeSessionId(), event: { type: "content_block_delta", delta: { type: "text_delta", text: "visible before crash" } } });
      setTimeout(() => process.exit(2), 5);
      return;
    }
    if (text !== "hold") send({ type: "result", subtype: "success", is_error: false, session_id: claudeSessionId() });
    return;
  }

  if (request.method === "initialized") return;
  const respond = (result) => send({ id: request.id, result });
  if (request.method === "initialize") respond({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
  else if (request.method === "account/read") respond({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
  else if (request.method === "thread/resume") respond({ thread: { id: request.params.threadId, status: { type: process.env.FAKE_CODEX_RESUME_STATUS ?? "idle" } } });
  else if (request.method === "thread/start") respond({ thread: { id: "codex-new-thread", status: { type: "idle" } } });
  else if (request.method === "thread/read") respond({ thread: { id: request.params.threadId, status: { type: process.env.FAKE_CODEX_THREAD_STATUS ?? "idle" } } });
  else if (request.method === "turn/start") {
    activeTurnId = `native-${request.params.clientUserMessageId}`;
    const turn = { id: activeTurnId, status: "inProgress" };
    respond({ turn });
    send({ method: "turn/started", params: { threadId: request.params.threadId, turn } });
    send({ method: "item/completed", params: {
      threadId: request.params.threadId,
      turnId: activeTurnId,
      completedAtMs: Date.now(),
      item: { id: `user-${request.params.clientUserMessageId}`, type: "userMessage", content: request.params.input },
    } });
    if (request.params.input[0]?.text === "delta") {
      send({ method: "item/agentMessage/delta", params: { threadId: request.params.threadId, turnId: activeTurnId, itemId: "codex-message-1", delta: "hel" } });
      send({ method: "item/agentMessage/delta", params: { threadId: request.params.threadId, turnId: activeTurnId, itemId: "codex-message-1", delta: "lo" } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: { id: "codex-message-1", type: "agentMessage", text: "hello" } } });
    }
    if (request.params.input[0]?.text === "lineage") {
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: { id: "spawn-exact", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: request.params.threadId, receiverThreadIds: ["child-thread"], agentsStates: {}, status: "completed" } } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: { id: "spawn-incomplete", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "", receiverThreadIds: ["unclassified-child"], agentsStates: {}, status: "completed" } } });
    }
    if (request.params.input[0]?.text === "rich") {
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId: request.params.threadId, turnId: activeTurnId, itemId: "reasoning-rich", summaryIndex: 0, delta: "first" } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId: request.params.threadId, turnId: activeTurnId, itemId: "reasoning-rich", summaryIndex: 1, delta: "second" } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: {
        id: "reasoning-rich", type: "reasoning", summary: ["first", "second"], content: ["visible reasoning"],
      } } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: {
        id: "plan-rich", type: "plan", text: "Do the exact work",
      } } });
      send({ method: "item/started", params: { threadId: request.params.threadId, turnId: activeTurnId, startedAtMs: Date.now(), item: {
        id: "command-rich", type: "commandExecution", command: "true", status: "inProgress", aggregatedOutput: null,
      } } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId: request.params.threadId, turnId: activeTurnId, itemId: "command-rich", delta: "ok" } });
      send({ method: "item/completed", params: { threadId: request.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: {
        id: "command-rich", type: "commandExecution", command: "true", status: "completed", aggregatedOutput: "ok",
      } } });
    }
    if (request.params.input[0]?.text !== "hold") {
      send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: activeTurnId, status: "completed" } } });
      activeTurnId = null;
    }
  } else if (request.method === "turn/steer") {
    if (request.params.expectedTurnId !== activeTurnId) {
      send({ id: request.id, error: { code: -1, message: "wrong active turn" } });
    } else {
      respond({ turnId: activeTurnId });
      const completed = { method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: activeTurnId, status: "completed" } } };
      send(completed);
      send(completed);
      activeTurnId = null;
    }
  } else if (request.method === "turn/interrupt") {
    respond({});
    activeTurnId = null;
  }
});
