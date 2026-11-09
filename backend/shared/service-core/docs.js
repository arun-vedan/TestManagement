// WP-062 (ADR-007) -- shared OpenAPI docs building block.
//
// GOAL: "publish via a docs route" (ADR-007, WP-062 dispatch brief) without
// any new UI dependency (frontend untouched entirely -- this is server-
// rendered by the backend service itself) and without weakening any
// existing protected route. Mirrors WP-061's /healthz shape exactly:
//   - mounted BEFORE session/keycloak/applyStandardSecurity in each
//     service's server.js (same spot as /healthz and /metrics), so it
//     never depends on auth machinery, rate limiting, or CORS;
//   - reachable through Kong on a SEPARATE, deliberately unauthenticated
//     route (srckube-kong/kong.yml's `<name>Docs`/`<name>OpenApi` service
//     objects, no jwt plugin attached) pointed at the same host:port as the
//     service's real, still-fully-protected `/api/v1/...` routes -- those
//     main service/route objects are untouched, exactly as WP-061 did for
//     /healthz.
//
// TWO ROUTES PER SERVICE:
//   GET /openapi.yaml -- the raw, hand-authored spec (this service's own
//     backend/<service>/openapi.yaml), served as-is. Consumed by tooling
//     (contract tests, `swagger-cli`, Postman import, an editor) that wants
//     the machine-readable document, not a rendered page.
//   GET /docs -- a minimal, self-contained HTML viewer. The spec's YAML is
//     embedded INLINE in the server-rendered page (not fetched
//     client-side) deliberately: through Kong, this route is reached at
//     `/docs/<service>` (strip_path: true) while the raw spec is reached at
//     a DIFFERENT path, `/openapi/<service>.yaml` -- a client-side
//     relative fetch from the rendered page would resolve against the
//     wrong prefix depending on whether the page was reached directly
//     (service root, `/docs`) or through the gateway (`/docs/<service>`).
//     Inlining server-side sidesteps that path-resolution problem entirely
//     and needs no JavaScript, no CORS configuration, and no new runtime
//     dependency (Express + a template string).
//
// A service with no backend/<service>/openapi.yaml file yet gets a plain
// 404 from both routes (JSON envelope from /openapi.yaml, matching this
// codebase's shared error shape; a short HTML message from /docs) rather
// than a crash -- see WP-062's report for exactly which of the 18 services
// have a hand-authored spec today and which are explicitly not yet
// covered.
const fs = require('fs');

function readSpecFile(specPath) {
  try {
    return fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    return null;
  }
}

function createOpenApiHandler(specPath) {
  return function openApiYaml(req, res) {
    const yaml = readSpecFile(specPath);
    if (yaml === null) {
      return res.status(404).json({
        success: false,
        error: 'No OpenAPI spec has been published for this service yet'
      });
    }
    res.set('Content-Type', 'application/yaml; charset=utf-8');
    res.status(200).send(yaml);
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// otherServices: array of Kong host-style service names (e.g.
// 'testreposervice') this viewer links to, for cross-navigation between
// documented services. Those links are gateway paths (`/docs/<name>`) --
// they only resolve when this page itself is reached through Kong, which
// is the intended/documented way to browse the docs (see WP-062's report
// for why no separate cross-service index page was built: the budget was
// spent on spec correctness and contract-test depth instead, and this nav
// list already gives one-hop discoverability from any covered service).
function createDocsViewerHandler(serviceName, specPath, { otherServices = [] } = {}) {
  return function docsViewer(req, res) {
    const yaml = readSpecFile(specPath);
    if (yaml === null) {
      res
        .status(404)
        .type('html')
        .send(
          `<!doctype html><title>${escapeHtml(serviceName)} API docs</title>` +
            `<p>No OpenAPI spec has been published for ${escapeHtml(serviceName)} yet.</p>`
        );
      return;
    }

    const nav = otherServices.length
      ? `<nav><p>Other documented services (WP-062):</p><ul>${otherServices
          .map((s) => `<li><a href="/docs/${escapeHtml(s)}">${escapeHtml(s)}</a></li>`)
          .join('')}</ul></nav>`
      : '';

    res
      .status(200)
      .type('html')
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(serviceName)} API docs</title>
<style>
  body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.4rem; }
  p { line-height: 1.5; }
  pre { background: #f4f4f4; padding: 1rem; overflow: auto; border-radius: 6px; font-size: 13px; line-height: 1.5; }
  a { color: #0b5fff; }
  nav ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>${escapeHtml(serviceName)} &mdash; OpenAPI spec</h1>
<p>Hand-authored per ADR-007 (WP-062). Raw spec: <a href="/openapi.yaml">/openapi.yaml</a>.
This page and the raw spec are unauthenticated by design (same treatment WP-061 gave
<code>/healthz</code>) so they can be reached without a Keycloak bearer token; every
other route on this service, including <code>/api/v1/...</code>, is unchanged.</p>
${nav}
<pre>${escapeHtml(yaml)}</pre>
</body>
</html>`);
  };
}

module.exports = { createOpenApiHandler, createDocsViewerHandler };
