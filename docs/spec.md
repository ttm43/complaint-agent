# Demo Implementation Spec

Read together with [plan.md](plan.md): the design and its reasoning are in plan.md; this file only covers how it is built. It runs on one machine, and the demo shows the n8n canvas and the demo web page side by side. All code, node names and dialogue are in English.

## What is implemented and what is mocked

**Implemented**: TypeScript backend, n8n workflows, legacy system web app, RPA, demo web page.

**Mocked**: policy and claims APIs, retrieval, classifier, risk detection, conversational LLM, ASR, TTS. Every mock sits behind an adapter with the same interface as the real service:

- **Retrieval**: takes a query, category, PDS edition and mode (naive / mix); returns passages (chunkId, docId, docVersion, clause, text, score) and, in mix mode, entity relations, shaped like LightRAG's context output. Simulated latency is configurable (about 50 ms for naive, about 2.5 s for mix), as is fault injection (timeout, no results).
- **Classifier**: text in, category and per-category probabilities out. Implemented with keyword rules; scenario 8 must misclassify every time.
- **Risk detection**: once per sentence, returns a risk type and confidence.
- **Conversational LLM**: returns scripted tool calls and answers per scenario, with the cited chunkIds in the answer. The backend validates them as usual; nothing is skipped because it is a mock.
- **ASR**: returns the script line as text with a confidence; scenarios can inject a misheard text and low confidence.
- **TTS**: nothing is synthesised at runtime; pre-rendered audio is played.

## Components

| Component | Implementation | Notes |
|---|---|---|
| backend | TypeScript + Express + SQLite | State machine, whitelist, citation checks, thresholds, SLA, audit, idempotency, review counts, hold-line triggers |
| mock-services | Routes and modules in the same service | Policy API, claims API, retrieval, classification, risk, conversational LLM, ASR |
| mock-data | JSON | Policies (with start date and applicable PDS edition), claims (notes reference clause numbers), document store |
| legacy-web | Static HTML forms | A fake old claims system and complaints system, with no API |
| rpa-worker | Playwright | Keyboard only (Tab, Enter and so on); reads back after every read and write; injectable failures; visible mode |
| audio | Offline render scripts + audio files | Qwen3-TTS 1.7B renders the customer lines, the phrase library and every value of the template sentences |
| phrase-library | JSON | Phrase ID → text → audio file |
| demo-ui | Single web page | See below |
| scenarios | JSON | 9 scenarios: the customer's lines and audio for each turn, preset outputs for the mock services, expected results |

## Voices

Only the author's own recordings are used (`live-interpreter/voiceclone` already has reference recordings and a Qwen3-TTS environment):

- Male roles (the agent, Tom, James): cloned directly from the author. The three roles need to sound different, using different reference clips or speaking rates.
- Female roles (Priya and others): the author's recording, pitch-shifted, as the reference. Pitch and formants are shifted together; shifting pitch alone sounds like a chipmunk.

## Phrase library and hold lines

| ID | Use |
|---|---|
| `GREETING` | Opening |
| `ASK_POLICY`, `ASK_DOB`, `CONFIRM_POLICY_{id}` | Identity prompts and read-back |
| `ASK_KEYPAD` | Switch to keypad entry |
| `ASK_COMPLAINT`, `ASK_CLARIFY` | Ask for the complaint, follow-up question |
| `HOLD_1`, `HOLD_2` | Hold lines |
| `NOT_CAUGHT` | Didn't catch that |
| `HANDOFF_LIVE`, `HANDOFF_CALLBACK` | Hand to a person (business hours / callback) |
| `AFCA_NOTICE` | AFCA notice |
| `CLOSING` | Closing |

Every value of a template sentence (such as "Your claim {claimId} has been waiting {days} days.") is rendered separately.

Hold-line rules (triggered by the backend): play `HOLD_1` as soon as an API call, retrieval or RPA job starts; play `HOLD_2` if there is no result after 4 seconds, then one line every 8 seconds; after 30 seconds or a failure, play a handoff phrase.

## Mock data

