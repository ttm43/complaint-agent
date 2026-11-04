import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";

// Pulls jobs from the backend, drives the legacy web app with the keyboard only
// (Tab, typing, Enter), reads back every write, and reports the result.

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:4100";
const LEGACY = process.env.LEGACY_URL ?? "http://localhost:4200";
const VISIBLE = process.env.RPA_VISIBLE === "1";
const STEP_DELAY = VISIBLE ? 60 : 0;

const JobSchema = z.object({
  id: z.string(),
  kind: z.enum(["read_claim_notes", "write_claim_note", "write_complaint"]),
  payload: z.record(z.string(), z.unknown()),
  attempt: z.number(),
});
type Job = z.infer<typeof JobSchema>;

interface JobResult { readonly ok: boolean; readonly result: Record<string, unknown> }

const log = (msg: string) => process.stdout.write(`[rpa] ${msg}\n`);
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`job payload is missing ${name}`);
  return v;
};

async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  await page.keyboard.type(text, { delay: VISIBLE ? 15 : 0 });
}

/** Press Enter and wait until the page it leads to (after any redirect) has loaded. */
async function enterAndWaitFor(page: Page, pathPart: string): Promise<void> {
  // framenavigated fires when the new document commits, so the old page can no longer be read by mistake.
  const committed = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() && f.url().includes(pathPart) });
  await page.keyboard.press("Enter");
  await committed;
  await page.waitForLoadState("load");
}

async function openClaim(page: Page, claimId: string): Promise<void> {
  await page.goto(`${LEGACY}/claims`);
  await typeInto(page, "#claimId", claimId);
  await enterAndWaitFor(page, "/claims/view");
  if (await page.locator("#error").count()) throw new Error((await page.locator("#error").innerText()).replace(/\s+/g, " "));
  if (await page.locator("#notfound").count()) throw new Error(`claim ${claimId} not found in the legacy system`);
}

const readNotes = (page: Page) => page.locator("#notes td.note").allInnerTexts();

async function readClaimNotes(page: Page, job: Job): Promise<JobResult> {
  await openClaim(page, str(job.payload["claimId"], "claimId"));
  return { ok: true, result: { notes: await readNotes(page) } };
}

async function writeClaimNote(page: Page, job: Job): Promise<JobResult> {
  const claimId = str(job.payload["claimId"], "claimId");
  const text = str(job.payload["text"], "text");
  await openClaim(page, claimId);
  if ((await readNotes(page)).includes(text)) return { ok: true, result: { verified: true, alreadyPresent: true } };
  await typeInto(page, "#note", text);
  await page.keyboard.press("Tab"); // to the Save button
  await enterAndWaitFor(page, "/claims/view");
  const verified = (await readNotes(page)).includes(text);
  return verified ? { ok: true, result: { verified } } : { ok: false, result: { error: "note not found on read-back", verified } };
}

async function writeComplaint(page: Page, job: Job): Promise<JobResult> {
  const p = job.payload;
  const fields = [str(p["ref"], "ref"), str(p["policyNumber"], "policyNumber"), str(p["category"], "category"), str(p["receivedAt"], "receivedAt"), str(p["status"], "status"), String(p["summary"] ?? "")];
  await page.goto(`${LEGACY}/complaints`);
  await page.focus("#ref");
  for (const [i, value] of fields.entries()) {
    await page.keyboard.type(value, { delay: VISIBLE ? 10 : 0 });
    if (i < fields.length - 1) await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Tab"); // to Save
  await enterAndWaitFor(page, "/complaints/view");
  const savedStatus = (await page.locator("#f-status").innerText()).trim();
  const savedRef = (await page.locator("#f-ref").innerText()).trim();
  const verified = savedRef === fields[0] && savedStatus === fields[4];
  return verified ? { ok: true, result: { verified } } : { ok: false, result: { error: "record differs on read-back", verified } };
}

const HANDLERS: Record<Job["kind"], (page: Page, job: Job) => Promise<JobResult>> = {
  read_claim_notes: readClaimNotes,
  write_claim_note: writeClaimNote,
  write_complaint: writeComplaint,
};

async function report(jobId: string, r: JobResult): Promise<void> {
  const res = await fetch(`${BACKEND}/rpa/jobs/${jobId}/callback`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r),
  });
  if (!res.ok) log(`backend rejected result for ${jobId}: ${res.status}`);
}

async function nextJob(): Promise<Job | null> {
  const res = await fetch(`${BACKEND}/rpa/jobs/next`);
  if (!res.ok) throw new Error(`backend ${res.status}`);
  const env = (await res.json()) as { data: unknown };
  return env.data ? JobSchema.parse(env.data) : null;
}

// Uses the installed Chrome (or set RPA_BROWSER_CHANNEL=msedge); no separate browser download needed.
const CHANNEL = process.env.RPA_BROWSER_CHANNEL ?? "chrome";
let browser: Browser | null = null;
let current: Page | null = null;

/** The robot's page. Opened on the first job, and reopened if someone closed the window. */
async function robotPage(): Promise<Page> {
  if (current && !current.isClosed() && browser?.isConnected()) return current;
  if (!browser?.isConnected()) {
    browser = await chromium.launch({ channel: CHANNEL, headless: !VISIBLE, slowMo: STEP_DELAY });
    log("browser opened");
  }
  current = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  return current;
}

async function main(): Promise<void> {
  log(`ready (${VISIBLE ? "visible" : "headless"}), backend ${BACKEND}, legacy ${LEGACY}`);
  for (;;) {
    let job: Job | null = null;
    try {
      job = await nextJob();
    } catch {
      await new Promise((r) => setTimeout(r, 1000)); // backend not up yet
      continue;
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    log(`${job.id} ${job.kind} (attempt ${job.attempt})`);
    try {
      await report(job.id, await HANDLERS[job.kind](await robotPage(), job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${job.id} failed: ${message}`);
      await report(job.id, { ok: false, result: { error: message } });
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[rpa] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
