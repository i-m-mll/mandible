export function normalizeGeminiStreamLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
    if (type === "init") {
        return {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            model: typeof parsed.model === "string" ? parsed.model : undefined,
        };
    }
    if (type === "message") {
        const role = parsed.role === "assistant" ? "assistant" : "user";
        return {
            type: role,
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
                role,
                content: [{ type: "text", text: typeof parsed.content === "string" ? parsed.content : "" }],
                ...(role === "assistant" && typeof parsed.model === "string" ? { model: parsed.model } : {}),
            },
        };
    }
    if (type === "result") {
        const stats = (parsed.stats && typeof parsed.stats === "object") ? parsed.stats : {};
        const status = parsed.status === "success" ? "success" : "error_during_execution";
        return {
            type: "result",
            subtype: status,
            session_id: sessionId,
            duration_ms: typeof stats.duration_ms === "number" ? stats.duration_ms : 0,
            num_turns: 1,
            total_cost_usd: 0,
            is_error: status !== "success",
            ...(status !== "success" ? { errors: [typeof parsed.status === "string" ? parsed.status : "Gemini request failed"] } : {}),
        };
    }
    return null;
}
export function normalizeCodexStreamLine(line, state) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "thread.started") {
        state.threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : state.threadId;
        return {
            type: "system",
            subtype: "init",
            session_id: state.threadId ?? "",
            ...(state.model ? { model: state.model } : {}),
        };
    }
    if (type === "item.completed") {
        const item = (parsed.item && typeof parsed.item === "object") ? parsed.item : null;
        if (!item)
            return null;
        const itemType = typeof item.type === "string" ? item.type : "";
        if (itemType === "agent_message") {
            return {
                type: "assistant",
                session_id: state.threadId ?? "",
                parent_tool_use_id: null,
                message: {
                    role: "assistant",
                    ...(state.model ? { model: state.model } : {}),
                    content: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
                },
            };
        }
        return null;
    }
    if (type === "turn.completed") {
        state.turnCount += 1;
        const usage = (parsed.usage && typeof parsed.usage === "object") ? parsed.usage : {};
        return {
            type: "result",
            subtype: "success",
            session_id: state.threadId ?? "",
            duration_ms: 0,
            num_turns: state.turnCount,
            total_cost_usd: 0,
            is_error: false,
            usage,
        };
    }
    if (type === "error" || type === "turn.failed") {
        const error = parsed.error && typeof parsed.error === "object" ? parsed.error : null;
        const message = typeof parsed.message === "string" ? parsed.message
            : typeof error?.message === "string" ? error.message
                : "Codex request failed";
        return {
            type: "result",
            subtype: "error_during_execution",
            session_id: state.threadId ?? "",
            duration_ms: 0,
            num_turns: state.turnCount,
            total_cost_usd: 0,
            is_error: true,
            errors: [message],
        };
    }
    return null;
}
