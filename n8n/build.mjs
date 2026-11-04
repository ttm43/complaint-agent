#!/usr/bin/env node
// Generates the n8n workflow files in n8n/workflows/. Edit this file, not the JSON.
//   node n8n/build.mjs
//
// n8n owns the order of steps and the waiting (RPA callbacks, human approval).
// Every step itself is a call to the backend's /internal API, so the rules stay in tested code.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows");

/** Stable uuid-shaped id, so re-importing updates the same webhooks instead of creating new ones. */
const uid = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Expressions that read the original webhook request.
const IN = (field) => `$('Webhook').first().json.body.${field}`;
const BACKEND = IN("backend");

function webhook(flow, hookPath, responseMode, pos = [0, 0]) {
  return {
    id: uid(`${flow}:Webhook`), name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: pos,
    webhookId: uid(`${flow}:hook`),
    parameters: { httpMethod: "POST", path: hookPath, responseMode, options: {} },
  };
}

/** POST to the backend. `bodyExpr` is a JS object expression evaluated by n8n. */
function backendCall(flow, name, urlPath, bodyExpr, pos, extra = {}) {
  return {
    id: uid(`${flow}:${name}`), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
    parameters: {
      method: "POST",
      url: `={{ ${BACKEND} }}${urlPath}`,
      sendBody: true,
      specifyBody: "json",
      jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
      options: { timeout: 15000 },
    },
    ...extra,
  };
}

function respond(flow, name, expr, pos) {
  return {
    id: uid(`${flow}:${name}`), name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: pos,
    parameters: { respondWith: "json", responseBody: `={{ JSON.stringify(${expr}) }}`, options: {} },
  };
}

function ifNode(flow, name, leftExpr, op, right, pos) {
  return {
    id: uid(`${flow}:${name}`), name, type: "n8n-nodes-base.if", typeVersion: 2, position: pos,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: uid(`${flow}:${name}:c`), leftValue: `={{ ${leftExpr} }}`, rightValue: right, operator: op }],
        combinator: "and",
      },
      options: {},
    },
  };
}

function setNode(flow, name, fields, pos) {
  return {
    id: uid(`${flow}:${name}`), name, type: "n8n-nodes-base.set", typeVersion: 3.4, position: pos,
    parameters: {
      assignments: {
        assignments: fields.map(([n, value, type]) => ({ id: uid(`${flow}:${name}:${n}`), name: n, value: `={{ ${value} }}`, type })),
      },
      options: {},
    },
  };
}

function note(flow, name, content, pos, size = [360, 160]) {
  return {
    id: uid(`${flow}:${name}`), name, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position: pos,
    parameters: { content, width: size[0], height: size[1] },
  };
}

/** connections: [from, to, outputIndex?] */
function link(pairs) {
  const out = {};
  for (const [from, to, index = 0] of pairs) {
    out[from] ??= { main: [] };
    while (out[from].main.length <= index) out[from].main.push([]);
    out[from].main[index].push({ node: to, type: "main", index: 0 });
  }
  return out;
}

function workflow(id, name, nodes, pairs, settings = {}) {
  return {
    id, name, active: false, nodes, connections: link(pairs), pinData: {},
    settings: { executionOrder: "v1", saveManualExecutions: true, ...settings },
    meta: { templateCredsSetupCompleted: true },
  };
}

// ---------------- workflows ----------------

const flows = [];

// complaint-main: one run per call start and end. Logs onto the timeline; in production this is
// where the post-call email and the AFCA-ready record would be queued.
{
  const f = "complaint-main";
  flows.push(workflow("cmpMain000000001", "complaint-main", [
    note(f, "About", "## complaint-main\nCalled at call start and call end.\nIn production: queue the confirmation email and post-call record.", [-40, -200]),
    webhook(f, "complaint-main", "onReceived", [0, 0]),
    backendCall(f, "Log call event", "/internal/call-event",
      `{ complaintId: ${IN("complaintId")}, event: ${IN("event")}, outcome: ${IN("outcome")} }`, [260, 0]),
  ], [["Webhook", "Log call event"]]));
}

