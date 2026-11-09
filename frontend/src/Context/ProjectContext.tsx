import { createContext } from "react";
import { PObject } from "../model/ProjectContext";

// WP-020 note: this context/PObject shape belongs to the legacy
// k8s-deployment "create project" wizard (Pages/createNewProject.tsx),
// which POSTs to /api/v1/project, /api/v1/deployments, /api/v1/service and
// /api/v1/ingress -- none of which exist anywhere in Kong or in any backend
// service (verified by grep across backend/ and srckube-kong/kong.yml).
// That whole flow, and this context, were already unreachable dead code
// before this WP (Pages/projects.tsx and Pages/createNewProject.tsx were
// never registered in App.tsx's route table either -- see EXECUTION_LOG.md).
//
// The real Organization/Project entities this WP adds (backend/userService
// models/{Organization,Project}.js, frontend/src/api/projectApi.ts) are
// deliberately NOT modeled through PObject/PContext: reshaping this type to
// match the new Project shape would ripple into components outside this
// WP's scope that still read PObject's old fields (App.tsx, mainList.tsx,
// NewProjectDetails.tsx, createNewProject.tsx). Pages/projects.tsx manages
// its own local state against the new API instead. This context is left
// structurally unchanged; retiring or repointing it is future work (an
// organization/project "selection" context is exactly what WP-021's tenant
// scoping will need, once real project switching exists in the UI).

export type PContextProps = {
    pObject?: PObject;
    setpObject: React.Dispatch<React.SetStateAction<PObject>>;
  }

export const PContext = createContext<PContextProps>({ pObject: { projectId: '', projectName: '', projectUrl: '',projectDescription: '',createdBy:'',updatedBy:'' }, setpObject: () => {} });




