const fs = require('fs');
const yaml = require('js-yaml');

// WP-062 (ADR-007) — a small, dependency-light contract-test helper.
//
// WHY NOT A FULL JSON-SCHEMA VALIDATOR (ajv or similar): this is intended
// to validate a handful of hand-authored specs against real HTTP
// responses inside existing Jest suites, not to be a general-purpose
// OpenAPI toolchain. js-yaml is already used elsewhere in this repo
// (multiple services' node_modules resolve it transitively) and is
// pinned here EXACTLY (3.15.1, matching the version already resolved
// throughout the tree, so this doesn't introduce a second, different
// js-yaml into node_modules) — see package.json. The schema matcher below
// supports exactly the subset of JSON Schema this codebase's specs
// actually use (type, properties/required, items, enum, nullable,
// oneOf, $ref) — enough to catch the class of drift this WP cares about
// (a field renamed/removed/retyped, an envelope shape that changed),
// without pulling in and trusting a third-party validator's own
// correctness for a one-WP-sized job.
//
// USAGE (from a service's __tests__/*.test.js):
//   const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
//   const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
//   assertResponseMatches(spec, '/api/v1/testrepo', 'get', 200, resp.data);

const specCache = new Map();

function loadSpec(specPath) {
  if (specCache.has(specPath)) {
    return specCache.get(specPath);
  }
  const raw = fs.readFileSync(specPath, 'utf8');
  const parsed = yaml.safeLoad(raw); // js-yaml 3.x API (matches the pinned 3.15.1)
  specCache.set(specPath, parsed);
  return parsed;
}

// Test-only escape hatch, same pattern as this codebase's other
// _reset*ForTests helpers (events.js, health.js, projectScope.js) — lets a
// test reload a spec file it just mutated on disk (used by this WP's own
// "prove a contract test fails on drift" demonstration) without needing a
// fresh Node process.
function _clearSpecCacheForTests() {
  specCache.clear();
}

function resolveRef(spec, ref) {
  // Only local '#/components/schemas/Foo'-style refs are needed by these
  // specs — no external-file or remote $ref support.
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref (not a local pointer): ${ref}`);
  }
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const part of parts) {
    if (node === undefined || node === null) {
      throw new Error(`$ref ${ref} does not resolve — stopped at '${part}'`);
    }
    node = node[part];
  }
  if (node === undefined) {
    throw new Error(`$ref ${ref} does not resolve to anything`);
  }
  return node;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'object' | 'string' | 'number' | 'boolean' | 'undefined'
}

function schemaTypeMatches(schemaType, value) {
  const actual = typeOf(value);
  if (schemaType === 'integer') {
    return actual === 'number' && Number.isInteger(value);
  }
  if (schemaType === 'number') {
    return actual === 'number';
  }
  return actual === schemaType;
}

// Walks `value` against `schema`, throwing a descriptive Error on the
// FIRST mismatch found (path included) rather than collecting every
// mismatch — enough for a failing Jest assertion to say exactly what
// drifted.
function validateAgainstSchema(spec, schema, value, path) {
  if (schema.$ref) {
    return validateAgainstSchema(spec, resolveRef(spec, schema.$ref), value, path);
  }

  if (schema.nullable && value === null) {
    return;
  }

  if (schema.oneOf) {
    const errors = [];
    for (const sub of schema.oneOf) {
      try {
        validateAgainstSchema(spec, sub, value, path);
        return; // first match wins
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new Error(`${path}: value matched none of oneOf's ${schema.oneOf.length} alternative(s):\n  - ${errors.join('\n  - ')}`);
  }

  if (schema.allOf) {
    schema.allOf.forEach((sub) => validateAgainstSchema(spec, sub, value, path));
    return;
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      throw new Error(`${path}: expected one of enum [${schema.enum.join(', ')}], got ${JSON.stringify(value)}`);
    }
    return; // enum is a complete constraint by itself in this matcher
  }

  if (schema.type) {
    if (!schemaTypeMatches(schema.type, value)) {
      throw new Error(`${path}: expected type '${schema.type}', got '${typeOf(value)}' (value: ${JSON.stringify(value)})`);
    }

    if (schema.type === 'object') {
      const props = schema.properties || {};
      const required = schema.required || [];
      for (const key of required) {
        if (!(key in value)) {
          throw new Error(`${path}: missing required property '${key}'`);
        }
      }
      for (const [key, subSchema] of Object.entries(props)) {
        if (value[key] !== undefined) {
          validateAgainstSchema(spec, subSchema, value[key], `${path}.${key}`);
        }
      }
    }

    if (schema.type === 'array' && schema.items) {
      value.forEach((item, i) => validateAgainstSchema(spec, schema.items, item, `${path}[${i}]`));
    }
  }
}

function getOperation(spec, pathTemplate, method) {
  const pathItem = spec.paths && spec.paths[pathTemplate];
  if (!pathItem) {
    throw new Error(`Spec has no path '${pathTemplate}'. Known paths: ${Object.keys(spec.paths || {}).join(', ')}`);
  }
  const op = pathItem[method.toLowerCase()];
  if (!op) {
    throw new Error(`Spec path '${pathTemplate}' has no '${method}' operation. Known methods: ${Object.keys(pathItem).filter((k) => k !== 'parameters').join(', ')}`);
  }
  return op;
}

function getResponseSchema(spec, pathTemplate, method, status) {
  const op = getOperation(spec, pathTemplate, method);
  const responses = op.responses || {};
  const responseDef = responses[String(status)];
  if (!responseDef) {
    throw new Error(
      `Spec path '${method.toUpperCase()} ${pathTemplate}' has no response documented for status ${status}. Documented: ${Object.keys(responses).join(', ')}`
    );
  }
  let resolved = responseDef;
  if (resolved.$ref) {
    resolved = resolveRef(spec, resolved.$ref);
  }
  const schema = resolved.content && resolved.content['application/json'] && resolved.content['application/json'].schema;
  if (!schema) {
    throw new Error(`Spec path '${method.toUpperCase()} ${pathTemplate}' status ${status} has no application/json schema documented`);
  }
  return schema;
}

// The main entry point: asserts `body` (a parsed JSON response body)
// matches the schema the spec documents for `method pathTemplate` at
// `status`. Throws (fails the Jest test) with a descriptive message on
// the first mismatch.
function assertResponseMatches(spec, pathTemplate, method, status, body) {
  const schema = getResponseSchema(spec, pathTemplate, method, status);
  validateAgainstSchema(spec, schema, body, '$');
}

module.exports = {
  loadSpec,
  assertResponseMatches,
  validateAgainstSchema,
  getResponseSchema,
  _clearSpecCacheForTests
};
