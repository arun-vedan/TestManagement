
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Page404 from './Pages/Page404';
import Dashboard from './Pages/dashboard';
import Profile from './Pages/profile';
import { useState } from "react";
import { WSContext } from "./Context/workSpaceContext";
import { WSObject } from "./model/workSpaceContext";
import { PContext } from './Context/ProjectContext';
import { PObject } from './model/ProjectContext';
import { TemplateContext } from './Context/TemplateContext';
import { TemplateObject } from './model/TemplateModel'
import React from 'react';
import { DndProvider } from "react-dnd";
// WP-078 -- @minoru/react-dnd-treeview's MultiBackend was this
// <DndProvider>'s backend only because it drove the now-deleted
// folderList/multiTree trees; the workbench's own tree
// (workbench/tree/EntityTree.tsx / EntityTreeNode.tsx) has always used
// plain react-dnd's useDrag/useDrop, backend-agnostic, and every one of its
// tests already wraps with HTML5Backend (see e.g.
// workbench/tree/__tests__/EntityTree.dnd.dom.test.tsx). @minoru/react-dnd-
// treeview itself is NOT removed as a dependency: Components/folderStructure/
// (frozen pre-existing dead code -- see this WP's report) and
// Context/requirementContext.tsx (kept: folderStructure still imports it)
// still import types/components from it.
import { HTML5Backend } from "react-dnd-html5-backend";
import Projects from './Pages/projects'
// WP-132 — invitation landing page, reached from the link in an invite mail.
import AcceptInvite from './Pages/acceptInvite';
import Reports from './Pages/reports'
import ProjectRouteLayout from './Layouts/ProjectRouteLayout';
import LegacyRedirect from './Layouts/LegacyRedirect';
import SettingsShell from './Pages/settings';
import Workbench from './workbench/Workbench';
import MainLayout from './Components/Layout/MainLayout';
import MembersTab from './Pages/settings/MembersTab';
import ApiKeysTab from './Pages/settings/ApiKeysTab';
import AuditTab from './Pages/settings/AuditTab';
import FieldsTab from './Pages/settings/FieldsTab';
import EnvironmentsTab from './Pages/settings/EnvironmentsTab';
import ReservedTab from './Pages/settings/ReservedTab';

// WP-044 — project-scoped information architecture. Every page that used
// to live at a flat path (/dashboard, /requirements, /testrepo, /testplan,
// /testexecution, /defects, /releases, /audit, /apikeys) now lives under
// /projects/:projectId/..., nested inside <ProjectRouteLayout> (which
// parses :projectId, drives currentProject.ts's singleton -- and through
// it every api/*Api.ts module's X-Project-Id header -- and remounts its
// subtree on a project switch; see that file's own header comment for the
// full mechanics). Every old flat path still resolves, via
// <LegacyRedirect>, to the same content under whichever project is
// currently active (or the seeded Default Project if none has mounted yet
// this session) -- "old bookmarks redirect" per this WP's acceptance.
//
// /projects itself (Pages/projects.tsx, WP-020's org-wide Organization ->
// Project list/CRUD) deliberately stays OUTSIDE the /projects/:projectId
// prefix and is NOT redirected -- it isn't scoped to any one project, it's
// the page you use to see/create/switch between all of them. React Router
// v6 matches the literal "/projects" segment-for-segment against
// "/projects/:projectId" without ambiguity (verified in
// Layouts/__tests__/routing.test.tsx).
//
// URL identifier choice: the numeric Project.id (e.g. "1"), not the Mongo
// _id or the human `key`. Reasoning (see EXECUTION_LOG.md's WP-044 report
// for the full writeup): requireProjectScope() (WP-021) reads the numeric
// id straight off the X-Project-Id header, and every api/*Api.ts module
// built since WP-021/WP-022 already hardcoded that same numeric id (1) as
// its Default Project -- using it in the URL means the route and the
// header agree with zero translation. A `key`-based URL would be more
// readable but requires an extra project-list lookup (key -> numeric id)
// before ANY api call in a fresh session can even set the header,
// introducing a request waterfall and a new "key not found" failure mode
// that a plain Number(param) doesn't have.

