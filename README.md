# AIMC Email Study — project status, tests and to-do

One web app (Node 18+, **no runtime dependencies**) for the two-email AI-mediated-communication study:
scenario card → write in an **Email** tab with an **AI Chat** tab → **Send** → log view for the recall interview → second email → comparison view.
Every edit is logged with its source, so the interviews can go through *how* the email was written.

_Last updated 2026-11-04. Chat and autocomplete currently run on **mock models** (no API key has been used yet)._

---

## 1. Quick start

```bash
cd "/Users/veda/Documents/PhD Research Projects/AIMC"
node server.js                       # participants:  http://localhost:3000   (enter a PID from config/participants.csv, e.g. P01)
                                     # researchers:   http://localhost:3000/researcher.html
node scripts/simulate.js DEMO        # (re)creates a fake finished session "DEMO" so you can open the log view without typing one
npm test                             # fast tests (no browser)
npm i && npm run test:browser        # real-Chrome end-to-end test (needs Google Chrome; CHROME=/path/to/chrome if elsewhere)
```

* Real LLM: `ANTHROPIC_API_KEY=sk-ant-... node server.js` (otherwise mock replies; the terminal says which mode it is in).
* Different port: `PORT=4000 node server.js`. Different data folder: `DATA_DIR=/path node server.js`.
* Researcher access: loopback only, unless `RESEARCHER_KEY=...` is set (then enter the key on the page).
* Start over for one participant: delete `data/<PID>/` (or use the researcher page's delete button).

---

## 2. Where things are

| Path | What |
|---|---|
| `config/participants.csv` | Dummy sheet: `pid, scenario_1, scenario_2` (`boss` / `colleague`). Re-read on every request. Rows P01–P06 alternate order; `DEMO`, `DEMO2` are demo rows. |
| `config/scenarios.json` | Scenario cards, fake To addresses, subjects — **all placeholder text** |
| `config/config.json` | Pause threshold (2000 ms), snapshot/flush timing, AI-inspired match length (4 words), large-change size, autocomplete timing, autocorrect list, **LLM model names + system prompts** |
| `server.js` | HTTP server, storage, chat + autocomplete (mock or Anthropic), researcher endpoints, CSV export |
| `public/core.js` | Edit/label logic shared by browser and server (character-level source labels, replay) |
| `public/analysis.js` | Derives revisions, pauses, AI-edited spans, AI-inspired flags, filters, CSV rows from raw events |
| `public/app.js` | Participant app (editor, autocomplete, autocorrect, chat, paste/drop blocking, send) |
| `public/logview.js`, `logview.css` | Log view + filter bar (used after Send, in comparison, and on the researcher page) |
| `public/researcher.html`, `researcher.js` | Researcher page |
| `scripts/simulate.js` | Generates a realistic fake session through the real API (`DEMO`) |
| `test/` | Test suites (see §5) |
| `prototype-v1/` | The first, looser prototype. Not used by the main app; extended separately in Nov 2026 (see §9) |
| `data/<PID>/session.json` | **Master record** per participant (see §4) |
| `data/<PID>/email<N>.events.jsonl` | Raw events, appended continuously |

---

## 3. What has been built (by your build order)

| Step | Scope | Status |
|---|---|---|
| 1 | Session start by PID, scenario card, plain email tab, Send saves under the PID | ✅ done |
| 2 | Event logging + typed labels; block outside paste and drag-and-drop; log spellcheck fixes | ✅ done (spellcheck code path **not human-verified**, see §6) |
| 3 | Proto-GPT chat tab (word-by-word replies, fresh chat per email, copy button, no retry), AI-text paste labelled `ai` | ✅ done on a **mock model**; Anthropic streaming path written, never run |
| 4 | Autocomplete (ghost text, Tab/Esc) + autocorrect (typo list, one-key undo) | ✅ done on a mock suggestion model |
| 5 | Log view: scenario, colour-coded final email, revision list, details, filters, chat entries, unused-reply flag | ✅ done |
| 6 | Full two-email flow + side-by-side comparison with shared filters | ✅ done |
| 7 | Researcher page (reopen sessions), CSV exports, possibly-AI-inspired flag, delete-by-PID | ✅ done |

### Design decisions made along the way
* **No admin screen** (your call): the participant app starts from a PID typed (or `?pid=`) in; the order comes from `participants.csv` (so counterbalancing is whatever you put in the sheet).
* **Storage = JSON files** on the server (`data/`), fits a university-hosted deployment. Nothing is kept in the browser.
* **Labels per character:** `typed | autocomplete | spellcheck | autocorrect | ai | unknown`. Copy/paste *within* the app keeps the copied text's labels. Pasted AI text keeps `ai`; characters the participant adds inside it are `typed` and the span is marked "AI-edited".
* **Replacements are recorded as whole words** (e.g. `teh`→`the` is one autocorrect word, a spellcheck pick labels the whole word) — found and fixed via the real-browser test.
* **Revision = a burst of the same kind of edit** with <2 s between edits and adjacent positions; any pause ≥2 s, change of source, or change of field starts a new one. Autocomplete accepts, spellcheck picks, autocorrects, and pastes are always their own revisions.
* **Edits CSV is per revision** (the analytic unit), the events CSV is per raw event.
* **Pasting is allowed only for text that came from inside the app** (a logged copy, or text that appears in an AI reply / the participant's own chat prompt). Everything else is blocked + logged. Pasting into the chat is subject to the same rule.
* **Scenario card text can't be selected** (so it can't be copied into the email).
* **Browser autocorrect is switched off** (`autocorrect="off"`) so only the app's autocorrect fires; browser **spellcheck stays on**.
* **Keystroke events** store key + cursor position + the resulting edit delta (not the full text before/after each key). Full text at any moment is reconstructable from edits, plus snapshots every 3 s while changing, on tab switch and on Send.
* **Server-checked integrity on Send:** the server replays the events and records whether the replay equals the submitted final text/labels (`integrity` in `session.json`).

---

## 4. What gets saved and how to inspect it

`data/<PID>/session.json` → `emails[]` each with: `condition`, `scenario` (as shown), `to`, `final_subject`, `final_text`, `char_labels` (`[{start,end,source}]`), `events` (full raw log), `chat` (transcript), `ai_replies` (`used`, `copied`), `integrity`, `sent_at`.

Raw event types: `writing_start`, `clock_sync`, `keystroke`, `edit`, `delete`, `paste` (own / AI / **blocked external**), `drop_blocked`, `copy`, `autocomplete_shown/accepted/dismissed`, `autocorrect_applied/kept/undone`, `spellcheck`, `ai_prompt`, `ai_reply`, `ai_error`, `tab_switch`, `snapshot`, `window_visibility/blur/focus`, `session_resumed`, `send`, `send_failed`, `desync` (should never appear).

Researcher page (`/researcher.html`): session list → per-email log view, side-by-side comparison, and downloads: **Session JSON**, **Events CSV**, **Edits CSV**, **AI chats (text)**, **Final emails (text)**, plus "all sessions" CSV/JSON; **Delete this PID's data…** (type the PID to confirm).

---

## 5. Tests (what exists and what it proves)

| Command | File | Covers |
|---|---|---|
| `node test/core.test.js` | `core.test.js` | Char labels; **`I've` → `I have` gives I,v,e = `ai` and ` ha` = `typed`**; replay; delta logic |
| `node test/analysis.test.js` | `analysis.test.js` | Revisions, pauses (incl. time spent in the chat tab), AI-edited spans, `I have` marked AI-edited, rejected autocomplete, undone autocorrect, unused AI reply, AI-inspired flag, blocked entries, every filter group (AND across groups, OR within), CSV output |
| `node test/api.test.js` | `api.test.js` | Unknown PID rejected, two PIDs saved separately, order alternates, can't skip ahead, **resume under the same PID after a "crash"**, integrity check on Send |
| `node test/chat.test.js` | `chat.test.js` | Chat refused before an email begins, streaming word-by-word + pacing, config doesn't leak model/prompt, AI-paste labels saved, unused-reply flag (`R2` not used), transcript saved |
| `node test/admin.test.js` | `admin.test.js` | Full simulated two-email session via the API, participant fetch of own emails, autocomplete endpoint rules, researcher endpoints, CSV/chat/email exports, path-traversal refused, delete requires typing the PID |
| `npm run test:browser` | `browser.test.js` | **Real Chrome**: typing, **Tab-accept**, Esc dismiss, autocorrect kept + **undone with one Backspace**, **outside paste blocked** (email *and* chat), **drop blocked**, copy/paste inside the email, chat reply streaming, copy button → paste into email labelled `ai`, editing inside AI text, **refresh mid-writing restores draft + chat**, Send, log view, filters (AI pasted; edits inside AI text), second email, comparison with one filter driving both sides, saved event types and labels, **no console errors** |

All six passed on 2026-11-04. `npm run test:browser` writes screenshots (set `SHOTS=dir`) — handy for eyeballing layout.

---

## 6. Still to do / still to check

### 6.1 Checks that need a human (not automated, highest priority)
- [ ] **Browser spellcheck, in every browser** (Chrome, Edge, Firefox, Safari): type a typo, right-click → pick the suggestion → confirm the saved edit has `source: spellcheck` / `inputType: insertReplacementText`. If a browser reports it differently the label will fall to `unknown` and be flagged (not silently wrong).
- [ ] **Run the whole test suite's scenarios by hand in Firefox, Safari and Edge** (only Chrome is automated): Tab-accept, Esc, autocorrect undo, outside-paste block, drag/drop block, copy button, refresh-restore.
- [ ] **Ghost-text alignment** with long emails (wrapped lines, scrolling, very long paragraph, Safari `scrollbar-gutter`): the grey suggestion is drawn on a mirror layer behind the textarea and could drift on long text. Only a short email has been checked visually.
- [ ] **Laptop sleep / network drop** mid-writing, then resume under the same PID (pilot checklist item). Refresh is tested; sleep is not.
- [ ] **Screen-share readability** of the log view and comparison view over your actual call software (fonts/contrast were sized up, never seen over a call).
- [ ] **Email and chat timestamps line up** in the log view during a *real* session (they share one server-synced clock, so should; confirm by eye on a pilot).
- [ ] **A real pilot dry run** (someone who isn't you, in a private window, own laptop, with you guiding over the call).
- [ ] **Clipboard in the deployed setting:** `navigator.clipboard` needs HTTPS (or localhost). The copy button has a fallback, but test on the real server URL.

### 6.2 Needs an API key
- [ ] Run with `ANTHROPIC_API_KEY`: chat **streaming** (word-by-word) through the real API, error handling mid-stream, long replies.
- [ ] **Autocomplete latency and quality** with the small model (`LLM_AUTOCOMPLETE_MODEL`): suggestions should arrive fast enough to feel like Smart Compose; tune `LLM_AUTOCOMPLETE_SYSTEM_PROMPT`, `AUTOCOMPLETE_PAUSE_MS`, `AUTOCOMPLETE_MIN_CHARS`.
- [ ] Decide and set **`CHAT_SYSTEM_PROMPT`** (currently empty = plain model behaviour).

### 6.3 Test gaps worth adding
- [ ] Browser test: **paste the participant's own draft into the chat** (allowed + logged as `own_email`) and **mouse-select a phrase in an AI reply → copy → paste into the email** (selection copy path; only the copy *button* is tested in a browser).
- [ ] Browser test: **undo/redo (Ctrl/Cmd+Z)** of an autocorrect and of a deletion of AI text (code restores labels from a "graveyard"; only the Backspace undo is browser-tested).
- [ ] Browser test: **cut** from the email and paste elsewhere; typing over a selection; Enter/newlines inside AI text.
- [ ] Test **accepting an autocomplete suggestion that is then edited** ("partly kept") and **typing through** a suggestion (shrinking ghost text).
- [ ] Test **two browser tabs open on the same PID** (events from both would interleave — there is no guard yet).
- [ ] **Hand-code one pilot session** and compare with the derived revisions/flags (are the 2 s bursts the right grain? are AI-inspired flags precise enough?).
- [ ] A test for server restart mid-session (state is on disk, so it should resume; untested).

### 6.4 Spec items not done or only partly done
- [ ] **AI-inspired flag**: `please let me know` is **4 words**, so at the default `AI_INSPIRED_MATCH_WORDS: 4` it matches (your spec calls it a stock phrase that shouldn't trigger). Choose: raise to 5, or add a stock-phrase list. Also: only text **still in the final email** is checked (typed-then-deleted AI wording isn't flagged), and it compares typed runs only.
- [ ] **Clock sync** happens once at session start (as specified); long sessions could drift slightly — not re-synced.
- [ ] **Keystroke event** stores delta instead of full "text before and after" (deliberate; say if you need the literal form).
- [ ] **Edits CSV has no coding columns** yet (meaning-based categories come from your codebook later).
- [ ] **"Long pause"** filter currently = any pause ≥ `PAUSE_MS` (2 s). If you want a separate, longer "long pause" threshold, add one to config.
- [ ] **Participant app is unauthenticated** (PID = credential). OK for supervised sessions on a private network; add a researcher-issued token if the server is exposed.
- [ ] **Event endpoint accepts any events** for an in-progress email (no signing). Fine for supervised use.
- [ ] Mobile/tablets unsupported (as specified).

### 6.5 Content and process (not code)
- [ ] **Write the real scenarios** (`config/scenarios.json`: role, relationship, subject, goal) and set the real To addresses.
- [ ] **Decide the counterbalancing** — edit `config/participants.csv` for the real PIDs and order.
- [ ] **Remove the demo data** before real participants: `data/DEMO` and the `DEMO`/`DEMO2` rows in `participants.csv`.
- [ ] **Hosting:** university-approved server, HTTPS, limited access, backups, file permissions on `data/`, set `RESEARCHER_KEY`.
- [ ] **IRB items:** PID↔person key kept separately, consent covers screen-share video, withdrawal procedure (the delete button removes app data; **the interview recording must be deleted separately**).
- [ ] **Recording names:** name each recording with the PID (PID is shown in the app header during writing and in the log views).
- [ ] Brief participants: private/incognito window (extensions off), don't type real confidential details (also printed on the scenario card).

---

## 7. A 15-minute manual walkthrough (to check the logs yourself)

1. `node server.js`; open `http://localhost:3000` in a **private window**; enter `P01`; **Begin writing**.
2. Type `Hi Sam,` + two Enters + `I wanted to` and wait ~1 s → grey text appears; press **Tab** → it becomes normal text.
3. Type ` it teh ` → `teh` becomes `the`. Type `alot ` → becomes `a lot`; press **Backspace once** → back to `alot`.
4. Type `Could we` and wait for a suggestion; press **Esc** (rejected).
5. Try to **paste** something copied from another app → blocked message. Try dragging text in → blocked.
6. Type a deliberate typo (e.g. `schedual`), right-click, **pick a spellcheck suggestion**.
7. **AI Chat** tab: ask "make this more professional", wait for the reply, **Copy**, back to **Email**, **paste**. Change `I've` → `I have` inside the pasted text. Type a sentence copied by eye from the reply.
8. **Send** → the log view opens. Check: the final email is coloured by source; the list shows each step above with time and "pause before"; click the paste entry (links to the AI reply); the unused/used reply status; filter by **AI pasted**, **Your changes to AI text**, **Rejected autocomplete**, **Undone autocorrect**, **Possibly AI-inspired**.
9. Start the second email, write a few words, Send → **Open comparison view**; use one filter and check both sides change.
10. Open `data/P01/session.json` (labels, events, `ai_replies`, `integrity` all true) and `/researcher.html` → download **Edits CSV** and **Events CSV**.

If anything in step 8 doesn't match what you did in steps 2–7, that is exactly the bug to report.

---

## 8. Known limitations (be aware, not necessarily bugs)
* Mock chat/autocomplete replies are canned and keyword-based (`server.js`: `mockReply`, `mockComplete`).
* The simulated `DEMO` session shows the log view and analysis work; it does **not** prove browser capture — that is what the Chrome test and your manual walkthrough are for.
* Revision grouping, size classes (small ≤1 word, large ≥8 words) and the AI-inspired matching are heuristics; they are configurable and should be validated against hand-coding.
* Text the participant types that later gets deleted still appears in the log (as it should), but is invisible to the final-text-based flags.

---

## 9. `prototype-v1/` additions (Pari, Nov 2026)

`prototype-v1/` is a separate, single-email, two-file app (`server.js` + `index.html`, no dependencies). It does **not** share code or data with the main app above. These features were added to it to try out ideas; nothing in the main app was changed.

### Run it
```powershell
cd prototype-v1
$env:ANTHROPIC_API_KEY = "sk-ant-..."     # PowerShell; on macOS/Linux: ANTHROPIC_API_KEY=sk-ant-... node server.js
node server.js
```
Open `http://localhost:3000/?pid=P01` (supervisor scenario) or `http://localhost:3000/?pid=P01&cond=colleague`.

| Setting (environment variable) | Default | What it does |
|---|---|---|
| `PROVIDER` | `anthropic` | `openai` = any OpenAI-compatible API (OpenAI, Gemini, OpenRouter, Groq, Ollama) |
| `LLM_BASE_URL`, `LLM_API_KEY` | OpenAI's URL | Used when `PROVIDER=openai`; the key decides which OpenAI project is billed |
| `MODEL` | `claude-sonnet-5-5` / `gpt-4o` | Chat model |
| `AC_MODEL` | `claude-haiku-5-5` / `gpt-4o-mini` | Small, fast autocomplete model |
| `CHAT_SYSTEM_PROMPT`, `AC_SYSTEM_PROMPT` | empty / built-in | System prompts |
| `PORT` | `3000` | Server port |

### What was added
- **Scenario card** from `prototype-v1/scenarios.json` (placeholder text; re-read on every page load). Shown on both tabs while writing, with the privacy reminder. To (read-only) and Subject are pre-filled. Condition comes from `?cond=` in the link; there is no admin screen or automatic order alternation.
- **Per-character source labels** for To, Subject and Body: `typed`, `ai` (with reply and paste IDs), `autocomplete`, `spellcheck`, `prefilled`, `unknown` (e.g. pasted from outside the app). Labels follow the text through edits, undo/redo, and copy/paste within the email. Edits inside pasted AI text mark that paste as an **AI-edited span**. The spec's `I've` → `I have` case gives I, v, e = `ai` and ` ha` = `typed`.
- **AI pastes linked to the reply** they came from (copy button or selecting text in the chat); replies are saved with `used: true/false`.
- **Autocomplete** (Smart Compose style): grey text drawn on a mirror layer behind the textarea; Tab accepts (undoable with Ctrl+Z), Esc dismisses, typing the same letters keeps it. Only suggests at the end of the text at a word boundary, ~0.6 s after typing stops (settings in `AC` at the top of the script). Logged as shown / accepted / partly kept / dismissed (with reason) / dropped.
- **Log view filters**: chips for Typed, AI pasted, AI edited by participant, Autocomplete, Spellcheck, Unknown/outside, Deletions, AI chat, Undo/other. Several can be on at once; none selected = everything (the default). The final email is colour-coded and non-matching text is dimmed.
- **Readable outputs.** On Send, four files go to `prototype-v1/logs/<PID>/`:

  | File | Use |
  |---|---|
  | `<PID>-<session>-report.html` | Self-contained report: scenario, colour-coded email, full revision history with working filters, AI chat transcript with used/not-used replies. Opens offline; prints to PDF. |
  | `<PID>-<session>-edits.csv` | One row per revision: source, inside AI text, change kind/size, words and exact characters added/removed, timing, pause before |
  | `<PID>-<session>-events.csv` | One row per raw event |
  | `<PID>-<session>-session.json` | Master record (includes `char_labels`, `ai_edited_spans`, `ai_replies`) |

  The same files can be downloaded from the log view. CSVs open correctly in Excel (UTF-8; formula-like text is neutralised).

### How it was checked
- A simulated edit sequence (paste, `I've` → `I have`, spellcheck, undo, outside paste, internal copy/paste, CSV output) and an end-to-end run in headless Chrome against the real server (typing, AI paste and edit, ghost-text alignment on wrapped text, Tab accept, Send, saved files, filters, report). These scripts were run locally and are not in `test/`.
- **Not yet checked:** real API calls (chat and autocomplete quality/latency), real right-click spellcheck, Firefox/Safari/Edge, long emails that scroll.

### Not in the prototype (the main app already has these)
Admin/order alternation, two-email flow and comparison view, outside paste/drop blocking, autocorrect, word-by-word chat replies, crash resume, clock sync, researcher page.