| Policy / claim | Used in | Key points |
|---|---|---|
| POL-1001 / CLM-8821 | 7 James | 2024 PDS applies; claim declined, notes show resubmitted documents were never reviewed |
| POL-1002 / CLM-9002 | 1 Priya, 2, 6 | 2026 edition; assessment delayed 21 days |
| POL-1003 / CLM-9150 | 3, 4 Tom | 2026 edition |
| POL-1004 / CLM-9300 | 8 | Repair claim, repair completed |
| POL-1005 / CLM-9400 | 9 | Retrieval failure injected |
| CLM-FAIL | 5 | RPA fails reading notes |

| Document | Content | Used in |
|---|---|---|
| PDS 2024 edition | Decline clause, resubmission clause (review within 10 business days of resubmission), valuation clause, repair warranty clause | 7 |
| PDS 2026 edition | Same as above, but resubmission review becomes 15 business days, and a lifetime repair warranty is added | 1, 6, 8, 9 |
| Internal claims procedure | Assessor dispatch, chasing, review of resubmitted documents, escalation path | 1, 7, 8 |
| Code of Practice extract | Deadlines for claim decisions, assessments and complaint responses | 1, 7 |
| AFCA notice | Required content and wording | 7 |

Scenario 2 script: the customer says POL-1002, ASR returns POL-1007 → the agent reads it back → the customer says no → said again, misheard again → `ASK_KEYPAD` → 1002 is entered on the keypad on the web page → the date of birth does not match → still registered, `HANDOFF_CALLBACK`.

## Demo web page

- **Left**: the call, playing audio turn by turn, with mute, skip and 1.1× speed; scenario 2 shows a keypad when needed.
- **Right**: the complaint timeline (read from the audit log; expanding an entry shows the cited clause text and document edition), the human queue, and the review panel (cases and the two error counts per category, review mode, sampling rate, with counts that can be preset by hand).
- **Buttons**: pick and run a scenario, run all scenarios, approve, "simulate the customer replying not solved".

## n8n workflows

1. `complaint-main`: receives call events → calls the sub-workflows → notifies.
2. `sub-identity`: identity check.
3. `sub-investigation`: calls the claims API and backend retrieval, submits the RPA read job, and waits for the callback or a timeout.
4. `sub-resolution`: calls the backend to decide (including citation checks), and executes whitelisted actions.
5. `sub-human-review`: pauses at a Wait node; approval on the web page resumes it through the resume webhook.
6. `sla-check`: runs on a schedule and flags complaints near their deadline.

## Backend endpoints (names may change)

- `POST /complaints`: create a complaint, with callId as the idempotency key
- `POST /complaints/:id/turns`: submit one customer turn; returns the classification, risk signals, next step and the phrase ID to play
- `POST /complaints/:id/retrieval`: retrieve within the policy's PDS edition and write the result to the audit log
- `POST /complaints/:id/actions`: the agent requests an action; the backend checks the whitelist and citations
- `POST /rpa/jobs`, `POST /rpa/jobs/:id/callback`: RPA jobs and callbacks
- `POST /reviews/:id/decision`: human approval
- `POST /complaints/:id/reopen`: the customer reports it is not solved; recorded as a silent error
- `GET /complaints/:id/events`: audit timeline

## State machine

RECEIVED → IDENTIFIED / UNVERIFIED → CLASSIFIED → INVESTIGATING → PENDING_APPROVAL / RESOLVING → PENDING_REVIEW → CLOSED → REOPENED; any state can move to HUMAN_HANDLING. Retrieval happens within INVESTIGATING.

## Acceptance criteria

- Each of the 9 scenarios reaches its expected result, with identical results on every run; "run all" finishes the 4 non-featured scenarios within 1 minute
- Submitting the same callId twice creates only one complaint
- Scenario 2: after two mishearings it switches to keypad entry; a failed verification is still registered, and the timeline contains no policy data
- Scenario 5: n8n shows 3 attempts, then a handoff to a person
- Scenario 7: cites the 2024 clauses; the workflow stops at the Wait node and continues after approval on the web page
- Scenario 8: after reopening, the received time is unchanged and the misclassification count goes up by one
- Scenario 9: two hold lines, still no basis after fallback, handed to a person
- The hold line starts playing within 300 ms of a lookup starting
- When the agent cites a passage that is not in the retrieval results, the backend rejects the action
- In Playwright's visible mode you can watch it fill in forms live
- The whole system starts with one command, and the README explains the demo steps
