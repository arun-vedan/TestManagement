import { buildEntityPrefill } from '../entityPrefill';

// WP-F08 Task 2 -- buildEntityPrefill is the per-module "flatten a record
// into a prefill" logic extracted out of useCloneEntity.ts's own
// buildClonePlan, now shared with SaveAsTemplateDialog so a template's
// capture and a clone's prefill can never diverge on what a module's
// prefill shape is. These tests prove that shape directly, independent
// of either caller.
describe('buildEntityPrefill', () => {
  it('module 1 (test cases): flattens dynamicFields onto the top level and preserves every other field, including datasetId', () => {
    const row = {
      _id: 'abc123',
      TestCaseId: 'TC-1',
      TestCaseSummary: 'Login should work',
      TestSteps: [{ testStep: 'Log in as {{role}}', Expected: 'Dashboard for {{role}}' }],
      // WP-F07a Task 4's binding -- a top-level field, not a dynamic one,
      // but this is the EXACT field useCloneEntity silently dropped once
      // (see that file's own header comment) before the fix that this
      // repo's regression test (TestCaseDetail.parameterised.test.tsx)
      // guards on the consuming side. Asserted here on the CAPTURE side.
      datasetId: 'ds1',
      dynamicFields: { Priority: 'High' },
    };

    const result = buildEntityPrefill(1, row);

    // The single-line break this catches: removing
    // `...(row.dynamicFields ?? {})` from entityPrefill.ts's `flatten`
    // makes this fail (Priority would be missing from the top level).
    expect(result.prefill.Priority).toBe('High');
    // The single-line break this catches: dropping `...row` (or
    // explicitly deleting `datasetId`, the way case 5 deletes
    // `attachment`) from the module-1 branch makes this fail.
    expect(result.prefill.datasetId).toBe('ds1');
    expect(result.prefill.TestSteps).toEqual(row.TestSteps);
    expect(result.summaryField).toBe('TestCaseSummary');
    expect(result.summaryLabel).toBe('Login should work');
  });

  it('module 2 (requirements): flattens dynamicFields and reports requirementSummary as the summary field', () => {
    const row = {
      reqId: 'Req-1',
      requirementSummary: 'Users can reset their password',
      dynamicFields: { priority: 'Low' },
    };

    const result = buildEntityPrefill(2, row);

    expect(result.prefill.priority).toBe('Low');
    expect(result.summaryField).toBe('requirementSummary');
    expect(result.summaryLabel).toBe('Users can reset their password');
  });

  it('module 3 (test plans): captures only the source plan\'s TestCaseIds, with no summary field', () => {
    const row = {
      TestPlanId: 'PLN-1',
      objective: 'Smoke test the release',
      TestCases: [
        { TestCaseId: 'TC-1', TestCaseSummary: 'Login', id: 1 },
        { TestCaseId: 'TC-2', TestCaseSummary: 'Logout', id: 2 },
      ],
    };

    const result = buildEntityPrefill(3, row);

    // The single-line break this catches: mapping the wrong field (e.g.
    // `tc.id` instead of `tc.TestCaseId`) makes this fail.
    expect(result.prefill).toEqual({ TestCaseIds: ['TC-1', 'TC-2'] });
    expect(result.summaryField).toBeUndefined();
  });

  it('module 3: an empty/absent TestCases array produces an empty TestCaseIds list, not a crash', () => {
    const result = buildEntityPrefill(3, { TestPlanId: 'PLN-2' });
    expect(result.prefill).toEqual({ TestCaseIds: [] });
  });

  it('module 5 (defects): flattens dynamicFields and strips the attachment field', () => {
    const row = {
      defectId: 'DEF-1',
      summary: 'Login button does nothing',
      attachment: [{ attachmentId: 'att-1', name: 'screenshot.png' }],
      dynamicFields: { Priority: 'High' },
    };

    const result = buildEntityPrefill(5, row);

    // The single-line break this catches: removing the
    // `delete prefill.attachment` line makes this fail -- a template
    // would then silently imply an attached file came along too.
    expect(result.prefill.attachment).toBeUndefined();
    expect(result.prefill.Priority).toBe('High');
    expect(result.summaryField).toBe('summary');
    expect(result.summaryLabel).toBe('Login button does nothing');
  });

  it('throws for a module with no create flow to build a prefill for (4, 6)', () => {
    expect(() => buildEntityPrefill(4, {})).toThrow(/module 4/);
    expect(() => buildEntityPrefill(6, {})).toThrow(/module 6/);
  });
});
