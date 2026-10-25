# AI recruitment assistant and hiring copilot

Step 66. Code: `ai-provider.js` (the provider layer), `ai-assistant.js` (the features, safeguards, limits, records and routes) and `public/js/ai.js` (the panels). Matching itself stays in `job-match.js`; the AI only explains it.

This describes how the platform behaves. It is not legal advice, and section 7 lists what needs review before the AI features are switched on for real users.

## 1. What it does

| Feature | Who | Where | What happens to the answer |
| --- | --- | --- | --- |
| Job description draft | Company members who may create jobs (`jobs.create`) | "Draft the description with AI" on the job form; `POST /api/ai/job-description/draft` | Shown beside the form. "Use this draft" copies it into the fields for the employer to edit and save; "Discard" drops it. The job still goes through Hireriv's review. |
| Match explanation | Members who may see the applicant (`applicants.view`) | "Explain the match" on an applicant; `POST /api/ai/candidate-match/explain` | Puts the factors of `job-match.js` into words, with what to ask. The score is the rules' score. |
| Resume summary | Members who may see contact details and resumes (`applicants.contact`) | "Summarise the resume"; `POST /api/ai/resume/summarize` | A summary of the resume text kept with the application. |
| Interview questions | Members who manage interviews for the job (`interviews.manage`) | "Suggest interview questions"; `POST /api/ai/interview-questions/generate` | Questions about the job, the same for every candidate. |
| Career assistant | Signed-in candidates who turned it on | `/account/assistant`; `POST /api/ai/career-assistant/message` | Help with finding jobs on Hireriv, the profile, the resume and interviews. Only live Hireriv jobs from the recommendations are suggested. |
| Feedback | The person (or company) the answer was for | Buttons under every answer; `POST /api/ai/feedback` | Helpful, not helpful, wrong or unfair, shown to the team. |

**People decide.** No AI answer changes a job, an application, its stage or its ranking. There is no automatic rejection, shortlisting or scoring by AI. An application can't be read by another company through these endpoints: everything is looked up from the signed-in company, and other ids answer 404.

## 2. Providers and settings

| Setting | Meaning |
| --- | --- |
| `AI_PROVIDER` | `anthropic` (Claude through the official `@anthropic-ai/sdk`), `off` (rules only), or `mock` (tests only; refused when `NODE_ENV=production`). When it isn't set: `anthropic` if `ANTHROPIC_API_KEY` is set, otherwise `off`. |
| `ANTHROPIC_API_KEY` | Kept in the server's environment, never in the browser, the repository or the logs. |
| `AI_MODEL` | Defaults to `claude-opus-5-5`. |

- **Request shape.** Each request has a system prompt, the conversation and, where the feature needs a fixed shape, a JSON schema (structured output). The model gets **no tools**, so it can only write text.
- **Timeouts and declines.** Requests time out after 30 seconds with one retry. If the model declines for a safety reason, Anthropic's recommended fallback model answers (`fallbacks: "default"`).
- **Adding another provider** means adding one function in `ai-provider.js` with the same `generate()` shape. The features don't change.
- **The team's settings** are at `/admin/ai` (Admins only; reason required, recorded in the hash-chained audit history):
  - the AI on or off;
  - each feature on or off;
  - requests per person per day (default 40);
  - cost per company per month (default US$20);
  - cost for the whole site per day (default US$50).

## 3. When the AI is not used

Every feature has an answer made by rules, used when:
- the AI or the feature is off, or there is no provider;
- a limit is reached;
- the provider fails or times out;
- the model declines;
- the answer doesn't have the expected shape.

What each feature falls back to:
- **Drafts**: a skeleton with the employer's own details and placeholders.
- **Match explanations**: the factors as they are.
- **Resume summaries**: the existing resume parser.
- **Interview questions**: questions built from the job's responsibilities and skills.
- **Career assistant**: the person's recommended jobs.

The answer always says it was made without AI and why. After three failures in a row the provider is skipped for a minute (a circuit breaker). Job search, applying and the rest of the site never call the AI.

## 4. Safeguards

- **Nothing invented about pay or benefits.** Any sentence in a draft that mentions money, CTC, a bonus or a perk the employer didn't type is removed, and the employer is told what was removed and why. Amounts are compared without digit grouping (22,000 = 22000).
- **Fair questions and summaries.** Lines and questions about age, date of birth, marriage, family, pregnancy, religion, caste, health, disability, nationality, gender or photos are dropped. Interview questions say how many were removed. The prompts say the same.
- **Prompt injection.** Text from employers, resumes and candidates goes inside `<untrusted_…>` fences, and copies of our own tags inside it are neutralised first. The system prompt says it is information, never instructions. Text that looks like an attempt to give the AI instructions is flagged to the person ("treated only as information"). Because the model has no tools and its answers are only shown as plain text (never HTML), an injected instruction can't act.
- **Data sent to the provider is minimised.**
  - Removed before anything is sent: email addresses, phone numbers, web links, Aadhaar-like and PAN-like numbers, and (for resumes) the candidate's name.
  - Match explanations send only the comparison, never the person.
  - The career assistant sends the profile's skills, experience and place, and the candidate's messages, only after they turned it on (consent purpose `ai-assistant`, recorded with the policy version). Turning it off deletes the conversation.
- **Labels.** Every answer says "Written with AI assistance. Check it before you rely on it", or that it was made by rules.

## 5. Records and retention

| Collection | What | Kept |
| --- | --- | --- |
| `ai-generation-records` | Feature, who (an employer user id or a hash for candidates), company, job and application ids, provider, model, prompt version, a hash of the input, the answer, warnings, whether rules answered, and the employer's decision | 90 days |
| `ai-review-records` | Used, edited or discarded, by whom | 90 days |
| `ai-feedback` | Rating and optional comment | 90 days |
| `ai-assistant-sessions`, `ai-assistant-messages` | A candidate's conversation | 90 days after the last message; deleted when they turn the assistant off or their account is erased |
| `ai-usage-events` | Feature, outcome (AI, rules, error, declined), tokens, estimated cost, time taken. **No text** | 13 months |

**Cost** is estimated from the token counts and the prices in `ai-provider.js` (Claude Opus 5.5: US$4 per million input tokens and US$20 per million output tokens). A model not in the table is priced like the most expensive one, so the limits err on the safe side. When the fallback model answers, the estimate still uses the main model's price.

## 6. Not done yet

- **Languages.** English only. Hindi and the other languages come with Step 67.
- **No measured quality.** There is no evaluation set of real drafts and summaries yet. Answers should be sampled and the prompts tuned from the feedback before a wide launch.
- **Narrow pattern checks.** Invented pay and personal questions are caught by patterns. They catch the common forms, not every one, which is why a person reviews everything.
- **Prices kept by hand.** The price table is updated by hand.
- **No streaming.** Answers appear when they're complete.
- **No voice input** for the career assistant.

## 7. To review before switching it on (with Indian counsel)

- **Processor terms.** The AI provider processes personal data for us. That needs a processing agreement, and a check on cross-border transfer and storage under the Digital Personal Data Protection Act, 2023 and its Rules.
- **Candidate notice.** When an employer summarises a resume or explains a match, the candidate's data goes to the provider (redacted). The privacy notice should say so, and counsel should confirm whether consent or a notice is enough.
- **Fair hiring.** The AI never decides, and personal questions are filtered. Counsel should confirm the wording shown to employers, and that the features suit equal-opportunity duties for each type of employer.
- **Labelling AI content** under the IT Rules and any advisories in force at launch.
