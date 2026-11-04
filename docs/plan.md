# Motor Insurance Complaint-Handling Agent: Design and Demo

2 November 2026 · @Ximing Tao

> Implementation details are in [spec.md](spec.md).

## 1. Goal

Free the complaints team from logging, looking things up and copying data between systems, so people spend their time on complaints that need judgement, while making sure every complaint is registered and none goes over its deadline.

The demo has to prove three things:

1. A complaint can go from the incoming call to closure or a human handoff, with a full record of every step.
2. Every step that can fail has a defined fallback, so no complaint is lost.
3. Silent errors are detected, corrected, and fed back into the models and the review process.

Tech stack as required by the brief: n8n for orchestration, TypeScript for business logic and the backend, RPA to operate the client's existing systems, and voice models to handle calls.

## 2. Design assumptions

The brief only gives the tech stack and the domain ("insurance complaints"). Everything else is an assumption and can change.

| Assumption | Detail |
|---|---|
| Client | Australian general insurer, bound by ASIC RG 271 and the General Insurance Code of Practice; complaints answered within 30 days |
| Scope | Private comprehensive motor insurance; a dedicated complaints line, so every call is treated as a complaint; English only |
| Existing systems | Read-only APIs for policies and claims; claim writes and the complaints system have no API and go through RPA. The complaints system is the single register of record for regulatory purposes |
| Documents | The PDS has several editions; a customer is covered by the edition in force when their policy started |
| Historical data | A large archive of call recordings that can be aligned with the complaints register for labelling |
| Data policy | On-premises, hybrid or cloud is the client's call; cloud uses Australian regions only |
| Identity check | Policy number plus date of birth; if the check fails the complaint is still registered, but no information is disclosed |

The received time always starts at the call, however many times the complaint is transferred afterwards.

## 3. Categories and the whitelist

The demo covers 4 categories; production would grow to 8. The number of category pairs grows as n(n−1)/2 (6 pairs for 4 categories, 28 for 8), and misclassification mostly happens between similar categories, so categories are opened and validated one at a time.

| Category | Can the agent handle it on its own? |
|---|---|
| Claim delay | Yes: chase the claim, give a progress update |
| Claim declined | No, it changes a claim decision; goes to a person for approval |
| Payout amount | No, it involves money; goes to a person for approval |
| Repair quality | Depends on the action; easily confused with claim delay |

**Whitelist**: explain the reason for a decline or delay (always quoting verified source text), resend documents, chase an assessment or repair, update contact details.

**Always handed to a person**: anything involving money (the agent can only suggest an amount with its basis), changing a claim decision, no supporting rule found, the customer rejects the proposed outcome (AFCA is mentioned at the same time), risk signals, the customer asks for a person.

Two reasons:
- **Money stays off the whitelist**: a caller can talk the agent into things, which is prompt injection by voice. Payments should also be approved separately from intake.
- **Explanations must carry citations**: "explain the reason" is the action most likely to be made up, so every basis has to trace back to a specific clause in a specific document edition.

## 4. Architecture and responsibilities

The backend is the single source of truth for complaint state. n8n only decides "what happens next". Rules live in TypeScript because they can be unit tested; drawn on the n8n canvas they look nice, but a change cannot be tested.

| Component | Responsible for | Not responsible for |
|---|---|---|
| Voice layer | ASR, playing phrases, TTS | Any business decision |
| Conversational agent (LLM) | Talking to the customer, gathering facts, requesting actions through tool calls | Deciding whether it may act; deciding when to play hold lines |
| Classifier, risk detection | Classifying from the first few sentences; checking every sentence for risk in parallel | Generating replies |
| Retrieval service | Searching within the right PDS edition and returning source text with its origin | Generating answers |
| TypeScript backend | State machine, whitelist, citation checks, confidence thresholds, SLA, audit, idempotency, triggering hold lines | Step order and waiting |
| n8n | Step order, branching, waiting for human approval, notifications, scheduled SLA checks | Holding state, encoding rules |
| RPA (Playwright) | Operating the legacy systems and reading back every write | Any decision |
| People | Approving money and claim decisions, taking transfers, reviewing closures | Repetitive logging and lookups |

RPA is asynchronous: the backend submits a job and returns immediately, and the robot calls n8n back when done. After 3 timed-out attempts a human task is created. The complaints system, retrieval and models are all called through adapters, so replacing a system only means replacing its adapter.

## 5. How a call flows

If any step fails, the complaint is already registered; the worst case is falling back to the manual process.

