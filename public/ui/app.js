// Demo page: plays a scripted call against the backend and shows everything the backend logs.
// The page only drives the customer side; every decision comes from the backend's event stream.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CATEGORIES = ["claim_delay", "claim_denial", "payout_amount", "repair_quality"];
const OTHERS = ["s3", "s4", "s6", "s9"];
const CHAT_TYPES = new Set(["agent_said", "customer_said", "await_customer"]);

const state = {
  scenarios: [],
  scenario: null,
  complaintId: null,
  turnIndex: 0,
  events: [],          // every event seen on the stream
  handled: new Set(),  // event seqs the call driver has acted on
  lastSeq: 0,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const env = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!env.success) throw new Error(env.error ?? `HTTP ${res.status}`);
  return env.data;
}

function toast(msg) {
  line(`⚠ ${msg}`);
}

// ---------- audio: one queue so agent and customer never talk over each other ----------
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => toast(e.message)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function play(audioId, text) {
  const fallbackMs = Math.min(6000, 400 + text.length * 55);
  if ($("#skip").checked) return sleep(150);
  if (!audioId) return sleep(fallbackMs);
  return new Promise((resolve) => {
    const a = new Audio(`/audio/${audioId}.wav`);
    a.muted = $("#mute").checked;
    a.playbackRate = $("#fast").checked ? 1.1 : 1;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    a.onended = finish;
    // Clip not rendered yet: wait about as long as it would take to say.
    a.onerror = () => sleep(fallbackMs).then(finish);
    a.play().catch(() => sleep(fallbackMs).then(finish));
  });
}

// ---------- transcript ----------
function clearTranscript() {
  $("#transcript").innerHTML = "";
}

function bubble(who, html) {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.innerHTML = html;
  $("#transcript").append(el);
  el.scrollIntoView({ block: "end", behavior: "smooth" });
  return el;
}

function line(text) {
  const el = document.createElement("div");
  el.className = "sys-line";
  el.textContent = text;
  $("#transcript").append(el);
  el.scrollIntoView({ block: "end" });
}

function agentSays(e) {
  const phrase = e.detail.phraseId ? `<span class="phrase">${esc(e.detail.phraseId)}</span>` : `<span class="phrase">generated</span>`;
  enqueue(async () => {
    const el = bubble("agent", `<span class="who">Agent ${phrase}</span>${esc(e.summary)}`);
    el.classList.add("playing");
    await play(e.detail.audioId, e.summary);
    el.classList.remove("playing");
  });
}

function customerTurn(expects) {
  const s = state.scenario;
  const t = s?.turns[state.turnIndex];
  if (!t) {
    enqueue(async () => line("(script has no more customer lines)"));
    return;
  }
  state.turnIndex += 1;
  const id = state.complaintId;
  enqueue(async () => {
    if (t.keypad || expects === "keypad") {
      await typeKeypad(t.keypad ?? "");
      bubble("customer", `<span class="who">${esc(s.customer.name)} · keypad</span>${esc(t.keypad)} #`);
    } else {
      const heard = t.asr ?? "";
      const differs = heard.trim() !== t.say.trim();
      const el = bubble("customer",
        `<span class="who">${esc(s.customer.name)}</span>${esc(t.say)}` +
        (differs ? `<div class="heard">ASR heard: “${esc(heard)}” (${t.confidence ?? "?"})</div>` : ""));
      el.classList.add("playing");
      await play(t.audioId, t.say);
      el.classList.remove("playing");
    }
    // Not awaited: during investigation the backend keeps talking (hold lines) before it answers.
    api(`/complaints/${id}/turns`, { method: "POST", body: { text: t.asr ?? "", say: t.say, confidence: t.confidence, keypad: t.keypad } })
      .catch((err) => toast(`turn failed: ${err.message}`));
  });
}

async function typeKeypad(digits) {
  const pad = $("#keypad");
  pad.hidden = false;
  $("#keyDisplay").textContent = "";
  for (const d of digits) {
    const key = [...document.querySelectorAll("#keys span")].find((k) => k.textContent === d);
    key?.classList.add("hit");
    $("#keyDisplay").textContent += d;
    await sleep($("#skip").checked ? 60 : 350);
    key?.classList.remove("hit");
  }
  await sleep(250);
  pad.hidden = true;
}

function buildKeypad() {
  $("#keys").innerHTML = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => `<span>${k}</span>`).join("");
}

// ---------- event stream ----------
function connect() {
  const src = new EventSource(`/events/stream?since=${state.lastSeq}`);
  src.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.seq <= state.lastSeq) return;
    state.lastSeq = e.seq;
    state.events.push(e);
    onEvent(e);
  };
  src.onerror = () => {
    src.close();
    setTimeout(connect, 1500);
  };
}

