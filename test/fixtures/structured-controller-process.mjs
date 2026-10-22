import readline from "node:readline";

const provider = process.argv[2];
const providerArgs = process.argv.slice(3);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let activeTurnId = null;
let outputBatch = null;

function send(value) {
  if (outputBatch) outputBatch.push(JSON.stringify(value));
  else process.stdout.write(`${JSON.stringify(value)}\n`);
}

let approvalThread = null;
let archived = process.env.FAKE_CODEX_ARCHIVED === "1";
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === "approval-1" && request.result) {
    send({ method:"serverRequest/resolved", params:{ threadId:approvalThread, requestId:request.id } });
    send({ method:"turn/completed", params:{ threadId:approvalThread, turn:{ id:activeTurnId, status:"completed" } } });
    activeTurnId=null;
    return;
  }
  if (request.method === "initialized") return;
  const respond = (result) => send({ id: request.id, result });
  if (request.method === "initialize") respond({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
  else if (request.method === "account/read") respond({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
  else if (request.method === "thread/unarchive") {
    if (process.env.FAKE_CODEX_UNARCHIVE_FAIL === "1") send({ id: request.id, error: { code: -32600, message: "Archive restore refused" } });
    else { archived = false; respond({ thread: { id: process.env.FAKE_CODEX_RESTORED_ID ?? request.params.threadId } }); }
  }
  else if (request.method === "thread/resume" && archived) send({ id: request.id, error: { code: -32600, message: "Thread remains archived" } });
  else if (request.method === "thread/resume") respond({ thread: { id: request.params.threadId, status: { type: process.env.FAKE_CODEX_RESUME_STATUS ?? "idle" } } });
  else if (request.method === "thread/start") respond({ thread: { id: "codex-new-thread", status: { type: "idle" } } });
  else if (request.method === "thread/read") respond({ thread: { id: request.params.threadId, path: `/tmp/codex/${archived ? "archived_sessions" : "sessions"}/${request.params.threadId}.jsonl`, status: { type: process.env.FAKE_CODEX_THREAD_STATUS ?? "idle" } } });
  else if (request.method === "turn/start") {
    outputBatch = [];
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
    if (request.params.input[0]?.text === "permission") {
      approvalThread=request.params.threadId;
      send({ method:"thread/tokenUsage/updated", params:{ threadId:approvalThread,turnId:activeTurnId,tokenUsage:{total:{inputTokens:12,outputTokens:3,totalTokens:15}} } });
      send({ id:"approval-1", method:"item/commandExecution/requestApproval", params:{ threadId:approvalThread,turnId:activeTurnId,command:"true",reason:"bounded approval fixture" } });
    }
    if (["retry-failure", "object-failure", "no-code-failure"].includes(request.params.input[0]?.text)) {
      const code = request.params.input[0].text === "object-failure" ? { responseStreamDisconnected: { httpStatusCode: 429 } }
        : request.params.input[0].text === "no-code-failure" ? null : "usageLimitExceeded";
      const error = { message: "native failure", ...(code === null ? {} : { codexErrorInfo: code }), additionalDetails: "native detail" };
      for (const willRetry of [true, false]) send({ method: "error", params: {
        threadId: request.params.threadId, turnId: activeTurnId, willRetry, error } });
      const completion = { method: "turn/completed", params: { threadId: request.params.threadId,
        turn: { id: activeTurnId, status: "failed", error } } };
      send(completion); send(completion);
      send({ method: "thread/status/changed", params: { threadId: request.params.threadId, status: { type: "idle" } } });
      send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 100 } } } });
    } else if (!["hold","permission"].includes(request.params.input[0]?.text)) {
      send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: activeTurnId, status: "completed" } } });
      activeTurnId = null;
    }
    const batch = outputBatch; outputBatch = null;
    process.stdout.write(`${batch.join("\n")}\n`);
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
    send({method:"turn/completed",params:{threadId:request.params.threadId,turn:{id:activeTurnId,status:"interrupted"}}});
    activeTurnId = null;
  }
});
