const { buildReleaseFacts, buildPlanFacts, buildTimerangeFacts, clampDays, SUPPORTED_SCOPES } = require('../lib/reportAggregates');
const { extractNumbers } = require('../lib/groundingCheck');

// WP-053 -- unit tests for the PURE facts-building half of
// lib/reportAggregates.js (buildReleaseFacts/buildPlanFacts/
// buildTimerangeFacts): given already-fetched WP-040 report envelopes
// (exactly {success, projectId, reportType, computedAt, stale,
// staleReason?, data} -- the literal shape controllers/reports.js's
// getOrCompute returns), assert the facts text and the staleness
// propagation are both correct. Deliberately NOT exercising
// fetchReportAggregates()'s own HTTP calls here (that needs a live
// reportingService, covered by __tests__/summarizeReport.test.js's
// black-box suite instead) -- this is the fast, network-free half.

function envelope(reportType, data, opts = {}) {
  return {
    success: true,
    projectId: 1,
    reportType,
    computedAt: opts.computedAt || '2026-08-28T10:00:00.000Z',
    stale: !!opts.stale,
    staleReason: opts.staleReason,
    data
  };
}

describe('reportAggregates.buildReleaseFacts', () => {
  const coverage = envelope('coverage', { value: 0, total: 5, tested: 0, untested: 5 });
  const defectSummary = envelope('defect-summary', { total: 3, bySeverity: { data: [{ id: 'Major', label: 'Major', value: 2 }, { id: 'Minor', label: 'Minor', value: 1 }] } });
  const releaseReadiness = envelope('release-readiness', {
    total: 2,
    rollup: { data: [{ id: 'green', label: 'Green', value: 1 }, { id: 'red', label: 'Red', value: 1 }] },
    releases: [
      { releaseId: 'REL-1', status: 'in-progress', overall: 'red', passed: false, ruleCount: 3 },
      { releaseId: 'REL-2', status: 'released', overall: 'green', passed: true, ruleCount: 2 }
    ]
  });

  it('produces facts containing every real figure, project-wide when no releaseId is given', () => {
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness });
    expect(result.facts).toMatch(/0% requirement coverage/);
    expect(result.facts).toMatch(/3 total defects/);
    expect(result.facts).toMatch(/REL-1/);
    expect(result.facts).toMatch(/REL-2/);
    expect(result.releaseId).toBeUndefined();
  });

  it('narrows to one release when releaseId is given, and still includes project-wide rollup context', () => {
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness, releaseId: 'REL-1' });
    expect(result.facts).toMatch(/RELEASE REL-1.*status=in-progress.*overall=red/);
    expect(result.facts).toMatch(/2 release\(s\) tracked project-wide/);
    expect(result.releaseId).toBe('REL-1');
  });

  it('throws a 404-shaped error for an unknown releaseId', () => {
    expect(() => buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness, releaseId: 'REL-999' })).toThrow(
      /No release 'REL-999' found/
    );
    try {
      buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness, releaseId: 'REL-999' });
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });

  it('propagates staleness from ANY one source report -- a narrative built on stale numbers must say so', () => {
    const staleCoverage = envelope('coverage', coverage.data, { stale: true, staleReason: 'linkIssueService unreachable', computedAt: '2026-08-27T09:00:00.000Z' });
    const result = buildReleaseFacts({ projectId: 1, coverage: staleCoverage, defectSummary, releaseReadiness });
    expect(result.stale).toBe(true);
    expect(result.staleReports).toEqual(['coverage']);
    expect(result.facts).toMatch(/STALE -- last refreshed 2026-08-27T09:00:00\.000Z \(linkIssueService unreachable\)/);
  });

  it('reports fresh (stale:false) when every source report is fresh', () => {
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness });
    expect(result.stale).toBe(false);
    expect(result.staleReports).toEqual([]);
  });

  it('carries per-report provenance (reportType/computedAt/stale) for every source used', () => {
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness });
    expect(result.sourceReports).toEqual([
      { reportType: 'coverage', computedAt: '2026-08-28T10:00:00.000Z', stale: false },
      { reportType: 'defect-summary', computedAt: '2026-08-28T10:00:00.000Z', stale: false },
      { reportType: 'release-readiness', computedAt: '2026-08-28T10:00:00.000Z', stale: false }
    ]);
  });

  it('every number in the produced facts text is a real, extractable figure (self-consistency: the facts ARE the grounding corpus)', () => {
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary, releaseReadiness, releaseId: 'REL-1' });
    const nums = extractNumbers(result.facts);
    expect(nums.length).toBeGreaterThan(0);
  });

  it('handles zero defects/releases without crashing and without a bogus "none" figure', () => {
    const emptyDefects = envelope('defect-summary', { total: 0, bySeverity: { data: [] } });
    const emptyReadiness = envelope('release-readiness', { total: 0, rollup: { data: [] }, releases: [] });
    const result = buildReleaseFacts({ projectId: 1, coverage, defectSummary: emptyDefects, releaseReadiness: emptyReadiness });
    expect(result.facts).toMatch(/0 total defects/);
    expect(result.facts).toMatch(/By severity -- none/);
    expect(result.facts).toMatch(/0 release\(s\) tracked/);
  });
});