1. **Log**: a complaint is created as soon as the call comes in, the received time is recorded and the 30-day clock starts. The call ID is the idempotency key.
2. **Verify**: policy number plus date of birth; the agent reads them back for confirmation, then checks them against the API. On failure the complaint is still registered and handed to a person for a callback.
3. **Classify**: ask "In a sentence or two, what would you like to complain about?" and classify from the first one or two turns. If confidence is low, ask once more; if still low, hand to a person.
4. **Detect risk**: every sentence from the first one is checked in parallel; a hit raises the priority and hands to a person.
5. **Investigate**: play a hold line first; call the claims API, read the claim notes through RPA, and retrieve clauses from the right PDS edition.
6. **Decide**: the backend applies the whitelist and the citation checks. Anything off the whitelist goes to human approval, and n8n pauses at a Wait node.
7. **Confirm**: the agent reads the proposed outcome back; it only counts as resolved if the customer agrees. If not, hand to a person and mention AFCA.
8. **Record**: RPA writes to the complaints system and reads it back.
9. **Closure review**: during the full-review phase the agent only proposes closure; a person confirms before the complaint is closed.
10. **Follow up**: the closure notice asks "Has this been resolved?"; if the customer says no, the complaint reopens with the original received time.

## 6. Document retrieval (RAG)

**Retrieved**: PDS clauses (several editions), internal claims procedures, the Code of Practice, AFCA notice requirements. **Not retrieved**: the policy, claim status and claim notes. These are customer data and come straight from the API or RPA.

**Two kinds of retrieval combined**: production uses LightRAG's mix mode, which already merges graph retrieval with plain vector retrieval.

| | Plain retrieval | Graph retrieval |
|---|---|---|
| Good for | "What does the clause say?": finding a specific clause to quote directly | Questions that span documents: decline clause → resubmission procedure → review deadline in the Code |
| Latency | Tens of milliseconds | An extra LLM call per query, a few more seconds |

**Three rules**:
1. **Hard filter on PDS edition**: one workspace per edition; the edition is picked from the policy before searching, never by "most similar".
2. **Return source text, never generate**: retrieval only returns context; the agent phrases the answer and cites the passages it used.
3. **The backend checks citations**: a cited passage must be in this query's results, from the edition matching the policy; otherwise no explanation is given and the call goes to a person.

**Why LightRAG**: mix mode is hybrid out of the box; it works with local Ollama models and with all three clouds; indexing is cheaper than GraphRAG and can be updated incrementally. The cost is that graph mode calls an LLM on every query, so simple questions use plain retrieval, complex ones use the graph, and the wait is covered by hold lines.

## 7. Voice: fixed phrases, hold lines and error handling

### Fixed phrases and hold lines

Most of what a complaints agent says is fixed. The greeting, identity prompts, AFCA notice, handoffs and closing are recorded in advance and played by ID; sentences with numbers and day counts use templates. Compliance wording is exact every time, and there is no wait for synthesis.

**Hold lines are triggered by the backend state machine, not by the LLM**: as soon as a lookup starts the caller hears "Let me check that for you", another line follows after 4 seconds, and after 30 seconds or a failure the call goes to a person. If the LLM decided, it would have to think before speaking, which defeats the purpose of a hold line.

All speech uses the same engine and the same voice, otherwise the caller hears two different people.

### When the voice layer gets it wrong

The test is **whether the error changes a fact**. Misheard filler and ordinary words can be ignored; classification and the LLM tolerate them. Numbers, dates, amounts, yes/no, negations and risk signals must be right.

Local benchmarks used clean audio. Real calls are 8 kHz narrowband with noise and accents, so error rates will be noticeably higher; they need to be measured on historical recordings during the shadow phase.

**How errors are caught.** The most dangerous case is "confidently wrong" (POL-1002 heard as POL-1007 with high confidence). Confidence alone misses it, so key fields rely on read-back and checks against the system.

- **During the call**: low ASR confidence; format checks (digit count, impossible dates); checks against the system (policy number and date of birth do not match); the customer says "no" during read-back; the customer repeats the same sentence or says "that's not what I meant"; speech is detected but no text comes out (Parakeet int8 deterministically returns an empty string for some audio, which actually happened).
- **After the call**: re-transcribe the recording with a slower, more accurate model and compare only numbers, dates, amounts, negations and risk keywords, sending mismatches to review; rerun risk detection on the re-transcript and create a callback task at once for any risk signal missed live; the review screen highlights low-confidence and mismatched spans, with click-to-replay; the customer replies "that's wrong" to the closure notice, or calls back saying "you misheard me"; each month a sample is transcribed by hand and error rates are tracked by accent and phone line to catch drift.
- **The agent mispronounces something**: pre-recorded phrases and template sentences cannot go wrong at runtime. They are checked once when the audio is produced, by transcribing them back with ASR (this is how Kokoro saying "assess" for "assessor" was found). At runtime only live-synthesised speech needs checking: template variables in production (claim numbers and day counts have unbounded values, so they can be stitched from recorded digit clips or synthesised live) and free-form LLM answers. The demo has neither.