function onEvent(e) {
  if (e.complaintId && e.complaintId === state.complaintId) drive(e);
  if (e.complaintId === selected()) appendTimeline(e);
  if (["state_changed", "human_task", "approval", "review", "task_done", "classified", "complaint_created"].includes(e.type)) refreshSoon();
}

function drive(e) {
  if (state.handled.has(e.seq)) return;
  state.handled.add(e.seq);
  if (e.type === "agent_said") agentSays(e);
  else if (e.type === "await_customer") customerTurn(e.detail.expects);
  else if (e.type === "call_ended") {
    enqueue(async () => {
      line(e.summary);
      document.querySelectorAll(".scn.running").forEach((b) => b.classList.remove("running"));
      state.complaintId = null;
    });
  }
}

// ---------- side panel ----------
let viewing = null;
const selected = () => viewing;

function select(id) {
  viewing = id;
  renderTimeline();
  refreshCard();
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshCard();
    refreshQueue();
    if (!$("#tab-review").hidden) refreshReview();
    if (!$("#tab-all").hidden) refreshAll();
  }, 150);
}

async function refreshCard() {
  const id = selected();
  if (!id) return;
  try {
    const c = await api(`/complaints/${id}`);
    const sla = c.sla ? `${c.sla.daysLeft} days left${c.sla.level !== "ok" ? ` · <b>${esc(c.sla.level)}</b>` : ""}` : "";
    $("#card").innerHTML = `
      <h3>${esc(c.id)} <span class="state ${esc(c.state)}">${esc(c.state)}</span>
        ${c.priority === "high" ? '<span class="prio-high">HIGH PRIORITY</span>' : ""}</h3>
      <div class="facts">
        <span>Category: <b>${esc(c.category ?? "—")}</b>${c.categoryConfidence ? ` (${c.categoryConfidence})` : ""}</span>
        <span>Policy: <b>${esc(c.policyNumber ?? "—")}</b></span>
        <span>PDS: <b>${esc(c.pdsVersion ?? "—")}</b></span>
        <span>Claim: <b>${esc(c.claimId ?? "—")}</b></span>
        <span>Received: ${esc(new Date(c.receivedAt).toLocaleString())}</span>
        <span>SLA: ${sla}</span>
      </div>
      ${c.state === "CLOSED" ? reopenForm(c) : ""}`;
    $("#reopenBtn")?.addEventListener("click", () => doReopen(c.id));
  } catch (err) {
    $("#card").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function reopenForm(c) {
  const opts = [`<option value="">same category</option>`, ...CATEGORIES.map((k) => `<option value="${k}">${k}</option>`)].join("");
  return `<div class="reopen">Simulate customer reply “not solved”:
    <select id="reopenCat" title="What the category should have been">${opts}</select>
    <button id="reopenBtn" class="danger">Not solved</button></div>`;
}

async function doReopen(id) {
  const cat = $("#reopenCat").value || null;
  try {
    await api(`/complaints/${id}/reopen`, { method: "POST", body: { correctedCategory: cat, text: "No, this didn't fix it. It's really about the amount they offered." } });
  } catch (err) {
    toast(err.message);
  }
}

// timeline
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });

function renderTimeline() {
  const box = $("#tab-timeline");
  box.innerHTML = "";
  const id = selected();
  if (!id) {
    box.innerHTML = `<p class="empty">Start a call or pick a complaint.</p>`;
    return;
  }
  state.events.filter((e) => e.complaintId === id).forEach(appendTimeline);
}

function appendTimeline(e) {
  if (CHAT_TYPES.has(e.type)) return;
  const box = $("#tab-timeline");
  box.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `ev ${e.type}`;
  el.innerHTML = `<span class="ts">${fmtTime(e.ts)}</span><span class="chip ${esc(e.actor)}">${esc(e.actor)}</span>
    <div class="msg">${esc(e.summary)}${extra(e)}</div>`;
  box.append(el);
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

function extra(e) {
  const d = e.detail ?? {};
  if (e.type === "retrieval" && Array.isArray(d.chunks)) {
    const chunks = d.chunks.map((c) => `<div class="clause"><span class="cid">${esc(c.chunkId)}</span> · ${esc(c.title)} · score ${c.score}<br>${esc(c.text)}</div>`).join("");
    const rels = (d.relations ?? []).map((r) => `<div class="rel">${esc(r.from)} —${esc(r.relation)}→ ${esc(r.to)}</div>`).join("");
    return `<details><summary>${d.chunks.length} passages${rels ? `, ${d.relations.length} graph links` : ""} · ${d.latencyMs ?? "?"} ms</summary>${chunks}${rels}</details>`;
  }
  if (e.type === "classified" && d.probabilities) {
    const rows = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1])
      .map(([k, p]) => `<div>${esc(k)} <span class="bar" style="width:${Math.round(p * 120)}px"></span> ${p}</div>`).join("");
    return `<details><summary>probabilities</summary>${rows}</details>`;
  }
  if (e.type === "decision" && d.citationProblems?.length) {
    return `<details open><summary>citation problems</summary>${d.citationProblems.map((p) => `<div>${esc(typeof p === "string" ? p : JSON.stringify(p))}</div>`).join("")}</details>`;
  }
  if (e.type === "action_requested" && d.action) {
    return `<details><summary>action</summary><pre>${esc(JSON.stringify(d.action, null, 2))}</pre></details>`;
  }
  return "";
}