// WP-074 Step 7 / WP-075 Step 1 — a project-scoped page retired in favour
// of the workbench redirects straight to the equivalent workbench module
// instead of rendering a page component. First written as a one-off
// `TestRepoRedirect` for Test Cases (WP-074); generalised here into one
// component parameterized by target module now that Requirements (this
// WP) needs the identical mechanics, rather than copy-pasting a second
// near-identical component. Relative `to="../workbench/<module>"`
// resolves against this route's position in the route TREE (one level up
// from e.g. `requirements` to `/projects/:projectId`, then into
// `workbench/<module>`) -- React Router v6 resolves relative navigation
// from the matched route pattern, so `:projectId` carries through
// untouched, matching every other relative <Navigate> already in this
// file (e.g. `index` -> "dashboard"). `location.search` is appended by
// hand since <Navigate to="string"> does not carry it forward on its own
// -- there is no existing app-wide helper for that (LegacyRedirect.tsx's
// own equivalent is one level up, flat path -> project-scoped path, not
// project-scoped -> workbench). `replace` (not push): a chained redirect
// (see the flat `/requirements` / `/testrepo` -> LegacyRedirect -> here
// cases below) should not leave the intermediate project-scoped URL in
// browser history either.
function WorkbenchModuleRedirect({ module }: { module: string }) {
  const location = useLocation();
  return <Navigate to={`../workbench/${module}${location.search}`} replace />;
}