describe('reportAggregates.buildPlanFacts', () => {
  const planProgress = envelope('plan-progress', {
    categories: ['PLN-1', 'PLN-2'],
    series: [
      { id: 'executed', label: 'Executed', data: [10, 4] },
      { id: 'passed', label: 'Passed', data: [8, 2] },
      { id: 'blocked', label: 'Blocked', data: [1, 0] }
    ]
  });

  it('lists every plan project-wide when no planId is given', () => {
    const result = buildPlanFacts({ projectId: 1, planProgress });
    expect(result.facts).toMatch(/PLN-1.*executed=10, passed=8, blocked=1/);
    expect(result.facts).toMatch(/PLN-2.*executed=4, passed=2, blocked=0/);
  });

  it('narrows to one plan when planId is given', () => {
    const result = buildPlanFacts({ projectId: 1, planProgress, planId: 'PLN-2' });
    expect(result.facts).toMatch(/PLAN PLN-2.*executed=4, passed=2, blocked=0/);
    expect(result.facts).not.toMatch(/PLN-1/);
    expect(result.planId).toBe('PLN-2');
  });

  it('throws a 404-shaped error for an unknown planId', () => {
    expect(() => buildPlanFacts({ projectId: 1, planProgress, planId: 'PLN-999' })).toThrow(/No plan 'PLN-999' found/);
  });

  it('passes through a non-numeric scoping-gap note verbatim (safe -- carries no figure of its own)', () => {
    const noted = envelope('plan-progress', { categories: [], series: [], note: 'testPlanExecutionService has no per-project scoping yet.' });
    const result = buildPlanFacts({ projectId: 2, planProgress: noted });
    expect(result.facts).toMatch(/NOTE: testPlanExecutionService has no per-project scoping yet\./);
  });
});

describe('reportAggregates.buildTimerangeFacts', () => {
  const passRateTrend = envelope('pass-rate-trend', {
    xLabels: ['2026-08-26', '2026-08-27', '2026-08-28'],
    series: [{ id: 'passRate', label: 'Pass rate (%)', data: [100, null, 50] }]
  });
  const defectSummary = envelope('defect-summary', { total: 3, bySeverity: { data: [] } });
  const coverage = envelope('coverage', { value: 0, total: 5, tested: 0 });

  it('lists dated pass-rate points and skips null (no-execution) days rather than reporting a fake 0', () => {
    const result = buildTimerangeFacts({ projectId: 1, passRateTrend, defectSummary, coverage, days: 30 });
    expect(result.facts).toMatch(/2026-08-26=100%/);
    expect(result.facts).toMatch(/2026-08-28=50%/);
    expect(result.facts).not.toMatch(/2026-08-27=/);
    expect(result.days).toBe(30);
  });

  it('every date+value point in the facts is independently extractable (dates as exact tokens, values as percents)', () => {
    const result = buildTimerangeFacts({ projectId: 1, passRateTrend, defectSummary, coverage, days: 7 });
    const nums = extractNumbers(result.facts);
    expect(nums.some((n) => n.kind === 'date' && n.raw === '2026-08-26')).toBe(true);
    expect(nums.some((n) => n.kind === 'percent' && n.raw === '100%')).toBe(true);
  });
});

describe('reportAggregates.clampDays', () => {
  it('defaults to 30 for missing/invalid input', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays('not-a-number')).toBe(30);
  });
  it('clamps to the 1-90 range (same convention as reportingService/services/passRateTrend.js: a non-positive input falls back to the default rather than clamping to 1)', () => {
    expect(clampDays(0)).toBe(30);
    expect(clampDays(-5)).toBe(30);
    expect(clampDays(500)).toBe(90);
    expect(clampDays(45)).toBe(45);
  });
});

describe('reportAggregates.SUPPORTED_SCOPES', () => {
  it('is exactly release/plan/timerange', () => {
    expect(SUPPORTED_SCOPES.sort()).toEqual(['plan', 'release', 'timerange']);
  });
});