| Error | Fallback |
|---|---|
| Number or date misheard | Read back → format check → policy number and date of birth must both match the API (a mishearing can only fail verification, never verify the wrong person) → after two misses switch to keypad entry → then hand to a person |
| Complaint content misheard | Ask the customer to repeat when ASR confidence is low; read the outcome back and act only once the customer agrees |
| Risk signal missed | Set the detection threshold low, preferring false alarms; keep the original audio with the transcript so reviewers can replay it |
| Agent mispronounces | Normalise numbers and amounts to their spoken form before synthesis; send numbers again by SMS or email with the closure notice |
| No response, service failure | If nothing is recognised for a few seconds, ask the customer to repeat; after two tries hand to a person; on a full outage calls go straight to the human queue |
| Poor recognition of domain terms | Custom vocabulary or hot words; evaluate and fine-tune on historical recordings |

Last line of defence: money and claim decisions are not on the whitelist, so a mishearing cannot cause anything irreversible.

## 8. Demo

### How the demo is built

What is really implemented: the TypeScript backend, the n8n workflows, the legacy system web app, RPA and the demo web page. External systems, retrieval and model services are all mocked behind the same interfaces as the real services, so going live only changes the adapters. Mocks give identical results on every run and reproduce silent errors reliably; the cost is that you cannot see how a real model reacts, so feasibility is shown with benchmarks measured on my own machine.

| Service | In the demo | Production choice | Why |
|---|---|---|---|
| Policy and claims APIs | Read-only mock routes | The client's existing APIs | Assumed to exist |
| Retrieval | Keyword matching over a mock document store, filtered by edition, with simulated latency and failures | LightRAG mix mode | See section 6 |
| Classification, risk detection | Keyword rules returning a category and probabilities | Fine-tuned BERT with probability calibration | Historical data exists; runs on CPU |
| Conversational LLM | Scripted tool calls and answers per scenario | An LLM with tool calling | The whitelist is enforced through tool calls |
| ASR | Script lines, with injectable mishearings | Parakeet (local) or any of the three clouds' ASR | Measured: results within 0.4 s, numbers correct |
| TTS | Pre-rendered with Qwen3-TTS and only played at runtime; voices come from my own recording (female voices are pitch-shifted from it) | Streaming TTS | Measured: first audio in 0.27 s, accurate pronunciation |

### Scenarios

★ marks the featured scenarios; the other 4 can be run in one click, showing only the results.

| # | Scenario | What it tests | Expected result |
|---|---|---|---|
| ★1 | Priya, assessment delayed 21 days | Nothing (happy path) | Hold line → finds the Code deadline → cites it and chases → customer accepts → closure proposed |
| ★2 | ASR mishears the policy number, and the date of birth is also wrong | Voice, identity | Customer rejects the read-back → keypad entry → date of birth does not match → still registered, nothing disclosed, callback by a person |
| 3 | Customer is vague | Classification confidence | Still low after one follow-up question, handed to a person |
| 4 | Tom: "Without a car I can't get to work" | Risk signal | Priority raised, straight to a person |
| ★5 | RPA fails reading the claim notes | Legacy system operation | Human task created after 3 attempts |
| 6 | Unhappy with the payout amount | Money | Retrieves the valuation clause as the basis, goes to human approval |
| ★7 | James, claim declined, resubmitted documents never reviewed | Changing a claim decision, edition filter | Graph retrieval links three documents and cites the 2024 PDS → paused at the Wait node → continues after approval on the web page |
| ★8 | Closed under the wrong category | Silent error | See below |
| 9 | No supporting rule found | Document retrieval | Two hold lines → fallback still finds nothing → no explanation given, handed to a person |

**Scenario 8**: the customer says "the car came back from the repairer and it's still not right" (repair quality), but the classifier says claim delay with high enough confidence. The agent retrieves and chases under the wrong category, the customer reluctantly agrees, the reviewer misses it, and the complaint is closed. The customer replies "this hasn't been fixed at all": the complaint reopens with the original received time, the category's misclassification count goes up by one, and the corrected category goes into the training data. If the error rate crosses the threshold, that category goes back to full review. The review screen shows the customer's own words next to the cited clauses, which is where misclassification is easiest to spot.

## 9. Human review

