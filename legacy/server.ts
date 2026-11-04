import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";

// A deliberately old-fashioned claims + complaints system with no API: HTML forms only.
// The RPA worker drives it with the keyboard, the way it would drive the real thing.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LEGACY_PORT ?? 4200);
const STORE = path.join(ROOT, "var", "legacy.json");
const DAY = 24 * 60 * 60 * 1000;

interface Note { readonly date: string; readonly author: string; readonly text: string }
interface ComplaintRecord { readonly ref: string; readonly policy: string; readonly category: string; readonly received: string; readonly status: string; readonly summary: string; readonly updated: string }
interface Store { readonly notes: Record<string, Note[]>; readonly complaints: Record<string, ComplaintRecord> }

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const SeedSchema = z.object({ claimNotes: z.record(z.string(), z.array(z.object({ daysAgo: z.number(), author: z.string(), text: z.string() }))) });

function seed(): Store {
  const raw = SeedSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "data", "legacy-seed.json"), "utf8")));
  const notes = Object.fromEntries(
    Object.entries(raw.claimNotes).map(([id, list]) => [id, list.map((n) => ({ date: day(Date.now() - n.daysAgo * DAY), author: n.author, text: n.text }))]),
  );
  return { notes, complaints: {} };
}

function load(): Store {
  if (process.env.LEGACY_RESET === "1" || !fs.existsSync(STORE)) return seed();
  return JSON.parse(fs.readFileSync(STORE, "utf8")) as Store;
}

let store = load();
const persist = (next: Store) => {
  store = next;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
};
persist(store);

// Everything a demo run writes: file notes by the robot and every register entry (the seed has none).
const ROBOT = "rpa.bot";
const demoWrites = (s: Store) => ({
  notes: Object.values(s.notes).flat().filter((n) => n.author === ROBOT).length,
  complaints: Object.keys(s.complaints).length,
});
const withoutDemoWrites = (s: Store): Store => ({
  notes: Object.fromEntries(Object.entries(s.notes).map(([id, list]) => [id, list.filter((n) => n.author !== ROBOT)])),
  complaints: {},
});

