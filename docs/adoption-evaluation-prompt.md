# Adoption Evaluation Prompt — srckubetest

Paste everything below into a fresh session with this repo as the working directory.

---

You are evaluating **srckubetest**, a self-hosted test management platform, for adoption.
You will do this twice, wearing two different hats, then reconcile them.

The codebase is in front of you. **Everything you claim must be grounded in what is
actually in this repo** — read the code, the routes, the models, the React pages, the
tests, the Kong config, the docker-compose files. Cite `file:line` for every material
claim. If you cannot find evidence for a feature, say "not found" rather than assuming
it exists because a mature product would have it. Absence of a feature is the single
most valuable thing you can report, so hunt for absences deliberately.

Do not be polite. I am not the vendor's friend; I am deciding whether to bet a team on
this. Flattery costs me money.

## Orientation (do this first)

Build your own map before judging anything:

- The backend is ~19 Node/Express microservices in `backend/`, each with its own Mongo
  models, fronted by Kong at `/api/v1/<resource>`. Auth is Keycloak.
- The frontend is a React 18 + TS SPA in `frontend/src`, project-scoped under
  `/projects/:projectId/...`.
- Core domain: modules, folders, requirements (versioned), test cases (versioned,
  templates, shared steps, datasets), test plans, test executions, defects, releases &
  environments, links between items, custom/dynamic fields, comments, attachments,
  automation scripts + object repository, notifications, reporting, an AI service, audit.

Read enough to know what is real, what is a stub, and what is half-built. Note the
maturity difference between services — some are clearly further along than others.

## Hat 1 — Enterprise Test Manager

You run QA for a 200-person engineering org: ~40 testers across 6 squads, a mix of
manual and automated testing, regulated-ish customers who ask about audit trails, and
an incumbent tool (TestRail / Xray / qTest / Zephyr) you are considering replacing.

Judge it on what actually breaks enterprise rollouts:

1. **Traceability** — can you prove requirement → test case → execution → defect →
   release, in both directions, and get that as a report an auditor accepts? Check
   `reportingService` and the link model. Where does the chain break?
2. **Scale and structure** — 20k test cases, 300 concurrent testers. Look for
   pagination, indexes, N+1 query patterns, bulk operations, the folder tree's
   behaviour at depth. Does anything load the whole collection into memory?
3. **RBAC and multi-tenancy** — what roles exist, what do they actually gate, and is
   the check enforced server-side on every route or only hidden in the UI? Try to find
   a route that trusts the client. Can a project member read another project's data?
4. **Versioning and history** — requirements and test cases have version models. Is
   the history complete enough to answer "what did this test look like when it was run
   in March?"
5. **Test execution at scale** — assigning runs, parallel execution, partial results,
   re-runs, flaky handling, evidence/attachments on a step.
6. **Reporting** — what dashboards exist, what is cached, can a manager get the three
   reports they will be asked for weekly (pass rate trend, coverage, release readiness)
   without exporting to Excel?
7. **Audit and compliance** — what does the audit log actually capture, and what does
   it miss?
8. **Migration and lock-in** — import/export paths, API completeness, whether you could
   get your data out. Look at `Components/Import` and `Components/Export`.
9. **Integrations** — this is the one I most suspect. Jira, Azure DevOps, Slack, CI
   (Jenkins/GitHub Actions/GitLab), webhooks. Search hard, then tell me the truth about
   what connects to the outside world.

## Hat 2 — Startup CTO

You run engineering at a 25-person Series A company. You would self-host this or pay
for it. Your concerns are almost the opposite:

1. **Time to first value** — follow the README setup. Could an engineer have this
   running and a first test case executed in an afternoon, or is it a two-week project?
   Count the moving parts they must operate: Keycloak, Postgres, Mongo, Redis, Kong,
   19 services. Be blunt about whether that is justified at your size.
2. **Operational cost and burden** — who babysits this? What does it cost to run?
   What happens at 3am when one service is down — is there health checking, are
   failures isolated or does the UI white-screen?
3. **Does it beat the alternative** — which for you is Linear/GitHub Issues + a
   spreadsheet, or Qase/Testiny at $20/user/month. What does this give you that those
   don't, and is that worth the ops burden?
4. **Developer experience** — API quality, API keys, whether your CI can push results
   in without a human. Can you automate your way out of manual test management?
5. **The AI service** — what does it actually do (`backend/aiService`)? Is it a real
   differentiator or a wrapper? What does it cost per seat to run?
6. **Speed of iteration** — read the code as a hiring manager would. If you adopted
   this and needed a change, how fast could your team ship it? Judge test coverage,
   code consistency, and how much of the codebase is comments explaining prior
   confusion versus clean design.
7. **Risk** — single-vendor, small project, self-hosted. What is your exit if it is
   abandoned?

## Output

Produce, in this order:

1. **What this product actually is** — three sentences, no marketing language. The
   honest one-liner you would use to describe it to a peer.
2. **Enterprise Test Manager verdict** — adopt / pilot / pass, with the top 5 blockers
   ranked by how likely each is to kill the rollout, each with file evidence and a
   rough sense of how hard it is to fix.
3. **Startup CTO verdict** — same format, same rigour.
4. **Where the two hats disagree** — the most useful section. Name the choices in this
   product that serve one buyer at the direct expense of the other (architecture,
   auth model, operational footprint, feature depth). Then say which buyer this
   product is currently built for, whether or not that was intentional.
5. **The five things I would fix first** — ordered by (impact on adoption ÷ effort),
   each one concrete enough to become a ticket.
6. **The question I should be asking that I haven't** — one thing, the thing you noticed
   while reading that neither persona's checklist would have caught.

Score nothing out of 10. Give me judgements, not numbers.