// sub-identity: verify policy number + DOB. Execution data is not saved, so the DOB never lands in n8n's log.
{
  const f = "sub-identity";
  flows.push(workflow("cmpIdentity00001", "sub-identity", [
    note(f, "About", "## sub-identity\nPolicy number + date of birth checked against the policy system.\n**Execution data is not saved** for this workflow, so the DOB is never stored in n8n.", [-40, -220]),
    webhook(f, "sub-identity", "responseNode", [0, 0]),
    backendCall(f, "Verify identity", "/internal/identity/verify",
      `{ complaintId: ${IN("complaintId")}, policyNumber: ${IN("policyNumber")}, dob: ${IN("dob")} }`, [260, 0]),
    respond(f, "Respond", "$json.data", [520, 0]),
  ], [["Webhook", "Verify identity"], ["Verify identity", "Respond"]],
  { saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveExecutionProgress: false }));
}

// sub-investigation: claims API -> retrieval -> RPA read of claim notes with retry, then report back.
{
  const f = "sub-investigation";
  const st = (k) => `$('Attempt').last().json.${k}`;
  flows.push(workflow("cmpInvestig00001", "sub-investigation", [
    note(f, "About", "## sub-investigation\n1. Claims API lookup\n2. Document retrieval (graph + vector for denials)\n3. RPA reads claim notes in the legacy system. The workflow **waits** for the robot's callback (Wait node), retries up to 3 times with back-off, then reports to the backend.", [-40, -260], [460, 200]),
    webhook(f, "sub-investigation", "onReceived", [0, 0]),
    backendCall(f, "Claims API", "/internal/investigation/claim", `{ complaintId: ${IN("complaintId")} }`, [220, 0]),
    backendCall(f, "Retrieve basis", "/internal/investigation/retrieve",
      `{ complaintId: ${IN("complaintId")}, queryText: ${IN("queryText")} }`, [440, 0]),
    setNode(f, "Attempt", [
      ["attempt", "$('Next attempt').isExecuted ? $('Next attempt').last().json.attempt : 1", "number"],
      ["claimId", "$('Claims API').first().json.data.claimId", "string"],
    ], [660, 0]),
    backendCall(f, "Queue RPA read", "/rpa/jobs",
      `{ complaintId: ${IN("complaintId")}, kind: 'read_claim_notes', payload: { claimId: ${st("claimId")} }, attempt: ${st("attempt")}, idempotencyKey: ${IN("complaintId")} + ':read_notes:' + ${st("attempt")}, callbackUrl: $execution.resumeUrl }`,
      [880, 0]),
    {
      id: uid(`${f}:Wait for robot`), name: "Wait for robot", type: "n8n-nodes-base.wait", typeVersion: 1.1, position: [1100, 0],
      webhookId: uid(`${f}:wait-hook`),
      parameters: { resume: "webhook", httpMethod: "POST", limitWaitTime: true, limitType: "afterTimeInterval", resumeAmount: 20, resumeUnit: "seconds", options: {} },
    },
    ifNode(f, "Robot OK?", "$json.body?.status", { type: "string", operation: "equals" }, "ok", [1320, 0]),
    backendCall(f, "Report success", "/internal/investigation/complete",
      `{ complaintId: ${IN("complaintId")}, rpaOk: true, notes: $json.body.result.notes ?? [], attempts: ${st("attempt")} }`, [1560, -120]),
    ifNode(f, "Attempts left?", st("attempt"), { type: "number", operation: "lt" }, `={{ ${IN("attempts")} ?? 3 }}`, [1560, 120]),
    backendCall(f, "Log retry", "/internal/n8n-log",
      `{ complaintId: ${IN("complaintId")}, type: 'n8n_retry', summary: 'RPA read attempt ' + ${st("attempt")} + ' failed, retrying in 2 s (attempt ' + (${st("attempt")} + 1) + ' of ' + (${IN("attempts")} ?? 3) + ')' }`,
      [1800, 40]),
    {
      id: uid(`${f}:Back-off`), name: "Back-off", type: "n8n-nodes-base.wait", typeVersion: 1.1, position: [2020, 40],
      webhookId: uid(`${f}:backoff-hook`),
      parameters: { resume: "timeInterval", amount: 2, unit: "seconds" },
    },
    setNode(f, "Next attempt", [["attempt", `${st("attempt")} + 1`, "number"]], [2240, 40]),
    backendCall(f, "Report failure", "/internal/investigation/complete",
      `{ complaintId: ${IN("complaintId")}, rpaOk: false, notes: [], attempts: ${st("attempt")} }`, [1800, 240]),
  ], [
    ["Webhook", "Claims API"], ["Claims API", "Retrieve basis"], ["Retrieve basis", "Attempt"],
    ["Attempt", "Queue RPA read"], ["Queue RPA read", "Wait for robot"], ["Wait for robot", "Robot OK?"],
    ["Robot OK?", "Report success", 0], ["Robot OK?", "Attempts left?", 1],
    ["Attempts left?", "Log retry", 0], ["Attempts left?", "Report failure", 1],
    ["Log retry", "Back-off"], ["Back-off", "Next attempt"], ["Next attempt", "Attempt"],
  ]));
}