const clearBox = () => {
  const w = demoWrites(store);
  // No confirm(): the robot's Playwright browser silently dismisses dialogs, which made the button look dead.
  return `<form method="post" action="/demo/clear">
<fieldset><legend>Demo data</legend>Added by demo runs: <b id="demoComplaints">${w.complaints}</b> complaint(s), <b id="demoNotes">${w.notes}</b> robot note(s).
<button id="clearDemo" type="submit">Clear demo data</button></fieldset></form>`;
};
const clearedMsg = (q: unknown) => (q === "1" ? `<p id="cleared" style="background:#ffffe1;border:1px solid #888;padding:4px 8px">Demo data cleared. Original claim notes kept.</p>` : "");

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - ClaimsCentre 4</title>
<style>
body{font:13px Tahoma,Verdana,sans-serif;background:#d4d0c8;margin:0;color:#000}
.bar{background:linear-gradient(#0a246a,#3a6ea5);color:#fff;padding:4px 8px;font-weight:bold}
.wrap{padding:12px} fieldset{background:#ece9d8;border:1px solid #888;margin-bottom:10px}
table{border-collapse:collapse;background:#fff} td,th{border:1px solid #999;padding:3px 6px;text-align:left}
th{background:#ece9d8} input,select,textarea{font:13px Tahoma;border:2px inset #fff}
.err{background:#fff;border:2px solid #c00;color:#c00;padding:10px;font-family:monospace}
label{display:inline-block;width:110px} a{color:#00c}
</style></head><body><div class="bar">ClaimsCentre 4.2 &mdash; ${esc(title)}</div><div class="wrap">
<a href="/">Main menu</a> | <a href="/claims">Claims</a> | <a href="/complaints">Complaints register</a><hr>${body}</div></body></html>`;

const app = express();
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.get("/", (req, res) => {
  res.send(page("Main menu", `${clearedMsg(req.query["cleared"])}<p>Welcome. Select a module.</p><ul><li><a href="/claims">Claims enquiry</a></li><li><a href="/complaints">Complaints register</a></li></ul>${clearBox()}`));
});

app.post("/demo/clear", (req, res) => {
  persist(withoutDemoWrites(store));
  const back = req.get("referer")?.includes("/complaints") ? "/complaints" : "/";
  res.redirect(`${back}?cleared=1`);
});

app.get("/claims", (_req, res) => {
  res.send(page("Claims enquiry", `<form method="get" action="/claims/view"><fieldset><legend>Find claim</legend>
<label for="claimId">Claim number</label><input id="claimId" name="id" autofocus> <button type="submit">Search</button></fieldset></form>`));
});

app.get("/claims/view", (req, res) => {
  const id = String(req.query["id"] ?? "").trim().toUpperCase();
  if (id === "CLM-FAIL") {
    res.status(500).send(page("System error", `<div class="err" id="error">System error 500<br>ORA-03113: end-of-file on communication channel<br>Session terminated.</div>`));
    return;
  }
  const notes = store.notes[id];
  if (!notes) {
    res.status(404).send(page("Claims enquiry", `<p id="notfound">No record found for ${esc(id)}.</p>`));
    return;
  }
  const rows = notes.map((n) => `<tr><td>${esc(n.date)}</td><td>${esc(n.author)}</td><td class="note">${esc(n.text)}</td></tr>`).join("");
  res.send(page(`Claim ${id}`, `<h3 id="claimTitle">Claim ${esc(id)}</h3>
<table id="notes"><tr><th>Date</th><th>By</th><th>Note</th></tr>${rows}</table>
<form method="post" action="/claims/note"><fieldset><legend>Add file note</legend><input type="hidden" name="id" value="${esc(id)}">
<textarea id="note" name="note" rows="3" cols="70"></textarea><br><button id="saveNote" type="submit">Save note</button></fieldset></form>`));
});

app.post("/claims/note", (req, res) => {
  const id = String(req.body["id"] ?? "");
  const text = String(req.body["note"] ?? "").trim().slice(0, 1000);
  const existing = store.notes[id];
  if (!existing || !text) {
    res.status(400).send(page("Error", `<div class="err">Note not saved.</div>`));
    return;
  }
  persist({ ...store, notes: { ...store.notes, [id]: [...existing, { date: day(Date.now()), author: "rpa.bot", text }] } });
  res.redirect(`/claims/view?id=${encodeURIComponent(id)}`);
});

const CATEGORY_OPTIONS = ["unclassified", "claim_delay", "claim_denial", "payout_amount", "repair_quality"];

app.get("/complaints", (req, res) => {
  const rows = Object.values(store.complaints)
    .map((c) => `<tr><td><a href="/complaints/view?ref=${encodeURIComponent(c.ref)}">${esc(c.ref)}</a></td><td>${esc(c.policy)}</td><td>${esc(c.category)}</td><td>${esc(c.status)}</td><td>${esc(c.received)}</td></tr>`)
    .join("");
  res.send(page("Complaints register", `${clearedMsg(req.query["cleared"])}<form method="post" action="/complaints/save"><fieldset><legend>Register / update complaint</legend>
<label for="ref">Reference</label><input id="ref" name="ref" autofocus><br>
<label for="policy">Policy</label><input id="policy" name="policy"><br>
<label for="category">Category</label><select id="category" name="category">${CATEGORY_OPTIONS.map((o) => `<option>${o}</option>`).join("")}</select><br>
<label for="received">Received</label><input id="received" name="received"><br>
<label for="status">Status</label><input id="status" name="status"><br>
<label for="summary">Summary</label><input id="summary" name="summary" size="60"><br>
<button id="saveComplaint" type="submit">Save</button></fieldset></form>
<table id="register"><tr><th>Ref</th><th>Policy</th><th>Category</th><th>Status</th><th>Received</th></tr>${rows}</table>${clearBox()}`));
});

const ComplaintForm = z.object({
  ref: z.string().min(1).max(32), policy: z.string().max(16), category: z.string().max(32),
  received: z.string().max(40), status: z.string().max(40), summary: z.string().max(300),
});

app.post("/complaints/save", (req, res) => {
  const parsed = ComplaintForm.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).send(page("Error", `<div class="err">Complaint not saved: missing fields.</div>`));
    return;
  }
  const rec: ComplaintRecord = { ...parsed.data, updated: new Date().toISOString() };
  persist({ ...store, complaints: { ...store.complaints, [rec.ref]: rec } });
  res.redirect(`/complaints/view?ref=${encodeURIComponent(rec.ref)}`);
});

app.get("/complaints/view", (req, res) => {
  const c = store.complaints[String(req.query["ref"] ?? "")];
  if (!c) {
    res.status(404).send(page("Complaints register", `<p id="notfound">No complaint found.</p>`));
    return;
  }
  const row = (k: string, v: string) => `<tr><th>${k}</th><td id="f-${k.toLowerCase()}">${esc(v)}</td></tr>`;
  res.send(page(`Complaint ${c.ref}`, `<table id="record">${row("Ref", c.ref)}${row("Policy", c.policy)}${row("Category", c.category)}${row("Received", c.received)}${row("Status", c.status)}${row("Summary", c.summary)}${row("Updated", c.updated)}</table>`));
});

app.listen(PORT, () => process.stdout.write(`[legacy] ClaimsCentre on http://localhost:${PORT}\n`));
