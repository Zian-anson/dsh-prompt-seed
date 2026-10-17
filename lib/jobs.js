/**
 * 0.16.0 会话级任务：Host 内存里持有优化任务，切会话不取消。
 *
 * 不写磁盘：Host 重启即丢，换取没有 tasks.json 的并发/损坏/孤儿问题。
 * 不提供全量列表：只按会话/key 查单个任务，避免跨会话泄露与数字徽标。
 */

import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * 生成 task id。
 * @returns {string} id。
 */
function newId() {
  return "j-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * 截断代理对安全的字符串。
 * @param {string} text 文本。
 * @param {number} limit 长度。
 * @returns {string} 结果。
 */
function clamp(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * 创建 JobStore。
 * @param {{timeoutMs?: number, maxRunning?: number, maxJobs?: number, ttlMs?: number, now?: Function, log?: Function}} [options] 参数。
 * @returns {object} store。
 */
export function createJobStore(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const maxRunning = Number.isFinite(options.maxRunning) && options.maxRunning > 0 ? options.maxRunning : 4;
  const maxJobs = Number.isFinite(options.maxJobs) && options.maxJobs > 0 ? options.maxJobs : 32;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 10 * 60 * 1000;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const log = typeof options.log === "function" ? options.log : () => {};

  const jobs = new Map();
  const waiters = new Map();
  const timers = new Map();

  /**
   * 公开任务形状（只给当前会话/key 的查询）。
   * @param {object} record 内部记录。
   * @returns {object} 公开任务。
   */
  function publicJob(record) {
    return {
      id: record.id,
      status: record.status,
      conversationKey: record.conversationKey,
      sessionId: record.sessionId ?? null,
      runId: record.runId ?? null,
      inputText: record.inputText,
      partialText: record.partialText,
      result: record.final,
      error: record.error ?? null,
      route: record.route ?? null,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      consumed: record.consumed === true,
    };
  }

  /**
   * 任务是否匹配查询。
   * @param {object} record 记录。
   * @param {{sessionId?: string, conversationKey?: string}} query 查询。
   * @returns {boolean} 是否匹配。
   */
  function matches(record, query) {
    if (typeof query.conversationKey === "string" && query.conversationKey !== "" && record.conversationKey === query.conversationKey) return true;
    if (typeof query.sessionId === "string" && query.sessionId !== "" && record.sessionId === query.sessionId) return true;
    return false;
  }

  /**
   * 查找当前查询对应的最新任务；优先 sessionId 绑定。
   * @param {{sessionId?: string, conversationKey?: string}} query 查询。
   * @returns {object | undefined} 记录。
   */
  function find(query = {}) {
    let bySession;
    let byKey;
    for (const record of jobs.values()) {
      if (record.expired === true) continue;
      if (typeof query.sessionId === "string" && query.sessionId !== "" && record.sessionId === query.sessionId) {
        if (bySession === undefined || record.updatedAt > bySession.updatedAt) bySession = record;
      }
      if (typeof query.conversationKey === "string" && query.conversationKey !== "" && record.conversationKey === query.conversationKey) {
        if (byKey === undefined || record.updatedAt > byKey.updatedAt) byKey = record;
      }
    }
    return bySession ?? byKey;
  }

  /**
   * 通知订阅者。
   * @param {object} record 记录。
   * @param {object} event 事件。
   */
  function notify(record, event) {
    for (const listener of [...record.listeners]) {
      try { listener(event); } catch (error) { log("warn", "[prompt-seed] job subscriber failed", { error: String(error) }); }
    }
  }

  /**
   * 结算任务（只一次）。
   * @param {object} record 记录。
   * @param {object} final final 事件。
   */
  function settle(record, final) {
    if (record.status !== "running") return;
    record.status = final.ok === true ? "done" : final.code === "cancelled" ? "cancelled" : "failed";
    record.final = { ...final, jobId: record.id };
    record.error = final.error ?? null;
    record.updatedAt = now();
    record.partialText = "";
    clearTimeout(record.timer);
    const listeners = [...record.listeners];
    record.listeners.clear();
    for (const listener of listeners) {
      try { listener(record.final); } catch { /* 已断 */ }
    }
    const pending = waiters.get(record.id);
    waiters.delete(record.id);
    if (pending !== undefined) {
      for (const resolve of pending) resolve(record.final);
    }
    try { record.onFinal?.(record.final, publicJob(record)); } catch (error) { log("warn", "[prompt-seed] job onFinal failed", { error: String(error) }); }
    const cleanup = setTimeout(() => {
      record.expired = true;
      timers.delete(record.id);
      jobs.delete(record.id);
    }, ttlMs);
    cleanup.unref?.();
    timers.set(record.id, cleanup);
  }

  /**
   * 驱动任务：消费 optimizeStream，累积 partial。
   * @param {object} record 记录。
   * @returns {Promise<void>} 完成。
   */
  async function drive(record) {
    try {
      const iterator = record.run(record.controller.signal)[Symbol.asyncIterator]();
      while (record.status === "running") {
        const next = await iterator.next();
        if (next.done === true) break;
        const event = next.value;
        if (event === null || typeof event !== "object") continue;
        if (record.status !== "running") break;
        if (event.type === "meta") {
          record.meta = { ...event, jobId: record.id, conversationKey: record.conversationKey };
          record.route = typeof event.route === "string" ? event.route : null;
          record.updatedAt = now();
          notify(record, record.meta);
        } else if (event.type === "delta" && typeof event.text === "string") {
          record.partialText = clamp(record.partialText + event.text, 4000);
          record.updatedAt = now();
          notify(record, { type: "delta", text: event.text, jobId: record.id });
        } else if (event.type === "final") {
          settle(record, event);
          break;
        }
      }
      try { iterator.return?.(); } catch { /* 已结束 */ }
      if (record.status === "running") {
        settle(record, {
          type: "final", ok: false, code: "llm_error", error: "任务没有返回最终结果",
          reason: "no_final", text: record.inputText, changed: false, calls: 0, jobId: record.id,
        });
      }
    } catch (error) {
      if (record.status === "running") {
        settle(record, {
          type: "final", ok: false, code: "llm_error", error: error instanceof Error ? error.message : String(error),
          reason: "llm_error", text: record.inputText, changed: false, calls: 0, jobId: record.id,
        });
      }
    }
  }

  /**
   * 清理终态最旧任务（running 永不裁剪）。
   */
  function prune() {
    if (jobs.size < maxJobs) return;
    const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const record of ordered) {
      if (jobs.size < maxJobs) break;
      if (record.status === "running") continue;
      jobs.delete(record.id);
    }
  }

  return {
    /**
     * 创建并启动任务。
     * @param {{sessionId?: string, conversationKey?: string, runId?: string, inputText: string,
     *          run: Function, onFinal?: Function}} spec 任务。
     * @returns {{ok: true, job: object} | {ok: false, code: string, error: string, job?: object}} 结果。
     */
    create(spec) {
      const conversationKey = typeof spec.conversationKey === "string" && spec.conversationKey !== ""
        ? spec.conversationKey
        : spec.sessionId ? "s:" + spec.sessionId : "draft:" + randomUUID();
      const existing = find({ sessionId: spec.sessionId, conversationKey });
      if (existing !== undefined && existing.status === "running") {
        return { ok: false, code: "job_running", error: "这个会话已有一个优化任务在运行", job: publicJob(existing) };
      }
      let running = 0;
      for (const record of jobs.values()) if (record.status === "running") running += 1;
      if (running >= maxRunning) {
        return { ok: false, code: "too_many_jobs", error: "后台任务已达上限，请等一个任务结束后再试" };
      }
      prune();
      const record = {
        id: newId(),
        conversationKey,
        sessionId: typeof spec.sessionId === "string" && spec.sessionId !== "" ? spec.sessionId : null,
        runId: typeof spec.runId === "string" ? spec.runId : null,
        status: "running",
        inputText: clamp(spec.inputText, 8000),
        partialText: "",
        final: null,
        error: null,
        route: null,
        meta: null,
        createdAt: now(),
        updatedAt: now(),
        consumed: false,
        listeners: new Set(),
        controller: new AbortController(),
        onFinal: spec.onFinal,
        run: spec.run,
        timer: null,
      };
      record.timer = setTimeout(() => {
        if (record.status !== "running") return;
        record.controller.abort();
        settle(record, {
          type: "final", ok: false, code: "request_timeout", error: "优化超时，已保留原文",
          reason: "request_timeout", text: record.inputText, changed: false, calls: 0, jobId: record.id,
        });
      }, timeoutMs);
      record.timer.unref?.();
      jobs.set(record.id, record);
      void drive(record);
      return { ok: true, job: publicJob(record) };
    },

    /**
     * 查询任务。
     * @param {{sessionId?: string, conversationKey?: string}} query 查询。
     * @returns {object | null} 公开任务。
     */
    status(query) {
      const record = find(query);
      return record === undefined ? null : publicJob(record);
    },

    /**
     * 订阅任务事件（只用于初始流式响应）。
     * @param {string} id 任务 id。
     * @param {Function} listener 监听器。
     * @returns {Function} unsubscribe。
     */
    subscribe(id, listener) {
      const record = jobs.get(id);
      if (record === undefined) return () => {};
      if (record.meta !== null) listener(record.meta);
      if (record.partialText !== "") listener({ type: "delta", text: record.partialText, jobId: record.id });
      if (TERMINAL.has(record.status) && record.final !== null) {
        listener(record.final);
        return () => {};
      }
      record.listeners.add(listener);
      return () => { record.listeners.delete(listener); };
    },

    /**
     * 等待终态。
     * @param {string} id 任务 id。
     * @returns {Promise<object | null>} final。
     */
    wait(id) {
      const record = jobs.get(id);
      if (record === undefined) return Promise.resolve(null);
      if (TERMINAL.has(record.status) && record.final !== null) return Promise.resolve(record.final);
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? new Set();
        list.add(resolve);
        waiters.set(id, list);
      });
    },

    /**
     * 绑定 unbound key 到 sessionId。
     * @param {string} conversationKey key。
     * @param {string} sessionId 会话 id。
     * @returns {object | null} 任务。
     */
    bind(conversationKey, sessionId) {
      for (const record of jobs.values()) {
        if (record.conversationKey === conversationKey) {
          record.sessionId = sessionId;
          record.updatedAt = now();
          return publicJob(record);
        }
      }
      return null;
    },

    /**
     * 显式取消。
     * @param {string} id 任务 id。
     * @returns {object | null} 任务。
     */
    cancel(id) {
      const record = jobs.get(id);
      if (record === undefined) return null;
      if (record.status === "running") {
        record.controller.abort();
        settle(record, {
          type: "final", ok: false, code: "cancelled", error: "已取消", reason: "cancelled",
          text: record.inputText, changed: false, calls: 0, jobId: record.id,
        });
      }
      return publicJob(record);
    },

    /**
     * 标记结果已取走。
     * @param {string} id 任务 id。
     * @returns {object | null} 任务。
     */
    consume(id) {
      const record = jobs.get(id);
      if (record === undefined) return null;
      record.consumed = true;
      return publicJob(record);
    },
  };
}
