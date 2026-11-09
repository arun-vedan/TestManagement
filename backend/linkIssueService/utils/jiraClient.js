const { requestWithRetry, createLogger } = require('@srckube/service-core');

const logger = createLogger('linkIssueService:jira');

// WP-142 — talking to Jira Cloud, and telling the user what actually went
// wrong.
//
// AUTH. Jira Cloud takes HTTP Basic with `accountEmail:apiToken`. The token is
// NOT a password and NOT an OAuth bearer; an API token created at
// id.atlassian.com. A "classic" unscoped token is what Basic auth expects --
// Atlassian's newer scoped tokens use a different flow and will not work here.
//
// BASE URL NORMALISATION IS NOT COSMETIC. The owner supplied
// `https://ganesharun1988.atlassian.net/jira/`, copied from the browser. That
// is the WEB UI path; the REST API lives at the HOST root
// (`<host>/rest/api/3/...`). Left as given, every call would 404 against a URL
// that looks completely correct, and the error would read as "Jira is broken"
// rather than "that URL has a path on it". So the path is stripped here, once,
// rather than hoped for at each call site.
//
// THE VALIDATION LADDER, and why it is a ladder.
//
// WP-142's acceptance requires a wrong token, a wrong base URL, and an
// invisible project key to produce three DISTINCT actionable errors. Measured
// against the live API before designing this:
//
//   wrong token                 -> 401
//   project key not visible     -> 404
//   wrong base URL              -> 404      <-- the same as a bad key
//
// A mistyped site resolves, because Atlassian wildcards *.atlassian.net, so
// `ganesharun1988-xyz.atlassian.net` answers 404 rather than failing to
// connect. Switching on the status code alone would tell somebody who fat
// fingered their site name that their PROJECT KEY is wrong, and they would go
// and check the key.
//
// So the two are separated by WHICH call fails:
//   1. GET /myself   401 -> the token is wrong
//   2. GET /myself   404 -> the base URL is wrong (a real site with a bad
//                           token answers 401, never 404)
//   3. GET /project/{KEY} 404 -> that key is wrong, or invisible to this
//                           account -- which are indistinguishable from
//                           outside, and the message says so rather than
//                           guessing.

const API = '/rest/api/3';

// Strips the web-UI path and any trailing slash, leaving scheme + host.
function normalizeBaseUrl(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch (err) {
    return text.replace(/\/+$/, '');
  }
  // Only scheme and host survive. `https://x.atlassian.net/jira/software/...`
  // and `https://x.atlassian.net/` both become `https://x.atlassian.net`.
  return `${url.protocol}//${url.host}`;
}