1. **Review the closure, not the call.** What is said on a call cannot be reviewed in advance; the closure is what can be held back. During the full-review phase the agent only proposes closures.
2. **Use a statistical upper bound to decide when to relax.** After n consecutive error-free cases, the 95% upper bound on the error rate is about 3/n (the rule of three); proving it is below 1% takes about 300 consecutive clean cases. When there are errors, use the Wilson interval.
3. **Open each category separately**, each with its own count and its own target. Silent errors are counted as "misclassified" and "wrong citation": the first means fixing the classifier, the second means fixing document chunking or retrieval.
4. **Risk-based spot checks**: random sampling, plus extra sampling of low-confidence cases, long calls and customers who call back after closure. The sampling rate has a floor and never drops to zero.
5. **Back to full review** when the model, prompt or document edition changes, or when the error rate or reopen rate rises.

## 10. Reliability

In one sentence: whatever fails, no complaint is lost; the worst case is falling back to today's manual process.

| Mechanism | How | In the demo |
|---|---|---|
| Idempotency | The same call ID never registers twice; RPA jobs carry idempotency keys | Implemented |
| Retries and timeouts | RPA retries up to 3 times, then creates a human task | ★5 |
| Verify after write | RPA reads back every write | Implemented |
| Retrieval fallback and citation checks | Graph timeouts fall back to plain retrieval; citations not in the results are rejected | 9, implemented |
| SLA clock | 30-day deadline; near the deadline the owner is reminded first, then the supervisor | Implemented |
| Audit log | Every step records who, when, what and why (including the cited passage and document edition) | Web page timeline |
| State machine | Only valid state transitions are allowed | Implemented |
| Daily reconciliation, access control, encryption | Reconcile with the complaints system; role-based access, encryption, recording retention periods | Discussed only |

## 11. Models and deployment

**A cascade (ASR → text LLM → TTS), not an end-to-end speech model**: audit needs a transcript; classification, retrieval and the whitelist all work on text and are easier to control; each stage can be replaced and evaluated on its own; and none of the three clouds currently offers its end-to-end speech models in an Australian region. The cost is a few extra hops of latency and the loss of tone of voice, recovered with fixed phrases, hold lines and full streaming. The target is a response within 1 second of the customer finishing.

**Measured on my machine (RTX 5070 Ti)**:

| Model | Result |
|---|---|
| Qwen3-TTS 1.7B (GPU) | First audio in 0.27 s, RTF 0.35, accurate pronunciation |
| Kokoro v1.1 (CPU) | First audio in 0.3–0.5 s, but drops word-final -er/-or, and has only 3 English female voices |
| Parakeet 0.6B (CPU) | Result 0.15–0.4 s after the speaker stops, numbers correct |

Conclusion: synthesising sentence by sentence adds only about 0.3 s per turn; the real time goes on the LLM and retrieval.

**Deployment options**:

| Component | On-premises | AWS | Azure | GCP |
|---|---|---|---|---|
| ASR | Parakeet | Transcribe | AI Speech | Speech-to-Text |
| Conversational LLM | Open-weight model (needs GPU) | Bedrock | Azure OpenAI / AI Foundry | Vertex AI |
| Classification, risk | BERT (CPU) | SageMaker | Azure ML | Vertex AI custom training |
| Retrieval | LightRAG + local embeddings | LightRAG + Bedrock models | LightRAG + Azure OpenAI models | LightRAG + Vertex models |
| TTS | Qwen3-TTS | Polly | AI Speech | Text-to-Speech |

In the cloud, everything runs in Australian regions (AWS Sydney/Melbourne, Azure Australia East, GCP Sydney), and each model's region is verified in the client's own account. Bedrock uses au. cross-region inference; Azure avoids Global deployments and Voice Live; BERT cannot go on Bedrock (Custom Model Import does not support encoder models).

**Who decides**: I lay out the technical facts and trade-offs, and the client decides what risk is acceptable; a vendor claiming compliance does not make the user automatically compliant. A hybrid also works: transcription, classification and retrieval on-premises, the conversational LLM on an Australian cloud region. Every model sits behind an interface, so switching options is a configuration change.

## 12. Business value and rollout

**Value**: saves intake and admin effort; lowers the regulatory risk of missed registrations and overdue complaints; someone always answers, simple issues are resolved on the call, and every explanation can be traced.

**Report the formula, not a number**: effort saved = monthly complaint volume × intake and admin time per complaint × share the agent can take over. The share is estimated by replaying historical complaints to see how many fall within the whitelist. Costs include compute or cloud services, the RPA environment, labelling and maintenance, and maintaining the document store, and are given at the end of Discovery.

**Rollout** (you can stop after any step):

1. **Discovery, 2–4 weeks**: measure current handling times, map the systems, collect historical recordings and every PDS edition.
2. **Shadow mode, 4–6 weeks**: the AI listens to real calls and only transcribes, classifies and retrieves, never talking to customers; this data measures recognition error rates on real phone audio.
3. **Intake only**: take a small share of calls and only register them; everything goes to people for handling.
4. **Open one category at a time**: enable whitelisted actions category by category under full review, then move to spot checks once the target is met.
