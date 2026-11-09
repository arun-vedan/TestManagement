// WP-F03c -- registry coverage for entityListConfigs.ts's buildBulkActions,
// proving the data-model asymmetry Tasks 1/2's backends actually support is
// carried through faithfully to the list UI: requirements get status+delete
// (no assign -- no assignedTo field), test plans get delete only (neither
// status nor assignedTo exists), and test runs get assign+delete (no
// lifecycle status). Calls buildBulkActions({canWrite, canDelete}) exactly
// as <EntityList> itself does (see EntityList.tsx's `const bulkActions =
// config.buildBulkActions({ canWrite, canDelete })`), rather than reading a
// plain `bulkActions` property -- these configs are permission-gated
// factories, not static arrays.

import { moduleListConfigs } from '../entityListConfigs';

// entityListConfigs.tsx pulls in api/entityGridApi.ts -> api/axios.tsx ->
// src/keycloak.js transitively (just to build the columns/fetchPage
// wiring this file doesn't exercise). keycloak-js ships ESM Jest can't
// parse under this project's CRA/Babel config (the same pre-existing
// failure affecting 35 other suites, per the WP-F03 brief) -- mocking it
// here (as EntityList.test.tsx does, in this same directory) short-
// circuits that import chain before axios.tsx ever requires the real
// package, without needing to mock axios.tsx or entityGridApi.ts
// themselves, since these tests never invoke a config's fetchPage or a
// bulk action's run().
jest.mock('../../../keycloak', () => ({ __esModule: true, default: { tokenParsed: { sub: 'user-abc' }, authenticated: true } }));

const ALL_PERMS = { canWrite: true, canDelete: true };

describe('entityListConfigs -- bulk action coverage per module', () => {
    it('test cases (module 1) offer assign, status and delete when the caller can write and delete', () => {
        const kinds = moduleListConfigs[1]!.buildBulkActions(ALL_PERMS).map((a) => a.kind);
        expect(kinds).toEqual(expect.arrayContaining(['assign', 'status', 'delete']));
    });

    it('defects (module 5) offer assign and delete, but no status -- no bulk status-change endpoint exists', () => {
        const actions = moduleListConfigs[5]!.buildBulkActions(ALL_PERMS);
        expect(actions.some((a) => a.kind === 'assign')).toBe(true);
        expect(actions.some((a) => a.kind === 'delete')).toBe(true);
        expect(actions.some((a) => a.kind === 'status')).toBe(false);
    });

    it('requirements offer status and delete, but no assign -- no assignedTo field exists', () => {
        const kinds = moduleListConfigs[2]!.buildBulkActions(ALL_PERMS).map((a) => a.kind);
        expect(kinds).toContain('delete');
        expect(moduleListConfigs[2]!.buildBulkActions(ALL_PERMS).some((a) => a.label.toLowerCase().includes('status'))).toBe(true);
        expect(moduleListConfigs[2]!.buildBulkActions(ALL_PERMS).some((a) => a.label.toLowerCase().includes('assign'))).toBe(false);
    });

    it('test plans offer delete only -- no status or assignedTo field exists', () => {
        const kinds = moduleListConfigs[3]!.buildBulkActions(ALL_PERMS).map((a) => a.kind);
        expect(kinds).toEqual(['delete']);
    });

    it('test runs offer assign and delete, but no status -- no lifecycle status exists', () => {
        const actions = moduleListConfigs[4]!.buildBulkActions(ALL_PERMS);
        expect(actions.some((a) => a.label.toLowerCase().includes('assign'))).toBe(true);
        expect(actions.map((a) => a.kind)).toContain('delete');
        expect(actions.some((a) => a.label.toLowerCase().includes('status'))).toBe(false);
    });

    it('releases (module 6) have a real list config now, but still offer no bulk actions -- no bulk endpoint exists for releases', () => {
        expect(moduleListConfigs[6]).toBeDefined();
        expect(moduleListConfigs[6]!.buildBulkActions(ALL_PERMS)).toEqual([]);
    });

    it('requirements: write-only caller gets status but not delete', () => {
        const kinds = moduleListConfigs[2]!.buildBulkActions({ canWrite: true, canDelete: false }).map((a) => a.kind);
        expect(kinds).toEqual(['status']);
    });

    it('requirements: delete-only caller gets delete but not status', () => {
        const kinds = moduleListConfigs[2]!.buildBulkActions({ canWrite: false, canDelete: true }).map((a) => a.kind);
        expect(kinds).toEqual(['delete']);
    });

    it('test plans: a caller with neither permission gets no actions at all', () => {
        const kinds = moduleListConfigs[3]!.buildBulkActions({ canWrite: false, canDelete: false }).map((a) => a.kind);
        expect(kinds).toEqual([]);
    });

    it('test runs: write-only caller gets assign but not delete', () => {
        const kinds = moduleListConfigs[4]!.buildBulkActions({ canWrite: true, canDelete: false }).map((a) => a.kind);
        expect(kinds).toEqual(['assign']);
    });
});

// WP-F15/F18 Task 1 -- module 6 (releases) gets a real list config for the
// first time. Column shape only, no rendering: EntityList.test.tsx's own
// "module 6 (releases)" describe block covers a release row actually
// rendering its status and target date through <EntityList>.
describe('entityListConfigs -- module 6 (releases) column shape', () => {
    it('has a real config, not the placeholder undefined the module used to carry', () => {
        expect(moduleListConfigs[6]).toBeDefined();
    });

    it('carries exactly the columns the brief asks for: release id, name, status, target date, linked test plan count', () => {
        const fields = moduleListConfigs[6]!.columns.map((c) => c.field);
        expect(fields).toEqual(['releaseId', 'name', 'status', 'targetDate', 'linkedTestPlanCount']);
    });

    it('has no tags column -- the Release model carries no tags field to render one honestly', () => {
        const fields = moduleListConfigs[6]!.columns.map((c) => c.field);
        expect(fields).not.toContain('tags');
    });
});