// sub-resolution: LLM proposes, backend whitelist decides execute / approval / human.
{
  const f = "sub-resolution";
  flows.push(workflow("cmpResolve000001", "sub-resolution", [
    note(f, "About", "## sub-resolution\nThe model proposes an action with citations; the backend's whitelist decides: execute, needs approval, or hand to a person.", [-40, -200]),
    webhook(f, "sub-resolution", "responseNode", [0, 0]),
    backendCall(f, "Decide", "/internal/resolution/decide", `{ complaintId: ${IN("complaintId")} }`, [260, 0]),
    respond(f, "Respond", "$json.data", [520, 0]),
  ], [["Webhook", "Decide"], ["Decide", "Respond"]]));
}

// sub-human-review: pause until a person approves or rejects, then apply.
{
  const f = "sub-human-review";
  const taskId = IN("taskId");
  flows.push(workflow("cmpHumanRev00001", "sub-human-review", [
    note(f, "About", "## sub-human-review\nMoney or decision changes need a person.\nThe workflow hands its resume URL to the backend and **pauses at the Wait node** until the reviewer clicks Approve / Reject.", [-40, -220], [420, 180]),
    webhook(f, "sub-human-review", "onReceived", [0, 0]),
    {
      ...backendCall(f, "Register resume URL", "/internal/tasks/__TASK__/resume-url", `{ resumeUrl: $execution.resumeUrl }`, [260, 0]),
    },
    {
      id: uid(`${f}:Wait for reviewer`), name: "Wait for reviewer", type: "n8n-nodes-base.wait", typeVersion: 1.1, position: [520, 0],
      webhookId: uid(`${f}:wait-hook`),
      parameters: { resume: "webhook", httpMethod: "POST", limitWaitTime: true, limitType: "afterTimeInterval", resumeAmount: 5, resumeUnit: "days", options: {} },
    },
    ifNode(f, "Decided?", "$json.body?.approved", { type: "boolean", operation: "exists", singleValue: true }, "", [760, 0]),
    backendCall(f, "Apply decision", `/internal/approvals/__TASK__/apply`,
      `{ approved: $json.body.approved, by: $json.body.by ?? 'reviewer' }`, [1000, -100]),
    backendCall(f, "Escalate: no decision", "/internal/human-task",
      `{ complaintId: ${IN("complaintId")}, kind: 'handoff', reason: 'approval not decided within 5 days' }`, [1000, 120]),
  ], [
    ["Webhook", "Register resume URL"], ["Register resume URL", "Wait for reviewer"], ["Wait for reviewer", "Decided?"],
    ["Decided?", "Apply decision", 0], ["Decided?", "Escalate: no decision", 1],
  ]));
  // Task id goes into the URL path.
  for (const n of flows.at(-1).nodes) {
    if (n.parameters?.url) n.parameters.url = n.parameters.url.replace("__TASK__", `{{ ${taskId} }}`);
  }
}

// sla-check: hourly sweep of open complaints against the 30-day limit. The webhook lets the demo fire it on demand.
{
  const f = "sla-check";
  const body = (url) => ({
    id: uid(`${f}:${url}`), name: url, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    parameters: { method: "POST", url: "={{ $env.BACKEND_URL || 'http://host.docker.internal:4100' }}/internal/sla/check", options: { timeout: 15000 } },
  });
  flows.push(workflow("cmpSlaCheck00001", "sla-check", [
    note(f, "About", "## sla-check\nEvery hour: flag complaints at day 25 (owner) and day 28 (supervisor) of the 30-day limit.", [-40, -200]),
    { id: uid(`${f}:Every hour`), name: "Every hour", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } } },
    webhook(f, "sla-check", "lastNode", [0, 200]),
    { ...body("Check SLA"), position: [260, 100] },
  ], [["Every hour", "Check SLA"], ["Webhook", "Check SLA"]]));
}

fs.mkdirSync(OUT, { recursive: true });
for (const wf of flows) {
  fs.writeFileSync(path.join(OUT, `${wf.name}.json`), `${JSON.stringify(wf, null, 2)}\n`);
}
process.stdout.write(`wrote ${flows.length} workflows to ${path.relative(process.cwd(), OUT)}\n`);
