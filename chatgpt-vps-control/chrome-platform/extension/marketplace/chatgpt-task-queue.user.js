// ==UserScript==
// @name         Fabushi ChatGPT Task Queue
// @namespace    https://fabushi.app/
// @version      1.0.0
// @description  Queue ChatGPT tasks, send them sequentially, safely handle explicit @ChatGPT confirmations, retry failures, and show status.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  if (!HOSTS.has(location.hostname)) return;

  const STORAGE_KEY = "fabushi.chatgptTaskQueue.v1";
  const MAX_RETRIES = 2;
  const POLL_MS = 1000;
  const COMPLETION_STABLE_MS = 1800;
  const LOGIN_OR_CHALLENGE = /(log in|sign in|verify you are human|captcha|challenge|two-factor|2fa|one-time code|security code)/i;
  const SENSITIVE = /(password|passcode|secret|api key|token|payment|credit card|bank|wire|purchase|buy|checkout|delete|remove account|publish|deploy production|send email|send message|post publicly|share publicly|change permission|grant access|sudo|root|ssh key|private key)/i;
  const CONFIRM_WORDS = /(confirm|approve|allow|authorize|continue|yes,? (?:do|proceed)|run|execute)/i;
  const EXPLICIT_CHATGPT = /@chatgpt/i;

  const state = loadState();
  let running = false;
  let observer = null;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        history: Array.isArray(parsed.history) ? parsed.history.slice(-30) : [],
        autoConfirm: parsed.autoConfirm !== false,
      };
    } catch {
      return { queue: [], history: [], autoConfirm: true };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function el(tag, attrs = {}, text = "") {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "type") node.type = value;
      else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  }

  const host = el("div", { id: "fabushi-task-queue-root" });
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;font:13px/1.4 system-ui,sans-serif;color:#111";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .panel{width:330px;max-height:72vh;overflow:auto;background:#fff;border:1px solid #d9d9df;border-radius:14px;box-shadow:0 12px 40px #0003;padding:12px}
      h3{margin:0 0 8px;font-size:15px}.row{display:flex;gap:6px;align-items:center}.grow{flex:1}
      textarea{width:100%;box-sizing:border-box;min-height:68px;resize:vertical;border:1px solid #ccc;border-radius:8px;padding:8px;font:inherit}
      button{border:1px solid #ccc;background:#f7f7f8;border-radius:8px;padding:6px 9px;cursor:pointer;font:inherit}button.primary{background:#111;color:#fff;border-color:#111}button:disabled{opacity:.5;cursor:not-allowed}
      .status{margin:8px 0;padding:7px 8px;background:#f5f5f5;border-radius:8px;word-break:break-word}.task{padding:7px 0;border-top:1px solid #eee}.meta{font-size:11px;color:#666}.danger{color:#9b1c1c}.ok{color:#176b35}.muted{color:#666}.compact{font-size:12px}.title{font-weight:600}.toggle{display:flex;gap:5px;align-items:center;margin:7px 0}.queue{margin-top:6px}
    </style>
    <div class="panel">
      <h3>Fabushi · ChatGPT Task Queue</h3>
      <textarea id="task" placeholder="Enter a task to send to ChatGPT"></textarea>
      <div class="row" style="margin-top:6px"><button id="add" class="primary">Add task</button><button id="run">Run queue</button><button id="pause">Pause</button></div>
      <label class="toggle"><input id="auto" type="checkbox">Auto-confirm safe explicit @ChatGPT prompts</label>
      <div id="status" class="status">Idle</div>
      <div id="queue" class="queue"></div>
    </div>`;
  document.documentElement.append(host);

  const $ = (selector) => shadow.querySelector(selector);
  const taskInput = $("#task");
  const statusNode = $("#status");
  const queueNode = $("#queue");
  const autoNode = $("#auto");
  autoNode.checked = state.autoConfirm;

  function setStatus(text, kind = "") {
    statusNode.textContent = text;
    statusNode.className = `status ${kind}`;
  }

  function render() {
    queueNode.replaceChildren();
    if (!state.queue.length) queueNode.append(el("div", { class: "muted compact" }, "Queue is empty."));
    for (const item of state.queue) {
      const row = el("div", { class: "task" });
      row.append(el("div", { class: "title" }, item.text));
      row.append(el("div", { class: "meta" }, `${item.status || "queued"} · attempt ${item.attempts || 0}/${MAX_RETRIES + 1}`));
      queueNode.append(row);
    }
  }

  function addTask(text) {
    const cleaned = String(text || "").trim();
    if (!cleaned) return;
    state.queue.push({ id: uid(), text: cleaned, status: "queued", attempts: 0, createdAt: Date.now() });
    saveState();
    render();
  }

  function visible(node) {
    if (!(node instanceof HTMLElement)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function composer() {
    const candidates = [
      document.querySelector("#prompt-textarea"),
      document.querySelector('textarea[data-id="root"]'),
      document.querySelector('textarea[placeholder*="Message"]'),
      document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]'),
      document.querySelector('div[contenteditable="true"]'),
    ];
    return candidates.find((node) => node && visible(node));
  }

  function setComposerText(node, text) {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
      if (setter) setter.call(node, text); else node.value = text;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    node.textContent = text;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function sendButton() {
    return [...document.querySelectorAll("button")].find((button) => {
      if (!visible(button) || button.disabled) return false;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""}`;
      return /(send|submit)/i.test(label) && !/(stop)/i.test(label);
    });
  }

  async function sendTask(text) {
    const input = composer();
    if (!input) throw new Error("ChatGPT composer not found. Log in and open a conversation manually.");
    if (LOGIN_OR_CHALLENGE.test(document.body.innerText.slice(0, 12000))) {
      throw new Error("Login or verification challenge detected; manual action required.");
    }
    setComposerText(input, text);
    await sleep(180);
    const button = sendButton();
    if (button) button.click();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }

  function stopGeneratingVisible() {
    return [...document.querySelectorAll("button")].some((button) => visible(button) && /(stop generating|stop responding|stop)/i.test(button.getAttribute("aria-label") || button.textContent || ""));
  }

  function candidateConfirmationButtons() {
    return [...document.querySelectorAll("button")].filter((button) => {
      if (!visible(button) || button.disabled) return false;
      const text = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.trim();
      return CONFIRM_WORDS.test(text);
    });
  }

  function surroundingText(button) {
    const container = button.closest('[role="dialog"], [data-testid*="modal"], form, section, article, div');
    return (container?.innerText || button.parentElement?.innerText || "").slice(0, 4000);
  }

  function classifyConfirmation(button) {
    const context = surroundingText(button);
    if (LOGIN_OR_CHALLENGE.test(context)) return { safe: false, reason: "login/verification challenge" };
    if (SENSITIVE.test(context)) return { safe: false, reason: "sensitive operation" };
    if (!EXPLICIT_CHATGPT.test(context)) return { safe: false, reason: "confirmation is not explicitly addressed to @ChatGPT" };
    if (!CONFIRM_WORDS.test(context)) return { safe: false, reason: "unknown authorization wording" };
    return { safe: true, reason: "explicit @ChatGPT low-risk confirmation" };
  }

  function maybeAutoConfirm() {
    for (const button of candidateConfirmationButtons()) {
      const decision = classifyConfirmation(button);
      if (!decision.safe) {
        setStatus(`Manual confirmation required: ${decision.reason}.`, "danger");
        continue;
      }
      if (!state.autoConfirm) {
        setStatus("Safe confirmation detected; auto-confirm is disabled.");
        continue;
      }
      button.click();
      setStatus(`Auto-confirmed: ${decision.reason}.`, "ok");
      return true;
    }
    return false;
  }

  async function waitForCompletion(timeoutMs = 10 * 60 * 1000) {
    const started = Date.now();
    let seenGenerating = false;
    let quietSince = 0;
    while (Date.now() - started < timeoutMs) {
      if (!HOSTS.has(location.hostname)) throw new Error("Navigation left the approved ChatGPT hosts.");
      maybeAutoConfirm();
      const generating = stopGeneratingVisible();
      if (generating) {
        seenGenerating = true;
        quietSince = 0;
      } else if (seenGenerating) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= COMPLETION_STABLE_MS) return;
      }
      await sleep(POLL_MS);
    }
    throw new Error("Timed out waiting for ChatGPT to finish.");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function processQueue() {
    if (running) return;
    running = true;
    $("#run").disabled = true;
    try {
      while (running) {
        const item = state.queue.find((entry) => entry.status !== "done");
        if (!item) break;
        item.attempts = Number(item.attempts || 0) + 1;
        item.status = "sending";
        saveState(); render();
        setStatus(`Sending task ${item.id} (attempt ${item.attempts})…`);
        try {
          await sendTask(item.text);
          item.status = "waiting";
          saveState(); render();
          setStatus("Waiting for ChatGPT reply to complete…");
          await waitForCompletion();
          item.status = "done";
          item.completedAt = Date.now();
          state.history.push({ ...item });
          state.queue = state.queue.filter((entry) => entry.id !== item.id);
          saveState(); render();
          setStatus("Task completed.", "ok");
        } catch (error) {
          const message = error?.message || String(error);
          if (/manual action required|manual confirmation required|login|verification|challenge|approved ChatGPT hosts/i.test(message)) {
            item.status = "blocked";
            saveState(); render();
            setStatus(message, "danger");
            running = false;
            break;
          }
          if (item.attempts <= MAX_RETRIES) {
            item.status = "retrying";
            saveState(); render();
            setStatus(`Failed: ${message}. Retrying…`, "danger");
            await sleep(1500 * item.attempts);
          } else {
            item.status = "failed";
            item.error = message;
            state.history.push({ ...item });
            state.queue = state.queue.filter((entry) => entry.id !== item.id);
            saveState(); render();
            setStatus(`Task failed after retries: ${message}`, "danger");
          }
        }
      }
    } finally {
      running = false;
      $("#run").disabled = false;
      if (!state.queue.length) setStatus("Queue complete.", "ok");
    }
  }

  $("#add").addEventListener("click", () => { addTask(taskInput.value); taskInput.value = ""; });
  $("#run").addEventListener("click", () => void processQueue());
  $("#pause").addEventListener("click", () => { running = false; setStatus("Paused."); });
  autoNode.addEventListener("change", () => { state.autoConfirm = autoNode.checked; saveState(); });
  taskInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault(); addTask(taskInput.value); taskInput.value = ""; void processQueue();
    }
  });

  observer = new MutationObserver(() => { if (running) maybeAutoConfirm(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => observer?.disconnect(), { once: true });

  render();
  window.dispatchEvent(new CustomEvent("fabushi:userscript-ready", { detail: { id: "userscript-chatgpt-task-queue", version: "1.0.0" } }));
})();
