# Motor Insurance Complaint-Handling Agent · Demo

A complaint comes in by phone. The agent verifies the caller, classifies the complaint, looks up the claim and the relevant policy clauses, and proposes an outcome. Anything involving money or changing a claim decision needs a person's approval; everything else follows a whitelist, and closures are reviewed by a person.

- Design: [docs/plan.md](docs/plan.md)
- Implementation spec: [docs/spec.md](docs/spec.md)
- One-page visual overview: open [docs/showcase.html](docs/showcase.html) in a browser

## Start everything with one command

Requirements: Node 22, Docker Desktop (for n8n), and Chrome installed locally (used by the RPA robot).

```bash
npm install
```

```bash
npm start -- --reset
```

| Address | What it is |
|---|---|
| http://localhost:4100/ui/ | Demo web page |
| http://localhost:4200/ | Legacy system "ClaimsCentre" (what the RPA robot operates) |
| http://localhost:5678/ | n8n canvas; create a local account the first time you open it (the author's local account is kept in `n8n/owner.local.json`, which is not committed) |

Common options:

- `--reset`: clear the complaints database and the legacy system data; use before a demo.
- `--visible`: the RPA robot drives a visible browser window, for showing scenario 5.
- `--no-n8n`: don't start n8n; the same steps run inside the backend process instead (fallback).

Stop: `npm run stop` (the n8n container keeps running); to stop n8n as well: `node scripts/n8n.mjs down`.

Both apps have a **Clear demo data** button, so a demo can be run again without restarting:

- Demo page, Human queue tab: removes demo complaints, tasks, timeline entries and robot jobs, and resets review counts. Refused while a call or robot job is still running.
- Legacy system, main menu and complaints register: removes robot notes and registered complaints, and keeps the original claim notes.

Customer data (policies, claims, documents in `data/`) is read-only and never touched by either button.

## Running the demo

The 9 scenarios are described in [plan.md section 8](docs/plan.md#8-demo). On the web page:

1. Pick a scenario on the left (★ marks the featured ones); the call plays automatically. Red text in a customer bubble is what ASR actually heard.
2. The Timeline on the right shows every step behind the scenes; retrieval results and classification probabilities can be expanded.
3. In the Human queue, approve requests and review closures; the closure review shows the customer's own words next to the cited clauses.
4. After a complaint is closed, click "Not solved" on its card to simulate the customer replying that it isn't fixed (scenario 8), and pick the correct category.
5. Review stats shows each category's upper error bound and review mode; "Preset 300 clean" shows reaching the spot-check threshold.
6. "Run the other 4" runs the remaining 4 scenarios in one go and shows only the results.

Tick "Skip audio" to run without sound and follow the timeline only.

## What is real and what is mocked

Really implemented: the TypeScript backend (state machine, whitelist, citation checks, review statistics, SLA), the n8n workflows, the legacy system web app, Playwright RPA, and the demo web page.

Mocked: policy and claims APIs, document retrieval, classification and risk detection, the conversational LLM, ASR and TTS. Mocks share the interfaces of the real services, so going live only changes the adapters. The production choice for each, and why, is in the [table in plan.md section 8](docs/plan.md#how-the-demo-is-built).

## Layout

| Path | Contents |
|---|---|
| `src/domain/` | Pure rules: state machine, whitelist, citation checks, SLA, identity parsing, review statistics |
| `src/steps/` | Business steps (identity, investigation, decision, registration, closure), shared by n8n and in-process orchestration |
| `src/engine/` | Call engine, orchestrator interface (n8n / in-process), RPA job broker |
| `src/mock/` | Mocked retrieval, models and data loading |
| `src/http/` | Public API, and the internal endpoints called by n8n and RPA |
| `n8n/build.mjs` | Generates `n8n/workflows/*.json`; change workflows here |
| `legacy/` | Legacy system web app |
| `rpa/worker.ts` | Playwright robot: keyboard only, reads back every write |
| `public/ui/` | Demo web page |
| `data/`, `scenarios/` | Mock data, the 9 scenario scripts, fixed phrases |
| `models/voices/` | Voice settings per role (all derived from one recording of the author by pitch shifting; the recording and voice prompts are not committed) |

## n8n workflows

| Workflow | Purpose |
|---|---|
| complaint-main | Triggered when a call starts and ends |
| sub-identity | Identity check; **does not save execution data**, so dates of birth never stay in n8n |
| sub-investigation | Claims API → retrieval → RPA reads the claim notes; a Wait node waits for the robot's callback; on failure retries after 2 seconds, up to 3 times |
| sub-resolution | The model proposes an outcome; the backend whitelist decides whether to execute, ask for approval or hand to a person |
| sub-human-review | Stops at a Wait node until a person approves, then continues; hands to a person if nobody acts within 5 days |
| sla-check | Checks the 30-day deadline every hour |

After changing `n8n/build.mjs`:

```bash
node n8n/build.mjs && node scripts/n8n.mjs import
```

## Audio

Every line is pre-rendered to `public/audio/{id}.wav` and only played at runtime. The id is derived from the voice and the text, so changing one line only re-renders that line.

**The repo contains no audio.** All voices come from one recording of the author, so `public/audio/`, the original recording `models/voices/refs/` and the voice prompts `models/voices/prompts/` are not committed. A fresh clone still runs: when a clip is missing, the page pauses for about as long as the line would take and carries on, and the dialogue and timeline display as usual. To add voices, render them from your own recording (`refs/source.wav` plus its transcript `refs/source.txt`) with the steps below.

```bash
npx tsx scripts/audio-manifest.ts > var/audio-manifest.json
```

```bash
../live-interpreter/voiceclone/.venv-rt/Scripts/python.exe scripts/voices/render.py
```

```bash
../live-interpreter/.venv/Scripts/python.exe scripts/voices/qa.py
```

`qa.py` transcribes every clip back with Parakeet, compares it with the script and lists the clips that are wrong; delete those wav files and render again. Models are looked up in the shared model store by the keys in `config/models.yaml`.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```
