# ExamPrep — Project Architecture

One-page map so you can find anything quickly and know where to make changes.

## Directory layout

```
examprep/
├── api/                      Vercel serverless functions (one per file = one route)
│   ├── _lib/                   shared helpers imported by routes
│   │   ├── gemini-key.mjs        Gemini key fallback + quota detection
│   │   ├── pdf-positions.mjs     extractPositions + buildLines (pdf.js/unpdf)
│   │   ├── pdf-mcq-detect.mjs    MCQ detection: sections/standalone/classify/extract
│   │   └── pdf-group-context.mjs applyGroupContextToCrops + extractContextText
│   ├── upload.mjs              POST /api/upload — the big one (~1700 LOC)
│   ├── crud.mjs                CRUD dispatcher for courses/exams/questions/batches
│   ├── contact.mjs             contact-form email
│   ├── client-error.mjs        browser error telemetry sink
│   ├── exams/
│   │   ├── generate-solutions.mjs  batch AI explanation generator
│   │   └── reverify-answers.mjs    re-run Gemini answer extraction for an exam
│   ├── lab/
│   │   ├── generate-questions.mjs  AI-generated MCQs from a topic prompt
│   │   └── generate-mock-exam.mjs  smart mock exam (balanced / hard / weak focus)
│   ├── questions/
│   │   ├── generate-solution.mjs   per-question AI solution
│   │   └── enhance-solution.mjs    refine an existing solution's wording
│   └── study/
│       └── generate.mjs            study pack from source material
├── public/                   Static SPA
│   ├── app.js                  single-file frontend (~8k LOC, TOC at top)
│   ├── index.html              HTML skeleton + all view templates
│   ├── styles.css              all CSS
│   ├── data/                   bundled tohna1 demo data (admin testing)
│   └── images/                 logos + built-in course covers
├── supabase/
│   └── migrations/             schema history (apply via Supabase dashboard or CLI)
├── server.mjs                Dev-only Node server for running locally
├── vercel.json               routing + env config
├── package.json              runtime deps
└── README.md                 product overview
```

## Upload pipeline — where each stage lives

```
public/app.js  ──── POST multipart ────▶  api/upload.mjs
                                              │
              ┌───────────────────────────────┤
              │                               │
              ▼                               ▼
  api/_lib/pdf-positions.mjs          Gemini analyze (inline in upload.mjs):
  extractPositions()                    - analyzeExamWithGemini  (coords + groups)
  buildLines()                          - analyzeSolutionPdf     (match + answers)
              │                           - crossVerifyAnswersWithGroq
              ▼                           │
  api/_lib/pdf-mcq-detect.mjs             ▼
  findStandaloneQuestions()         merge text-layer + Gemini
  detectMCQsFromPositions()               │
              │                           ▼
              └──────────────▶  api/_lib/pdf-group-context.mjs
                                  applyGroupContextToCrops()
                                  extractContextText()
                                          │
                                          ▼
                                  DB insert (ep_exams, ep_questions)
```

## Frontend (public/app.js) — navigation

`app.js` is a single file. A TOC at the top points to every major section. Each section has a `// ===== SectionName =====` marker — search for that to jump.

High-level flow:

1. `navigate()` reads `location.hash` and dispatches to a `renderX()` function.
2. Each renderer clones a `<template id="tmpl-X">` from `index.html` and fills it with state.
3. State lives in a global `state` object; localStorage + Supabase dual-write for courses/exams/attempts/batches.

## Where to make common changes

| I want to… | Go to |
|---|---|
| Change how MCQs are detected in a PDF | `api/_lib/pdf-mcq-detect.mjs` |
| Change what gets grouped together as a "set" | `api/_lib/pdf-group-context.mjs` + Gemini prompt in `api/upload.mjs` `analyzeExamWithGemini` |
| Accept/reject solution PDFs differently | `api/upload.mjs` — search for `stronglyMatched` |
| Change AI solution wording | `api/exams/generate-solutions.mjs` |
| Add a new route page | Add `renderX()` in `public/app.js`, add `<template id="tmpl-x">` in `public/index.html`, add hash dispatch in `navigate()` |
| Update dashboard UI | `public/app.js` → search for `===== Render: Dashboard =====` |
| Update upload-modal UI | `public/app.js` → search for `showUploadPdfModal` |
| Add a DB column | Write a new `supabase/migrations/<name>.sql`, apply via Supabase CLI / dashboard |

## Database (Supabase)

Shared project with `tohna1`. ExamPrep tables use the `ep_` prefix:
`ep_courses`, `ep_exams`, `ep_questions`, `ep_attempts`, `ep_batches`, `ep_study_packs`, plus `profiles` for the user/plan/admin flag.

Images live in Cloudinary (not Supabase Storage) — PDFs are uploaded as raw PDFs and served as cropped page images via Cloudinary transformation URLs built in `upload.mjs` (`buildCropUrl`).

## Deploy

`vercel --prod --yes` after every change. Git push alone does NOT trigger a deploy.
Production URL: https://try.examprep.com
