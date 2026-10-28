# School CBT

A simple computer-based testing website for English Language, built from the three source papers:

| Level    | Classes            | Test                                                                        | Raw marks → /40                         |
|----------|--------------------|-----------------------------------------------------------------------------|-----------------------------------------|
| Lower    | JSS1               | Comprehension (“The Garden Behind the Classroom”), vocabulary, collective nouns, pronouns, story — interactive mode | 50 × 0.8                                 |
| Upper    | JSS2, JSS3         | 30 grammar MCQs + two informal letters                                      | 50 × 0.8                                 |
| Advanced | SSS1, SSS2, SSS3   | 60 grammar short answers (passage + clauses), informal letter, opinion essay | grammar 30 × ⅔ = 20, letter 10, essay 10 |

Student journey: **enter details → choose level and class → take the test → submit → view and download the result.**
Everything else is on one password-protected teacher page at `/teacher`.

## Running it

Requirements: **Node.js 22.5 or newer** (it uses Node’s built-in SQLite). There are no other dependencies and no `npm install` step.

```bash
TEACHER_PASSWORD='choose-a-strong-password' npm start
# School CBT running on http://localhost:3000
```

* Students open `http://<server-address>:3000/` on any phone, tablet or computer on the same network.
* Teachers open `http://<server-address>:3000/teacher`.
* If you don’t set `TEACHER_PASSWORD`, a random first password is printed and saved to `data/teacher-password.txt`. Change it under **Settings** and delete that file.
* All records live in `data/cbt.sqlite` (set `CBT_DB` to move it). Back this file up — it holds students, answers, marking records and results.
* Change the port with `PORT=8080`.

To run it on the internet rather than a school network, use any host that runs Node 22.5+ and keeps a persistent disk for `data/` (for example a small VPS), and put it behind HTTPS.

## Putting it online with Vercel

Vercel cannot keep files between visits, so on Vercel the website stores everything in a free **Turso** database instead of a file. Nothing else changes for students or teachers.

1. Upload this project to a GitHub repository (keep it **Private** — it contains the answer keys).
2. On **vercel.com**, sign in with GitHub → **Add New… → Project** → pick the repository → **Deploy**. (No settings to change: `vercel.json` already configures it.)
3. In the new Vercel project open **Storage** (or **Integrations → Marketplace**) → choose **Turso Cloud** → create a database and **connect it to this project**. This adds the database address and key to the project automatically.
   If you create the database on turso.tech yourself instead, add two **Environment Variables** in Vercel: `TURSO_DATABASE_URL` (starts with `libsql://`) and `TURSO_AUTH_TOKEN`.
4. In **Settings → Environment Variables** add `TEACHER_PASSWORD` with your chosen teacher password. Optionally add `ANTHROPIC_API_KEY` for automatic marking of written work.
5. Open **Deployments** → the latest one → **⋯ → Redeploy**, so the new settings take effect.
6. Visit your Vercel address (for example `https://guided-soul-assessment.vercel.app`). Teachers use `/teacher`; **Settings** there shows “Records are stored in: Turso Cloud database”.

If the database is not connected, the website shows a clear message instead of running without storage.

On Vercel there are no background timers. Tests whose time has run out are submitted automatically the next time anyone loads the start page, a result page or the teacher page, using the deadline the server recorded; written-work marking continues while the result page or the teacher’s review page is open.

## First-time checklist (teacher page)

1. **Settings** → school name, logo, session, term, grading scale, positions on/off, feedback release.
2. **Settings → Automatic marking of written work** → add an Anthropic API key (or set `ANTHROPIC_API_KEY` on the server). Without it, letters, essays, the JSS1 story and any grammar answer the rules can’t judge go to **Marking review**, and those results stay “pending review” until an examiner marks them.

## Important notes about the source papers

* **Advanced letter and essay:** the paper says they “retain their existing marking guides”, but those guides were not in the document. At the school’s request the app uses standard criteria automatically (Content 3, Organisation 2, Expression 3, Mechanical accuracy 2 — the same structure as the JSS2/3 letter guide), so the SSS test is available straight away. Teachers can change them under **Tests & mark schemes → Edit content**.
* All other answer keys and mark schemes are transcribed exactly. The completeness check (keys present, criteria adding up to each question’s marks, groups converting to 40) runs before any test can be made available.

## How marking works

* **Objective questions** (MCQ, word bank): exact answer keys.
* **Advanced grammar answers**: deterministic rules built from the marking guide — grammatical names, ¼ + ¼ name-and-type credit, functions that must name the word concerned (instruction 3), and exact clause copying (introductory word required). The rules accept paraphrases and minor misspellings, and reject negated or contradictory answers and keyword-only answers. When the rules can’t decide reliably, the answer goes to AI-assisted marking or to examiner review — never to a silent zero.
* **Letters, essays, story**: AI-assisted marking, criterion by criterion, with evidence quotes that are checked against the student’s actual answer. Low confidence, unverifiable evidence, off-topic work, instructions hidden in an answer, or repeated technical failure all send the item to **Marking review**.
* Every mark stores the answer, question and scheme versions, marks per criterion, evidence, reasons, engine version, timestamp, status and flags. Every change (including examiner corrections, which require a reason) is appended to an audit trail; the original assessment is never overwritten.
* Answer keys and mark schemes are never sent to students’ browsers. Detailed per-question feedback appears on the result page only after the release time set in Settings.

## Scores

Raw marks are kept. The final score is `Σ (raw ÷ raw maximum) × weight` with weights totalling 40, rounded to 2 decimal places only at the end; the percentage and grade use the unrounded value. Results, PDFs and broadsheets show `Score: X / 40`. For several subjects, totals are labelled `/ 40 × number of subjects` and averages are out of 40. Positions appear only when every result in the class is complete.

## Checks

```bash
npm test                       # using a local database file
CBT_TEST_DB=turso npm test     # the same checks against a Turso stand-in, in Vercel-style serverless mode
```

Runs 51 automated checks against a throw-away database covering the requirements list: correct test per class, 90-minute timer that survives refreshes, auto-submit on expiry, passages available, nothing confidential sent to students, JSS1 confirm-and-lock, scheme-faithful written marking, pending on failed/uncertain marking, scores out of 40 (including the papers’ worked examples), duplicate-submission safety, and result sheets/broadsheets matching stored records.

## Project layout

```
run-local.js         starts the website on a school computer (npm start)
api/index.js         Vercel entry point (vercel.json routes /api/* here)
api/_app/server.js   the application: HTTP routes and API
api/_app/lib/db.js            storage: local SQLite file or Turso Cloud; schema, settings, seeding
api/_app/lib/exams.js         validation (completeness check) and the student-safe view of a test
api/_app/lib/grammar.js       deterministic grammar marking rules
api/_app/lib/ai.js            AI-assisted criterion marking (Anthropic Messages API)
api/_app/lib/marking.js       marking pipeline, retries, review queue, overrides, audit trail
api/_app/lib/scoring.js       conversion to /40, grades, positions, sheets, broadsheets
api/_app/lib/pdf.js, xlsx.js  dependency-free PDF and Excel writers
api/_app/lib/reports.js       result sheet PDF, broadsheet CSV/Excel
api/_app/seed/     the three tests transcribed from the source papers
public/              student pages (index, test, result) and the teacher page
test/run-tests.js    automated checks
test/turso-standin.js  stand-in for Turso's HTTP API used by the checks
```