// queue
async function refreshQueue() {
  try {
    const tasks = await api("/api/tasks");
    $("#queueCount").textContent = String(tasks.length);
    const box = $("#tab-queue");
    if (!tasks.length) {
      box.innerHTML = `<p class="empty">Queue is empty.</p>`;
      return;
    }
    box.innerHTML = tasks.map(taskCard).join("");
    box.querySelectorAll("[data-decide]").forEach((b) => b.addEventListener("click", () => decideTask(b.dataset.task, b.dataset.decide === "yes")));
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { select(b.dataset.open); showTab("timeline"); }));
    tasks.filter((t) => t.kind === "closure_review").forEach(fillCompare);
  } catch (err) {
    toast(err.message);
  }
}

function taskCard(t) {
  const decidable = t.kind === "approval" || t.kind === "closure_review";
  const btns = decidable
    ? `<button data-task="${t.id}" data-decide="yes">${t.kind === "approval" ? "Approve" : "Close it"}</button>
       <button class="danger" data-task="${t.id}" data-decide="no">Reject</button>`
    : `<button class="ghost" data-task="${t.id}" data-decide="yes">Pick up</button>`;
  return `<div class="task ${t.priority === "high" ? "high" : ""}">
    <div class="row"><span><b>${esc(t.kind)}</b> · <a href="#" data-open="${t.complaintId}">${esc(t.complaintId)}</a></span><span class="btns">${btns}</span></div>
    <div>${esc(t.summary)}</div>
    ${t.kind === "closure_review" ? `<div class="compare" id="cmp-${t.id}"><div>…</div><div>…</div></div>` : ""}
    ${t.resumeUrl ? `<div class="muted">waiting in n8n (Wait node)</div>` : ""}
  </div>`;
}

/** Closure review shows what the customer said next to the clause the agent relied on. */
async function fillCompare(t) {
  const box = document.getElementById(`cmp-${t.id}`);
  if (!box) return;
  try {
    const [c, events] = await Promise.all([api(`/complaints/${t.complaintId}`), api(`/complaints/${t.complaintId}/events`)]);
    // Only what was said after identity checks, so the reviewer never sees the date of birth.
    const from = events.findIndex((e) => e.type === "await_customer" && e.detail.phase === "complaint");
    const said = events.slice(Math.max(from, 0)).filter((e) => e.type === "customer_said" && !e.detail.keypad).map((e) => e.summary);
    const cited = events.find((e) => e.type === "action_requested")?.detail.action?.citations ?? [];
    const chunks = (c.retrieval?.chunks ?? []).filter((ch) => cited.includes(ch.chunkId));
    box.innerHTML = `<div><h4>Customer said</h4>${said.map((s) => `<p>“${esc(s)}”</p>`).join("")}</div>
      <div><h4>Cited clauses</h4>${chunks.map((ch) => `<div class="clause"><span class="cid">${esc(ch.chunkId)}</span> ${esc(ch.text)}</div>`).join("") || "<p>none</p>"}
      <p class="muted">${esc(t.detail.resolutionText ?? "")}</p></div>`;
  } catch (err) {
    box.innerHTML = `<div>${esc(err.message)}</div>`;
  }
}

async function decideTask(taskId, approved) {
  try {
    await api(`/reviews/${taskId}/decision`, { method: "POST", body: { approved, by: "demo reviewer" } });
    refreshSoon();
  } catch (err) {
    toast(err.message);
  }
}

