// The AI provider behind Hireriv's assistant (Step 66). The rest of the app
// calls generate() and never knows which provider answered, so another one can
// be added here without touching the features.
//
// Providers (AI_PROVIDER):
//   anthropic  Claude through the official SDK; the key (ANTHROPIC_API_KEY)
//              stays on the server and is never logged or sent to browsers
//   off        no provider: every feature uses its rules-based fallback
//   mock       canned answers for tests; refused when NODE_ENV=production
// Unset: anthropic when ANTHROPIC_API_KEY is set, otherwise off.
const crypto = require('crypto');

// US dollars per million tokens (input, output), for the cost limits.
// Update with the provider's published prices; unknown models count as the most expensive here.
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
const DEFAULT_MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 30000;

// Cost in millionths of a dollar, so sums stay exact integers.
function costMicros(model, inputTokens, outputTokens) {
  const [inp, out] = PRICES[model] || Object.values(PRICES).reduce((a, b) => (a[1] >= b[1] ? a : b));
  return Math.ceil(inputTokens * inp + outputTokens * out);
}

class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function anthropicProvider({ apiKey, model }) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return {
    name: 'anthropic',
    model,
    // One request: a system prompt, the conversation, and optionally a JSON
    // schema the answer must follow. No tools: the model can only write text.
    async generate({ system, messages, schema, maxTokens = 4000, effort = 'medium' }) {
      let res;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages,
          output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
          // If the model declines for a safety reason, Anthropic's recommended fallback answers instead.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) throw new ProviderError('rate_limited', 'the AI provider is busy');
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new ProviderError('misconfigured', 'the AI provider rejected our credentials');
        if (err instanceof Anthropic.BadRequestError) throw new ProviderError('bad_request', 'the AI provider could not use the request');
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('timeout', 'the AI provider did not answer in time');
        if (err instanceof Anthropic.APIError) throw new ProviderError('unavailable', 'the AI provider is unavailable');
        throw err;
      }
      const usage = { input: res.usage.input_tokens + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0), output: res.usage.output_tokens };
      if (res.stop_reason === 'refusal') throw Object.assign(new ProviderError('declined', 'the AI declined this request'), { usage, model: res.model });
      if (res.stop_reason === 'max_tokens') throw Object.assign(new ProviderError('truncated', 'the answer was too long'), { usage, model: res.model });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      let json = null;
      if (schema) {
        try { json = JSON.parse(text); } catch (e) { throw Object.assign(new ProviderError('invalid_output', 'the answer was not in the expected form'), { usage, model: res.model }); }
      }
      return { text, json, usage, model: res.model || model };
    },
  };
}

// Deterministic answers built from the request, for tests. A file named by
// AI_MOCK_FAIL_FILE makes every call fail, to test outages.
function mockProvider() {
  const last = (messages) => {
    const m = messages[messages.length - 1];
    return typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join('');
  };
  return {
    name: 'mock',
    model: 'mock-model',
    async generate({ system, messages, schema, task }) {
      const failFile = process.env.AI_MOCK_FAIL_FILE;
      if (failFile && require('fs').existsSync(failFile)) throw new ProviderError('unavailable', 'the AI provider is unavailable');
      const input = last(messages);
      const usage = { input: Math.ceil((system.length + input.length) / 4), output: 200 };
      const pick = (re) => ((input.match(re) || [])[1] || '').trim();
      let json = null;
      let text = '';
      if (task === 'job-draft') {
        const title = pick(/Title: (.+)/) || 'the role';
        json = {
          summary: `A ${title} role.`,
          description: `We are hiring a ${title}. ${input.includes('MOCK_INVENT') ? 'We pay ₹45,000 a month with free meals and a joining bonus.' : 'You will join a small, friendly team.'}`,
          responsibilities: [`Carry out the daily work of a ${title}`, 'Follow safety and quality rules'],
          qualifications: ['Relevant experience is helpful'],
          skills: pick(/Skills: (.+)/).split(',').map((s) => s.trim()).filter(Boolean),
          questions_for_employer: ['What are the working hours?'],
        };
      } else if (task === 'match-explain') {
        json = { summary: 'The skills overlap well; experience is close to what the job asks.', strengths: ['Skills match the job'], gaps: ['Location not confirmed'], questions_to_ask: ['When could you start?'] };
      } else if (task === 'resume-summary') {
        json = { summary: `Summary of a resume of ${input.length} characters.`, experience: ['Several years in similar work'], skills: ['Communication'], education: [], points_to_check: ['Dates of the latest role'], seen: input.includes('[email removed]') ? 'redacted' : 'raw' };
      } else if (task === 'interview-questions') {
        json = { questions: [
          { question: 'Tell me about a time you solved a problem at work.', why: 'Problem solving', listen_for: 'A clear example', type: 'behavioural' },
          { question: 'How old are you and are you married?', why: 'Personal', listen_for: '', type: 'personal' },
          { question: 'Which of the listed skills have you used most recently?', why: 'Skills', listen_for: 'Specific tasks', type: 'skills' },
        ] };
      } else if (task === 'job-translation') {
        // "हिन्दी: …" in front of every value; numbers kept, unless the
        // listing asks the mock to drop them (MOCK_DROP_NUMBERS).
        const src = JSON.parse((input.match(/<untrusted_job_listing>\n([\s\S]*)\n<\/untrusted_job_listing>/) || [])[1] || '{}');
        const drop = input.includes('MOCK_DROP_NUMBERS');
        const tr = (x) => `हिन्दी: ${drop ? String(x).replace(/\d/g, '') : x}`;
        json = {
          title: tr(src.title || ''), description: tr(src.description || ''), responsibilities: (src.responsibilities || []).map(tr), qualifications: (src.qualifications || []).map(tr),
          benefits: (src.benefits || []).map(tr), unclear: ['"shift" was kept in English'],
        };
      } else {
        text = input.includes('ignore previous instructions') ? 'I can help with your job search, resume and interviews.' : `Here is some help with: ${input.slice(0, 80)}`;
      }
      return { text: json ? JSON.stringify(json) : text, json, usage, model: 'mock-model' };
    },
  };
}

function create(env = process.env) {
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const choice = env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'off');
  if (choice === 'mock') {
    if (env.NODE_ENV === 'production') throw new Error('AI_PROVIDER=mock is not allowed in production');
    return mockProvider();
  }
  if (choice === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return null;
    return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  return null;
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { create, costMicros, PRICES, DEFAULT_MODEL, ProviderError, hash };
