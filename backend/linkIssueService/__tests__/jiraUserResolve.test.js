// WP-143 — the resolvers, unit-level.
//
// These are the functions WP-144 and WP-145 call, and they carry the
// acceptance's most important clause: "an unmapped user degrades to unassigned
// with a visible warning, NEVER an error."
//
// That is worth pinning here rather than only through an HTTP route, because
// the failure it prevents is subtle: if an unmapped assignee threw, a single
// unmapped person would fail a whole defect-to-Jira operation, and on a team
// of ten the feature would be unusable until all ten were mapped. The
// difference between "returns null with a warning" and "throws" is the
// difference between a usable integration and one nobody can adopt
// incrementally.

jest.mock('../models/JiraUserMapping', () => ({ findOne: jest.fn() }));
// jiraConnection pulls in service-core's credential helpers at require time;
// the resolvers do not use it, so it is stubbed to keep this a unit test.
jest.mock('../controllers/jiraConnection', () => ({ loadCredentials: jest.fn() }));

const JiraUserMapping = require('../models/JiraUserMapping');
const { resolveJiraAccount, resolveLocalUser } = require('../controllers/jiraUsers');

beforeEach(() => jest.clearAllMocks());

describe('WP-143: resolveJiraAccount (Keycloak sub -> Jira accountId)', () => {
    it('resolves a mapped user to the right Jira account', async () => {
        JiraUserMapping.findOne.mockResolvedValue({
            keycloakSub: 'sub-1',
            jiraAccountId: '5e4ccfffc8ec310c955ba013',
            jiraDisplayName: 'Arun Ganesh'
        });
        const r = await resolveJiraAccount(42, 'sub-1');
        expect(r).toEqual({
            accountId: '5e4ccfffc8ec310c955ba013',
            mapped: true,
            displayName: 'Arun Ganesh',
            warning: null
        });
    });

    it('scopes the lookup to the project, because an accountId is per Jira SITE', async () => {
        // Two projects may point at different Jira sites where the same human
        // has different accountIds. A global lookup would resolve one
        // project's assignee to another site's account.
        JiraUserMapping.findOne.mockResolvedValue(null);
        await resolveJiraAccount(42, 'sub-1');
        expect(JiraUserMapping.findOne).toHaveBeenCalledWith({ projectId: 42, keycloakSub: 'sub-1' });
    });

    it('DEGRADES for an unmapped user: null, a warning, and no throw', async () => {
        JiraUserMapping.findOne.mockResolvedValue(null);
        const r = await resolveJiraAccount(42, 'nobody-mapped-this-one');
        expect(r.accountId).toBeNull();
        expect(r.mapped).toBe(false);
        // The warning has to be surfaceable, so it says what happened AND who
        // can fix it -- "unassigned" alone would leave a user stuck.
        expect(r.warning).toMatch(/no Jira account mapped/i);
        expect(r.warning).toMatch(/left unassigned/i);
        expect(r.warning).toMatch(/project admin/i);
    });

    it('degrades the same way for a missing assignee rather than treating it as an error', async () => {
        for (const value of [undefined, null, '']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await resolveJiraAccount(42, value);
            expect(r.accountId).toBeNull();
            expect(r.mapped).toBe(false);
            expect(r.warning).toBeTruthy();
        }
        // An absent assignee needs no database round trip.
        expect(JiraUserMapping.findOne).not.toHaveBeenCalled();
    });

    it('never rejects, so one unmapped person cannot fail a whole operation', async () => {
        JiraUserMapping.findOne.mockResolvedValue(null);
        await expect(resolveJiraAccount(42, 'x')).resolves.toBeDefined();
    });
});

describe('WP-143: resolveLocalUser (Jira accountId -> Keycloak sub)', () => {
    it('resolves a mapped Jira account back to the local person', async () => {
        JiraUserMapping.findOne.mockResolvedValue({ keycloakSub: 'sub-9', jiraAccountId: 'acc-9' });
        const r = await resolveLocalUser(42, 'acc-9');
        expect(r).toEqual({ keycloakSub: 'sub-9', mapped: true });
        expect(JiraUserMapping.findOne).toHaveBeenCalledWith({ projectId: 42, jiraAccountId: 'acc-9' });
    });

    it('reports unmapped rather than guessing', async () => {
        // WP-144 renders a linked issue's Jira assignee. Guessing here would
        // show the wrong colleague's name against a Jira issue, which is worse
        // than showing none -- and the (projectId, jiraAccountId) unique index
        // is what makes this answer unambiguous in the first place.
        JiraUserMapping.findOne.mockResolvedValue(null);
        expect(await resolveLocalUser(42, 'acc-unknown')).toEqual({ keycloakSub: null, mapped: false });
    });

    it('handles an issue with no Jira assignee at all', async () => {
        expect(await resolveLocalUser(42, null)).toEqual({ keycloakSub: null, mapped: false });
        expect(JiraUserMapping.findOne).not.toHaveBeenCalled();
    });
});