function authHeader(accountEmail, apiToken) {
  const basic = Buffer.from(`${accountEmail}:${apiToken}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

async function call({ baseUrl, accountEmail, apiToken, path, method = 'get', params }) {
  const url = `${normalizeBaseUrl(baseUrl)}${API}${path}`;
  try {
    const response = await requestWithRetry({
      method,
      url,
      params,
      headers: {
        Authorization: authHeader(accountEmail, apiToken),
        Accept: 'application/json'
      },
      timeout: 15000,
      // A 401 or 404 from Jira is an answer, not a transient fault -- retrying
      // it wastes the user's time while they wait for a validation result.
      // requestWithRetry only retries 5xx and network errors by default.
      retryOn429: true
    });
    return { ok: true, status: response.status, data: response.data };
  } catch (err) {
    const status = err.response ? err.response.status : null;
    // The token must never reach a log. `url` is safe, the Authorization
    // header is not, so nothing from `err.config` is logged.
    logger.warn('jira call failed', { path, status, error: err.message });
    return { ok: false, status, data: err.response ? err.response.data : null, error: err.message };
  }
}

// Returns a structured verdict, never throws. Shape:
//   { valid, reason, message, account?, projects?, unreachableKeys? }
// `reason` is a machine-readable code so a caller can branch; `message` is the
// sentence a user reads.
async function validateConnection({ baseUrl, accountEmail, apiToken, projectKeys }) {
  const normalised = normalizeBaseUrl(baseUrl);

  if (!normalised) {
    return { valid: false, reason: 'base_url_missing', message: 'A Jira base URL is required, e.g. https://yourname.atlassian.net' };
  }
  if (!/^https?:\/\//.test(normalised)) {
    return { valid: false, reason: 'base_url_invalid', message: `'${baseUrl}' is not a valid URL.` };
  }
  if (!accountEmail) {
    return { valid: false, reason: 'account_email_missing', message: 'A Jira account email is required; it pairs with the API token for Basic auth.' };
  }
  if (!apiToken) {
    return { valid: false, reason: 'api_token_missing', message: 'A Jira API token is required. Create one at https://id.atlassian.com/manage-profile/security/api-tokens' };
  }

  // --- rung 1: does the token authenticate, and is the site real? --------
  const me = await call({ baseUrl: normalised, accountEmail, apiToken, path: '/myself' });

  if (!me.ok && me.status === 401) {
    return {
      valid: false,
      reason: 'token_invalid',
      message:
        `Jira rejected the credentials for ${accountEmail}. Check the API token is current and belongs to that ` +
        'account — tokens are shown once at creation and can be revoked at ' +
        'https://id.atlassian.com/manage-profile/security/api-tokens'
    };
  }
  if (!me.ok && me.status === 403) {
    return {
      valid: false,
      reason: 'account_forbidden',
      message: `${accountEmail} authenticated but is not permitted to use the Jira API on ${normalised}.`
    };
  }
  if (!me.ok && me.status === 404) {
    // The distinction the acceptance hinges on. A real site with a bad token
    // gives 401, so a 404 here is the site, not the credentials.
    return {
      valid: false,
      reason: 'base_url_wrong',
      message:
        `No Jira site answered at ${normalised}. Note that any *.atlassian.net address resolves, so a typo in ` +
        'the site name looks like a working URL. Use the host only, e.g. https://yourname.atlassian.net — ' +
        'not the /jira/... path from the browser.'
    };
  }
  if (!me.ok) {
    return {
      valid: false,
      reason: 'unreachable',
      message: `Could not reach Jira at ${normalised}${me.status ? ` (HTTP ${me.status})` : ''}: ${me.error}`
    };
  }

  const account = {
    accountId: me.data.accountId,
    displayName: me.data.displayName,
    // Jira hides this when the user's privacy settings say so; absence is not
    // an error, so it is reported as unknown rather than failing validation.
    emailAddress: me.data.emailAddress || null,
    timeZone: me.data.timeZone || null
  };

  // --- rung 2: can this account see each named project? ------------------
  const keys = Array.isArray(projectKeys) ? projectKeys.filter(Boolean) : [];
  if (keys.length === 0) {
    return {
      valid: false,
      reason: 'project_keys_missing',
      account,
      message:
        `Connected to ${normalised} as ${account.displayName}, but no project keys were given. ` +
        'A project key is the prefix in an issue key, e.g. SCRUM in SCRUM-123.'
    };
  }

  const found = [];
  const unreachable = [];
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    const project = await call({ baseUrl: normalised, accountEmail, apiToken, path: `/project/${encodeURIComponent(key)}` });
    if (project.ok) {
      found.push({ key: project.data.key, id: project.data.id, name: project.data.name, type: project.data.projectTypeKey });
    } else {
      unreachable.push(key);
    }
  }

  if (unreachable.length > 0) {
    return {
      valid: false,
      reason: 'project_keys_unreachable',
      account,
      projects: found,
      unreachableKeys: unreachable,
      message:
        `Connected to ${normalised} as ${account.displayName}, but ${unreachable.length === 1 ? 'project key' : 'project keys'} ` +
        `${unreachable.join(', ')} could not be read. Either the key does not exist or ${account.displayName} cannot ` +
        'browse it — Jira answers the same way for both, so check the key first, then the account\'s project access.'
    };
  }

  // Reports what it FOUND, not merely that it worked -- WP-142 asks for
  // validation that says what it saw rather than saving blind.
  return {
    valid: true,
    reason: 'ok',
    account,
    projects: found,
    message:
      `Connected to ${normalised} as ${account.displayName}. ` +
      `Visible ${found.length === 1 ? 'project' : 'projects'}: ${found.map((p) => `${p.key} (${p.name})`).join(', ')}.`
  };
}

// WP-143 — looking people up in Jira.
//
// Jira Cloud identifies people by `accountId`, never by email or username, and
// an `accountId` is specific to one Jira SITE. That is why the mapping this
// supports is per-project rather than global: two srckube projects may point at
// different Jira sites, where the same human has different accountIds.
//
// EMAIL IS NOT A RELIABLE JOIN KEY, and the code must not assume it is.
// `emailAddress` is omitted from these responses whenever the Atlassian
// account's privacy setting says so -- which is the DEFAULT on many sites. On
// the site this was built against it happens to be visible, so email matching
// works and is offered as a suggestion. Everything still functions when it is
// hidden: suggestions simply come back empty and a human picks from the
// candidate list instead. Nothing in the mapping path depends on email.

// Users who can be assigned work on a given Jira project. The right source for
// a picker: a site can contain accounts that exist but cannot hold an issue in
// this project, and offering those would produce a mapping that fails only at
// assignment time.
async function assignableUsers({ baseUrl, accountEmail, apiToken, projectKey, maxResults = 100 }) {
  const resp = await call({
    baseUrl,
    accountEmail,
    apiToken,
    path: '/user/assignable/search',
    params: { project: projectKey, maxResults }
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: resp.error, users: [] };
  }
  const users = Array.isArray(resp.data) ? resp.data : [];
  return {
    ok: true,
    users: users
      // Filter out app/bot accounts: they can technically hold issues but a
      // human mapping to one is almost always a mistake.
      .filter((u) => u.accountType !== 'app')
      .map((u) => ({
        accountId: u.accountId,
        displayName: u.displayName,
        emailAddress: u.emailAddress || null,
        active: u.active !== false
      }))
  };
}

// Confirms one accountId exists on this site, before a mapping is stored.
// Without it, a typo'd accountId saves cleanly and surfaces much later as an
// assignment that silently does nothing.
async function getUser({ baseUrl, accountEmail, apiToken, accountId }) {
  const resp = await call({
    baseUrl,
    accountEmail,
    apiToken,
    path: '/user',
    params: { accountId }
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: resp.error, user: null };
  }
  return {
    ok: true,
    user: {
      accountId: resp.data.accountId,
      displayName: resp.data.displayName,
      emailAddress: resp.data.emailAddress || null,
      active: resp.data.active !== false
    }
  };
}

// WP-144 — reading issues.
//
// FIELDS ARE REQUESTED EXPLICITLY rather than taking Jira's default payload.
// A default issue response is tens of kilobytes of fields nobody renders, and
// asking for four of them keeps the hydration of a page of links from becoming
// the slowest thing on the screen.
const ISSUE_FIELDS = 'summary,status,assignee,issuetype';

function toDisplayIssue(raw) {
  const f = raw.fields || {};
  const assignee = f.assignee || null;
  return {
    key: raw.key,
    summary: f.summary || null,
    status: (f.status && f.status.name) || null,
    // statusCategory is what colours a badge: Jira's own names are
    // project-configurable ("To Do" vs "Backlog" vs "Selected for
    // Development"), but the category is one of three fixed values, so a UI
    // can style it without knowing the customer's workflow.
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || null,
    issueType: (f.issuetype && f.issuetype.name) || null,
    assigneeAccountId: assignee ? assignee.accountId : null,
    assigneeDisplayName: assignee ? assignee.displayName : null
  };
}

// One issue by key. 404 means the key does not exist OR this account cannot
// see it -- indistinguishable from outside, exactly as for project keys in
// validateConnection(), and reported the same honest way.
async function getIssue({ baseUrl, accountEmail, apiToken, issueKey }) {
  const resp = await call({
    baseUrl,
    accountEmail,
    apiToken,
    path: `/issue/${encodeURIComponent(issueKey)}`,
    params: { fields: ISSUE_FIELDS }
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: resp.error, issue: null };
  }
  return { ok: true, issue: toDisplayIssue(resp.data) };
}

// Several issues in ONE call, for hydrating a page of links.
//
// Uses JQL `key in (...)` rather than N requests: a requirement with eight
// linked issues would otherwise cost eight round trips to Jira every time the
// page is opened, which is both slow and the fastest route to a rate limit.
// Jira's JQL search endpoint is the only way to batch this.
async function getIssues({ baseUrl, accountEmail, apiToken, issueKeys }) {
  const keys = [...new Set((issueKeys || []).filter(Boolean))];
  if (keys.length === 0) return { ok: true, issues: [], missingKeys: [] };

  const resp = await call({
    baseUrl,
    accountEmail,
    apiToken,
    path: '/search/jql',
    params: {
      jql: `key in (${keys.map((k) => `"${k}"`).join(',')})`,
      fields: ISSUE_FIELDS,
      maxResults: Math.max(keys.length, 50)
    }
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: resp.error, issues: [], missingKeys: keys };
  }
  const issues = (resp.data.issues || []).map(toDisplayIssue);
  const found = new Set(issues.map((i) => i.key));
  // Keys Jira did not return: deleted, moved, or no longer visible to this
  // account. Reported so a row can say so rather than rendering blank.
  return { ok: true, issues, missingKeys: keys.filter((k) => !found.has(k)) };
}

// Free-text search, so a user can find an issue instead of knowing its key.
// Scoped to the project's configured Jira project keys -- searching the whole
// site would offer issues the link could never usefully point at.
async function searchIssues({ baseUrl, accountEmail, apiToken, projectKeys, text, maxResults = 20 }) {
  const safe = String(text || '').replace(/["\\]/g, ' ').trim();
  if (!safe) return { ok: true, issues: [] };

  const scope = (projectKeys || []).length
    ? `project in (${projectKeys.map((k) => `"${k}"`).join(',')}) AND `
    : '';
  // `text ~` searches summary, description and comments. Quoted so a term
  // containing JQL punctuation cannot alter the query's structure.
  const resp = await call({
    baseUrl,
    accountEmail,
    apiToken,
    path: '/search/jql',
    params: { jql: `${scope}text ~ "${safe}" ORDER BY updated DESC`, fields: ISSUE_FIELDS, maxResults }
  });
  if (!resp.ok) return { ok: false, status: resp.status, error: resp.error, issues: [] };
  return { ok: true, issues: (resp.data.issues || []).map(toDisplayIssue) };
}

module.exports = {
  validateConnection,
  normalizeBaseUrl,
  call,
  assignableUsers,
  getUser,
  getIssue,
  getIssues,
  searchIssues,
  toDisplayIssue,
  API
};