// review stats
async function refreshReview() {
  try {
    const s = await api("/api/review-stats");
    $("#tab-review").innerHTML = `
      <p>Target error rate ≤ ${s.target * 100}%. A category moves to sampling (${s.sampleRate * 100}%) once the 95% upper bound on its error rate is below target. Any silent error sends it back to full review.</p>
      <table class="stats"><thead><tr><th>Category</th><th>Reviewed</th><th>Misclassified</th><th>Wrong citation</th><th>Upper bound</th><th>Mode</th><th></th></tr></thead>
      <tbody>${s.categories.map((c) => `<tr>
        <td>${esc(c.category)}</td><td>${c.reviewed}</td><td>${c.misclassified}</td><td>${c.wrongCitation}</td>
        <td>${(c.upperBound * 100).toFixed(2)}%</td><td><b>${esc(c.configuredMode)}</b>${c.mode !== c.configuredMode ? ` (eligible: ${esc(c.mode)})` : ""}</td>
        <td><button class="ghost" data-preset="${c.category}">Preset 300 clean</button></td></tr>`).join("")}</tbody></table>`;
    $("#tab-review").querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => preset(b.dataset.preset)));
  } catch (err) {
    $("#tab-review").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

async function preset(category) {
  try {
    await api(`/api/review-stats/${category}`, { method: "POST", body: { reviewed: 300, misclassified: 0, wrongCitation: 0, mode: "sample" } });
    refreshReview();
  } catch (err) {
    toast(err.message);
  }
}

// all complaints
async function refreshAll() {
  try {
    const list = await api("/complaints");
    $("#tab-all").innerHTML = `<table class="stats"><thead><tr><th>ID</th><th>State</th><th>Category</th><th>Scenario</th><th>SLA</th></tr></thead><tbody>${
      list.map((c) => `<tr><td><a href="#" data-open="${c.id}">${esc(c.id)}</a></td><td><span class="state ${esc(c.state)}">${esc(c.state)}</span></td>
        <td>${esc(c.category ?? "—")}</td><td>${esc(c.scenarioId ?? "historic")}</td><td>${c.sla ? `${c.sla.daysLeft} days left${c.sla.level !== "ok" ? ` · <b>${esc(c.sla.level)}</b>` : ""}` : ""}</td></tr>`).join("")
    }</tbody></table>`;
    $("#tab-all").querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); select(a.dataset.open); showTab("timeline"); }));
  } catch (err) {
    $("#tab-all").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === "review") refreshReview();
  if (name === "all") refreshAll();
  if (name === "queue") refreshQueue();
}

// ---------- scenarios ----------
async function startCall(s, btn) {
  if (state.complaintId) {
    toast("A call is already in progress");
    return;
  }
  chain = Promise.resolve();
  clearTranscript();
  state.scenario = s;
  state.turnIndex = 0;
  document.querySelectorAll(".scn").forEach((b) => b.classList.remove("running"));
  btn.classList.add("running");
  line(`Incoming call: ${s.customer.name} — ${s.title}`);
  try {
    const { complaintId } = await api("/complaints", { method: "POST", body: { callId: `CALL-${s.id}-${Date.now()}`, scenarioId: s.id } });
    state.complaintId = complaintId;
    select(complaintId);
    // Events that arrived before we knew the id.
    state.events.filter((e) => e.complaintId === complaintId).forEach(drive);
  } catch (err) {
    btn.classList.remove("running");
    toast(err.message);
  }
}

async function runOthers() {
  const btn = $("#runOthers");
  btn.disabled = true;
  const box = $("#batch");
  box.hidden = false;
  box.textContent = `Running ${OTHERS.join(", ")}…`;
  try {
    const results = await api("/api/demo/run-all", { method: "POST", body: { scenarioIds: OTHERS } });
    box.innerHTML = results.map((r) => {
      const title = state.scenarios.find((s) => s.id === r.scenarioId)?.title ?? r.scenarioId;
      return `<div><span class="${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"}</span> ${esc(r.scenarioId)} ${esc(title)} → ${esc(r.finalState)}
        <a href="#" data-open="${r.complaintId}">timeline</a></div>`;
    }).join("");
    box.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); select(a.dataset.open); showTab("timeline"); }));
  } catch (err) {
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  buildKeypad();
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#runOthers").addEventListener("click", runOthers);
  try {
    const info = await api("/api/info");
    $("#orch").textContent = `orchestrator: ${info.orchestrator}`;
    state.scenarios = await api("/api/scenarios");
  } catch (err) {
    $("#scenarios").innerHTML = `<p class="empty">Backend not reachable: ${esc(err.message)}</p>`;
    return;
  }
  $("#scenarios").innerHTML = state.scenarios.map((s) =>
    `<button class="scn ${s.featured ? "featured" : ""}" data-id="${s.id}">${s.featured ? "★ " : ""}${esc(s.id)} ${esc(s.title)}<span class="tag">${esc(s.tests ?? "")}</span></button>`).join("");
  $("#scenarios").querySelectorAll(".scn").forEach((b) => b.addEventListener("click", () => startCall(state.scenarios.find((s) => s.id === b.dataset.id), b)));
  renderTimeline();
  refreshQueue();
  connect();
}

init();
