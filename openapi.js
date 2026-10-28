// The OpenAPI 3.1 description of /api/v1 (integrations.js), served at
// /api/v1/openapi.json and rendered on the /developers page.
const { SCOPES, EVENTS, API_VERSION } = require('./integrations');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const err = (description) => json(ref('Error'), description);
const list = (item) => ({ type: 'object', required: ['data', 'has_more'], properties: { data: { type: 'array', items: ref(item) }, has_more: { type: 'boolean' }, next_cursor: { type: ['string', 'null'] } } });
const one = (item) => ({ type: 'object', required: ['data'], properties: { data: ref(item) } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const pageParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'next_cursor from the previous page' },
];
const idem = { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 100 }, description: 'Repeat a POST safely: the same key and body give the same answer for 24 hours' };
const common = { 401: err('No valid access token'), 403: err('The token lacks the permission, or the account is not active'), 429: err('Too many requests: see Retry-After') };
const op = (summary, scope, { params = [], body, ok, extra = {}, tag }) => ({
  summary, tags: [tag], security: [{ bearer: scope ? [scope] : [] }], ...(scope ? { 'x-scope': scope } : {}),
  parameters: params, ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: { ...ok, ...extra, ...common },
});

function spec(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hireriv API', version: 'v1',
      description: `Jobs, applications and webhooks for a company's own systems. Release ${API_VERSION}. Jobs sent through the API are reviewed by Hireriv before they go live, like any other.`,
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        bearer: { type: 'oauth2', description: 'Exchange your client secret for a 15-minute access token, then send Authorization: Bearer <token>.', flows: { clientCredentials: { tokenUrl: `${baseUrl}/api/v1/oauth/token`, scopes: SCOPES } } },
      },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } } } } },
        Pay: { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' }, period: { type: 'string', enum: ['month', 'year', 'day', 'hour'] }, currency: { type: 'string', const: 'INR' } } },
        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, company: { type: 'string' }, location: { type: 'string' }, mode: { type: 'string' }, type: { type: 'string' }, category: { type: 'string' },
            description: { type: 'string' }, responsibilities: { type: 'array', items: { type: 'string' } }, skills: { type: 'array', items: { type: 'string' } }, pay: ref('Pay'), payNote: { type: 'string' },
            shift: { type: 'string' }, hours: { type: 'string' }, openings: { type: 'integer' }, closesOn: { type: ['string', 'null'], format: 'date' },
            englishNeeded: { type: ['string', 'null'], enum: ['None', 'Basic', 'Good', 'Fluent', null] }, walkIn: { type: 'boolean' },
            minEducation: { type: ['string', 'null'], enum: [...['none', '10th', '12th', 'iti', 'graduate', 'postgraduate'], null], description: 'The lowest education the job takes (from the list, or read from its education text)' },
            perks: { type: 'array', items: { type: 'string', enum: ['food', 'stay', 'transport', 'pf', 'incentives', 'insurance'] }, description: 'What the job gives besides pay' },
            needsToHave: { type: 'array', items: { type: 'string', enum: ['bike', 'licence', 'smartphone', 'laptop'] }, description: 'What the worker must have for the job: their own two-wheeler, a driving licence, a smartphone or a laptop' },
            walkInDetails: { type: ['object', 'null'], properties: { from: { type: ['string', 'null'], format: 'date' }, to: { type: ['string', 'null'], format: 'date' }, time: { type: ['string', 'null'] }, contact: { type: ['string', 'null'] }, open: { type: 'boolean', description: 'false once the last walk-in day has passed' } } },
            status: { type: 'string', enum: ['draft', 'pending', 'open', 'paused', 'rejected', 'closed'] }, statusLabel: { type: 'string' }, rejectedReason: { type: ['string', 'null'] }, submittedAt: { type: ['string', 'null'] }, updatedAt: { type: ['string', 'null'] },
          },
        },
        JobInput: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 120 }, location: { type: 'string' }, mode: { type: 'string', enum: ['On-site', 'Hybrid', 'Remote'] }, type: { type: 'string' }, category: { type: 'string' },
            description: { type: 'string' }, responsibilities: { type: 'array', items: { type: 'string' } }, skills: { type: 'array', items: { type: 'string' } }, pay: ref('Pay'), payNote: { type: 'string' },
            shift: { type: 'string' }, hours: { type: 'string' }, overtime: { type: 'string' }, workerCosts: { type: 'string' }, openings: { type: 'integer' }, closesOn: { type: 'string', format: 'date' },
            english: { type: 'string', enum: ['None', 'Basic', 'Good', 'Fluent'], description: 'How much English the job needs' }, walkIn: { type: 'boolean', description: 'Walk-in interviews at the workplace address' },
            walkInFrom: { type: 'string', format: 'date' }, walkInTo: { type: 'string', format: 'date' }, walkInTime: { type: 'string', maxLength: 60 }, walkInContact: { type: 'string', maxLength: 80 },
            minEducation: { type: 'string', enum: ['none', '10th', '12th', 'iti', 'graduate', 'postgraduate'], description: 'The lowest education the job takes' },
            perks: { type: 'array', items: { type: 'string', enum: ['food', 'stay', 'transport', 'pf', 'incentives', 'insurance'] }, description: 'What the job gives besides pay; a full list replaces the old one' },
            bring: { type: 'array', items: { type: 'string', enum: ['bike', 'licence', 'smartphone', 'laptop'] }, description: 'What the worker must have for the job; a full list replaces the old one' },
            submit: { type: 'boolean', description: 'Also send it for Hireriv’s review (POST only)' },
          },
        },
        Application: {
          type: 'object',
          description: 'email and phone are included only with the applications:contact permission',
          properties: {
            id: { type: 'string' }, jobId: { type: 'string' }, jobTitle: { type: 'string' }, appliedAt: { type: 'string' }, updatedAt: { type: 'string' }, status: { type: 'string' }, stageLabel: { type: 'string' }, withdrawn: { type: 'boolean' },
            name: { type: 'string' }, experience: { type: 'string' }, location: { type: 'string' }, noticePeriod: { type: 'string' }, skills: { type: 'string' },
            email: { type: 'string' }, phone: { type: 'string' }, allowedMoves: { type: 'array', items: { type: 'string' } },
            history: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
          },
        },
        Webhook: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string', enum: Object.keys(EVENTS) } }, description: { type: 'string' }, environment: { type: 'string', enum: ['live', 'sandbox'] }, status: { type: 'string', enum: ['active', 'disabled'] }, disabledReason: { type: ['string', 'null'] }, secret: { type: 'string', description: 'The full secret only when created or rotated' }, consecutiveFailures: { type: 'integer' }, createdAt: { type: 'string' } } },
        WebhookInput: { type: 'object', required: ['url', 'events'], properties: { url: { type: 'string', format: 'uri', description: 'https on port 443 or 8443, a public address' }, events: { type: 'array', items: { type: 'string', enum: Object.keys(EVENTS) } }, description: { type: 'string' }, active: { type: 'boolean', description: 'PATCH only' } } },
        Delivery: { type: 'object', properties: { id: { type: 'string' }, eventId: { type: 'string' }, type: { type: 'string' }, status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'cancelled'] }, attempts: { type: 'integer' }, nextAttemptAt: { type: ['string', 'null'] }, lastStatus: { type: ['integer', 'null'] }, lastError: { type: ['string', 'null'] }, replayOf: { type: ['string', 'null'] } } },
        Event: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: Object.keys(EVENTS) }, created_at: { type: 'string' }, data: { type: 'object' } } },
      },
    },
    paths: {
      '/oauth/token': {
        post: {
          summary: 'Get an access token', tags: ['Authentication'], security: [],
          description: 'grant_type=client_credentials with the client secret in HTTP Basic (client id as the user) or in the body. Optional scope narrows the token.',
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type'], properties: { grant_type: { const: 'client_credentials' }, client_id: { type: 'string' }, client_secret: { type: 'string' }, scope: { type: 'string' } } } } } },
          responses: { 200: json({ type: 'object', properties: { access_token: { type: 'string' }, token_type: { const: 'Bearer' }, expires_in: { type: 'integer' }, scope: { type: 'string' } } }), 400: { description: 'unsupported_grant_type or invalid_scope' }, 401: { description: 'invalid_client' } },
        },
      },
      '/me': { get: op('Who this token belongs to', null, { tag: 'Authentication', ok: { 200: json({ type: 'object' }) } }) },
      '/jobs': {
        get: op('List the company’s jobs', 'jobs:read', { tag: 'Jobs', params: [...pageParams, { name: 'status', in: 'query', schema: { type: 'string' } }], ok: { 200: json(list('Job')) } }),
        post: op('Create a job (a draft, or sent for review)', 'jobs:write', { tag: 'Jobs', params: [idem], body: ref('JobInput'), ok: { 201: json(one('Job'), 'Created') }, extra: { 400: err('Not valid'), 422: err('Idempotency-Key reused with another body') } }),
      },
      '/jobs/{id}': {
        get: op('Read a job', 'jobs:read', { tag: 'Jobs', params: [idParam], ok: { 200: json(one('Job')) }, extra: { 404: err('Not found') } }),
        patch: op('Change a job (a live job goes back for review)', 'jobs:write', { tag: 'Jobs', params: [idParam], body: ref('JobInput'), ok: { 200: json(one('Job')) }, extra: { 400: err('Not valid'), 404: err('Not found') } }),
      },
      '/jobs/{id}/submit': { post: op('Send a job for Hireriv’s review', 'jobs:write', { tag: 'Jobs', params: [idParam], ok: { 200: json(one('Job')) }, extra: { 404: err('Not found'), 409: err('Cannot be sent yet: see the message') } }) },
      '/jobs/{id}/close': { post: op('Close a job', 'jobs:write', { tag: 'Jobs', params: [idParam], ok: { 200: json(one('Job')) }, extra: { 404: err('Not found'), 409: err('Restricted by moderators') } }) },
      '/applications': { get: op('List applications to the company’s jobs', 'applications:read', { tag: 'Applications', params: [...pageParams, { name: 'job_id', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } }], ok: { 200: json(list('Application')) } }) },
      '/applications/{id}': { get: op('Read an application', 'applications:read', { tag: 'Applications', params: [idParam], ok: { 200: json(one('Application')) }, extra: { 404: err('Not found') } }) },
      '/applications/{id}/status': { patch: op('Move an application to another stage', 'applications:status:update', { tag: 'Applications', params: [idParam], body: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } }, ok: { 200: json(one('Application')) }, extra: { 400: err('Unknown stage'), 404: err('Not found'), 409: err('Not an allowed move') } }) },
      '/webhooks': {
        get: op('List webhook endpoints', 'webhooks:manage', { tag: 'Webhooks', params: pageParams, ok: { 200: json(list('Webhook')) } }),
        post: op('Add a webhook endpoint (the signing secret is shown once)', 'webhooks:manage', { tag: 'Webhooks', params: [idem], body: ref('WebhookInput'), ok: { 201: json(one('Webhook'), 'Created') }, extra: { 400: err('Not valid, or not a public https address') } }),
      },
      '/webhooks/{id}': {
        patch: op('Change, turn on or turn off an endpoint', 'webhooks:manage', { tag: 'Webhooks', params: [idParam], body: ref('WebhookInput'), ok: { 200: json(one('Webhook')) }, extra: { 404: err('Not found') } }),
        delete: op('Delete an endpoint', 'webhooks:manage', { tag: 'Webhooks', params: [idParam], ok: { 204: { description: 'Deleted' } }, extra: { 404: err('Not found') } }),
      },
      '/webhooks/{id}/rotate-secret': { post: op('Rotate the signing secret (the old one also signs for 24 hours)', 'webhooks:manage', { tag: 'Webhooks', params: [idParam], ok: { 200: json(one('Webhook')) }, extra: { 404: err('Not found') } }) },
      '/webhooks/{id}/test': { post: op('Send a webhook.test event', 'webhooks:manage', { tag: 'Webhooks', params: [idParam], ok: { 202: json({ type: 'object' }, 'Queued') }, extra: { 404: err('Not found') } }) },
      '/webhooks/{id}/deliveries': { get: op('Recent deliveries to an endpoint (30 days)', 'webhooks:manage', { tag: 'Webhooks', params: [idParam, ...pageParams], ok: { 200: json(list('Delivery')) }, extra: { 404: err('Not found') } }) },
      '/webhook-deliveries/{id}/replay': { post: op('Send a delivery again (same event id)', 'webhooks:manage', { tag: 'Webhooks', params: [idParam], ok: { 202: json(one('Delivery'), 'Queued') }, extra: { 404: err('Not found'), 409: err('The endpoint is off') } }) },
      '/events': { get: op('The company’s events of the last 30 days', null, { tag: 'Webhooks', params: [...pageParams, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }], ok: { 200: json(list('Event')) } }) },
      '/public/jobs': { get: { summary: 'Search live jobs (no token needed)', tags: ['Public'], security: [], parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'location', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'The same listings the website shows' } } } },
      '/public/jobs/{slug}': { get: { summary: 'One live job (no token needed)', tags: ['Public'], security: [], parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' }, 404: { description: 'Not found' }, 410: { description: 'Closed' } } } },
    },
    'x-webhooks': Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, { description: v }])),
  };
}

// The endpoints grouped for the portal page.
function groups(s) {
  const out = new Map();
  for (const [path, methods] of Object.entries(s.paths)) {
    for (const [method, o] of Object.entries(methods)) {
      const tag = o.tags[0];
      if (!out.has(tag)) out.set(tag, []);
      out.get(tag).push({ method: method.toUpperCase(), path, summary: o.summary, scope: o['x-scope'] || '', description: o.description || '' });
    }
  }
  return [...out.entries()].map(([tag, ops]) => ({ tag, ops }));
}

function register(app, { baseUrl, site, limit }) {
  app.get('/api/v1/openapi.json', limit('public-api', 120, 60 * 1000), (req, res) => res.set('Cache-Control', 'public, max-age=300').json(spec(baseUrl)));
  app.get('/developers', (req, res) => {
    const s = spec(baseUrl);
    res.render('developers', { title: `${site.name} API for developers`, page: 'developers', metaDescription: 'Connect your applicant tracking system or HR tools to Hireriv: jobs, applications and signed webhooks.', groups: groups(s), SCOPES, EVENTS, API_VERSION, apiBase: `${baseUrl}/api/v1` });
  });
}

module.exports = { register, spec };