function App() {
  const [wsObject, setWsObject] = useState<WSObject>({ workspaceName: '', workspaceId: '', imageName: '' });
  const [templateObject, setTemplateObject] = useState<TemplateObject>({ TemplateName: '', templateId: '', gitURL: '' });
  const [pObject, setpObject] = useState<PObject>({ projectName: '', projectDescription: '', projectUrl: '', projectId: '', createdBy: '', updatedBy: '' });

  return (
    <QueryClientProvider client={queryClient}>
      <DndProvider backend={HTML5Backend}>
              <WSContext.Provider value={{ wsObject, setWsObject }}  >
                <TemplateContext.Provider value={{ templateObject, setTemplateObject }}>
                  <PContext.Provider value={{ pObject, setpObject }}>
                    <BrowserRouter>
                      <Routes>
                        {/* Project-scoped routes (this WP). */}
                        <Route path="/projects/:projectId" element={<ProjectRouteLayout />}>
                          <Route index element={<Navigate to="dashboard" replace />} />
                          <Route path="dashboard" element={<Dashboard />} />
                          {/* WP-075 -- Requirements retired from its own page;
                              redirects into the workbench. See
                              WorkbenchModuleRedirect's header comment above for
                              the mechanics. */}
                          <Route path="requirements" element={<WorkbenchModuleRedirect module="requirements" />} />
                          {/* WP-074 -- Test Cases retired from its own page;
                              redirects into the workbench. See
                              WorkbenchModuleRedirect's header comment above for
                              the mechanics. */}
                          <Route path="testrepo" element={<WorkbenchModuleRedirect module="testcases" />} />
                          {/* WP-076 -- Test Plans retired from its own page;
                              redirects into the workbench. See
                              WorkbenchModuleRedirect's header comment above for
                              the mechanics. */}
                          <Route path="testplan" element={<WorkbenchModuleRedirect module="testplans" />} />
                          {/* WP-076 -- Test Execution retired from its own page;
                              redirects into the workbench. See
                              WorkbenchModuleRedirect's header comment above for
                              the mechanics. */}
                          <Route path="testexecution" element={<WorkbenchModuleRedirect module="testruns" />} />
                          {/* WP-077 -- Defects retired from its own page;
                              redirects into the workbench. See
                              WorkbenchModuleRedirect's header comment above for
                              the mechanics. */}
                          <Route path="defects" element={<WorkbenchModuleRedirect module="defects" />} />
                          {/* WP-F18b Task 4 -- Releases' own project-scoped
                              page (Pages/releases.tsx) is retired; this
                              route now redirects straight into the
                              workbench, the same shape WorkbenchModuleRedirect
                              already gives requirements/testrepo/testplan/
                              testexecution/defects above. Every capability
                              that page had is now in ReleaseDetail.tsx
                              (gate editing/status, delete) and Settings'
                              Environments tab (create/edit/delete) -- see
                              this WP's plan and Task 4's report for the
                              verified checklist. */}
                          <Route path="releases" element={<WorkbenchModuleRedirect module="releases" />} />
                          <Route path="reports" element={<Reports />} />
                          {/* WP-072 -- new workbench shell, shipped alongside the routes
                              above (strangler approach). :entityId is optional: the URL
                              names the active tab per spec §3.2, an open panel with no
                              entity selected needs no third segment.
                              WP-078 Part A -- wrapped in <MainLayout fillHeight> so the
                              workbench is no longer a dead end (WP-072 shipped it with no
                              way back to Home/Projects/Reports/Settings). fillHeight
                              threads one real 100vh down through MainDrawer instead of
                              Workbench.tsx re-declaring its own -- see MainLayout.tsx's
                              and Workbench.tsx's own comments for the full mechanics. */}
                          <Route path="workbench/:module/:entityId?" element={<MainLayout fillHeight><Workbench /></MainLayout>} />
                          <Route path="settings" element={<SettingsShell />}>
                            <Route index element={<Navigate to="members" replace />} />
                            <Route path="members" element={<MembersTab />} />
                            <Route path="apikeys" element={<ApiKeysTab />} />
                            <Route path="audit" element={<AuditTab />} />
                            <Route path="fields" element={<FieldsTab />} />
                            {/* WP-F18b Task 1 -- environments move to Settings (ruling
                                R1). Task 4 removed Pages/releases.tsx's own
                                (create-only) environments section; this tab is
                                now the only home, and it does strictly more
                                (create/edit/delete). */}
                            <Route path="environments" element={<EnvironmentsTab />} />
                            <Route path="modules" element={<ReservedTab label="Modules" />} />
                            <Route path="folders" element={<ReservedTab label="Folders" />} />
                          </Route>
                        </Route>

                        {/* Not project-scoped: org-wide project list/CRUD, unaffected by this WP. */}
                        <Route path='/projects' element={<Projects />} />
                        {/* WP-132: accepts an invitation. Keycloak's
                            login-required init means an invitee with no account
                            is sent to register first and returned here with the
                            ?token= query intact. */}
                        <Route path='/accept-invite' element={<AcceptInvite />} />
                        <Route path='/profile' element={<Profile />} />

                        {/* Legacy flat paths -- redirect to the equivalent project-scoped route
                            under whichever project is currently active. "Old bookmarks redirect". */}
                        <Route path="/" element={<LegacyRedirect to="/dashboard" />} />
                        <Route path='/dashboard' element={<LegacyRedirect to="/dashboard" />} />
                        <Route path='/requirements' element={<LegacyRedirect to="/requirements" />} />
                        <Route path='/testrepo' element={<LegacyRedirect to="/testrepo" />} />
                        <Route path='/testplan' element={<LegacyRedirect to="/testplan" />} />
                        <Route path='/testexecution' element={<LegacyRedirect to="/testexecution" />} />
                        <Route path='/defects' element={<LegacyRedirect to="/defects" />} />
                        {/* WP-025: Release + Environment + quality-gate UI. */}
                        <Route path='/releases' element={<LegacyRedirect to="/releases" />} />
                        {/* WP-024: Audit log UI -- relocated under Settings (this WP). */}
                        <Route path='/audit' element={<LegacyRedirect to="/settings/audit" />} />
                        {/* WP-032: API keys settings UI -- relocated under Settings (this WP). */}
                        <Route path='/apikeys' element={<LegacyRedirect to="/settings/apikeys" />} />

                        <Route path="*" element={<Page404 />} />
                      </Routes>
                    </BrowserRouter>
                  </PContext.Provider>
                </TemplateContext.Provider>
              </WSContext.Provider>
      </DndProvider>
    </QueryClientProvider>




  );
}

export default App;
