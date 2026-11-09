import  axiosPrivate  from "./axios";

export let getFolderList = async(parentFolder:number | string,moduleId:number) =>{
    let foldListResponse = await axiosPrivate.get(`/api/v1/folders?moduleId=${moduleId}&parentFolder=${parentFolder}`)
    return foldListResponse.data.data
} 

export let getReqList =async (queryParams:string) => {
    let reqList = await axiosPrivate.get(`/api/v1/requirement?${queryParams}`)
    return reqList.data.data
    
}
export let getTcList =async (queryParams:string) => {
    let reqList = await axiosPrivate.get(`/api/v1/testrepo?${queryParams}`)
    return reqList.data.data
    
}

export let getTestPlanList =async (queryParams:string) => {
    let reqList = await axiosPrivate.get(`/api/v1/testplan?${queryParams}`)
    return reqList.data.data
    
}

export let getFields = async(moduleId:number) =>{
    let fields = await axiosPrivate.get(`api/v1/fields?moduleId=${moduleId}&sort=id`)
    return fields.data.data
}

export let updateRequirement = async(updateReq,id) =>{
    let updateRes = await axiosPrivate.put(`/api/v1/requirement/${id}`,updateReq)
    return updateRes.data
}

export let createFolderApi =async (createFoldReq) => {
    let createFold = await axiosPrivate.post(`/api/v1/folders`,createFoldReq)
    if(createFold.status===201)
    {
        return "Success"
      
    }
    else{
        return "There was an issue in creating folder"
    }
   
}

export let saveRequirement = async (createReqPayLoad) =>{
    let createReq = await axiosPrivate.post(`/api/v1/requirement`,createReqPayLoad)
  
    return createReq.data.data
}

export let updateTestCase =  async(updatetc,id) =>{
    let updateTc = await axiosPrivate.put(`/api/v1/testrepo/${id}`,updatetc)
    return updateTc.data
}
export let saveTestCase = async (createTcPayLoad) =>{
    let createTc = await axiosPrivate.post(`/api/v1/testrepo`,createTcPayLoad)
  
    return createTc.data.data
}

export let updatedTestPlan = async (planId,reqData) =>{
    let updateTc = await axiosPrivate.put(`/api/v1/testplan/${planId}`,reqData)
    return updateTc.data
}

export let saveApiTestPlan = async (reqData) =>{
    let updateTc = await axiosPrivate.post(`/api/v1/testplan`,reqData)
    return updateTc.data
}

export let createTestExecution = async(reqData) =>{
    let createTE = await axiosPrivate.post(`/api/v1/testexecution`,reqData)
    return createTE.data
}

export let getTestExecutionList = async(queryParams:string) =>{
    let reqList = await axiosPrivate.get(`/api/v1/testexecution?${queryParams}`)
    return reqList.data.data
}

// WP-F07b Task 4 -- iterationIndex is additive (R1: absent means 0), so it
// is a trailing, defaulted param here rather than reordering the existing
// (tcId, exeId, ...) shape every caller already uses. The backend's own six
// addressing sites (Task 1, controllers/testexecution.js) already resolve
// a missing `?iterationIndex` query param to 0 -- that comment there says
// explicitly "no caller has been updated to send it yet -- Task 4 is the
// frontend". This is that update: without it, TestRunDetail could never
// reach iteration 1/2 of a parameterised case, no matter what it rendered.
export let getTeTestCaseDetails = async(tcId,exeId,iterationIndex:number=0)=>{
    let tcDetails = await axiosPrivate.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcId}&exeid=${exeId}&iterationIndex=${iterationIndex}`)
    return tcDetails.data.data
}

export let updateTestSteps = async(tcId,exeId,reqData,iterationIndex:number=0)=>{
    let updateStep = await axiosPrivate.put(`/api/v1/testexecution/updateteststep?tcid=${tcId}&exeid=${exeId}&iterationIndex=${iterationIndex}`,reqData)
    return updateStep.data.data
}

export let uploadAttachment = async(fileFormData) =>{
    let uploadResponse = await axiosPrivate.post(`/api/v1/attachment/upload/file`,fileFormData)
    return uploadResponse
}

export let updateAttachment = async(tcId,exeId,attachmetList,iterationIndex:number=0) =>{
    let attachmentRespone = await axiosPrivate.put(`/api/v1/testexecution/updateattachment?tcid=${tcId}&exeid=${exeId}&iterationIndex=${iterationIndex}`,attachmetList)
    return attachmentRespone
}

export let nDownloadFile = async(attachId) =>{
    let attachResponse = await axiosPrivate.get(`/api/v1/attachment/download/file/${attachId}`)
    return attachResponse
}
export let getCreatedBy = async(userId) =>{
    let response = await axiosPrivate.get(`/api/v1/users/kcUser?id=${userId}`)
    return response.data.data.username
}

// The people on the CURRENT project. Renamed from getUsersList, which read
// `/api/v1/users/kcUsers?id=` -- an empty filter that returned every user in
// the Keycloak realm to any signed-in caller. That was a cross-tenant
// disclosure (it also returned their email addresses); see
// backend/userService/utils/identityVisibility.js.
//
// The project id travels in X-Project-Id, which api/axios.tsx injects on every
// request, so no call site has to pass it.
//
// This is also the more correct answer for an assignee picker: work should not
// be assignable to somebody who is not on the project. Returns
// { id, username, firstName, lastName, projectRole, resolved }.
export let getUserDirectory = async() =>{
    let response = await axiosPrivate.get('/api/v1/users/directory')
    return response.data.data
}
export let updateTestExecution =  async(updatetc,id) =>{
    let updateTc = await axiosPrivate.put(`/api/v1/testexecution/${id}`,updatetc)
    return updateTc.data
}

export let getAutomationStepDef =async () => {
    let stepDef = await axiosPrivate.get(`api/v1/automation/getStepDef`)
    return stepDef.data.data
    
}

export let getSavedFeature = async(tcId) =>{
    let featrues = await axiosPrivate.get(`api/v1/automation?TestCaseId=${tcId}&limit=1`)
    return featrues.data.data
}

export let saveFeature = async(tcId,payload) =>{
    let saveFeature = await axiosPrivate.post(`api/v1/automation?TestCaseId=${tcId}`,payload)
    return saveFeature.data
}
export let getDefectList = async(queryParams:string) =>{
    let defectList = await axiosPrivate.get(`api/v1/defects?${queryParams}`)
    return defectList.data.data

}

export let updateDefect = async(defectID,updateBody)=>{
    let updateDefect = await axiosPrivate.put(`api/v1/defects/${defectID}`,updateBody)
    return updateDefect.data
}

export let postDefect = async(payLoad) =>{
    let createDefect = await axiosPrivate.post(`api/v1/defects`,payLoad)
    return createDefect.data.data
}

export let updateFolderByParam = async(foldid,payLoad)=>{
    let payloadchange = await axiosPrivate.put(`/api/v1/folders/updatebyparam/${foldid}`,payLoad)
    return payloadchange
}

export let updateRequirementByParam = async(reqId,payLoad)=>{
    let payloadchange = await axiosPrivate.put(`/api/v1/requirement/updateRequirementByParam?reqid=${reqId}`,payLoad)
    return payloadchange
}
export let updateTestCaseByParam = async(reqId,payLoad)=>{
    let payloadchange = await axiosPrivate.put(`/api/v1/testrepo/updateTestCaseByParam?tcid=${reqId}`,payLoad)
    return payloadchange
}

// Sprint 2.1 governance (PB-04): lifecycle status transitions + version history
export let updateTestCaseStatus = async(id:string, status:string) =>{
    let updateRes = await axiosPrivate.put(`/api/v1/testrepo/${id}/status`, { status })
    return updateRes.data
}

export let getTestCaseVersions = async(id:string) =>{
    let versions = await axiosPrivate.get(`/api/v1/testrepo/${id}/versions`)
    return versions.data.data
}

export let updateRequirementStatus = async(id:string, status:string) =>{
    let updateRes = await axiosPrivate.put(`/api/v1/requirement/${id}/status`, { status })
    return updateRes.data
}

export let getRequirementVersions = async(id:string) =>{
    let versions = await axiosPrivate.get(`/api/v1/requirement/${id}/versions`)
    return versions.data.data
}

export let getWCReqList =async (searchText) => {
    let reqlist = await axiosPrivate.get(`api/v1/requirement/wildcardsearch?search=${searchText}`)
    return reqlist.data.data
    
}

export let getWCTCList =async (searchText) => {
    let reqlist = await axiosPrivate.get(`api/v1/testrepo/wildcardsearch?search=${searchText}`)
    return reqlist.data.data
    
}

export let getWCDefectList=async (searchText) => {
    let reqlist = await axiosPrivate.get(`api/v1/defects/wildcardsearch?search=${searchText}`)
    return reqlist.data.data
    
}

// WP-F01 -- test plans (module 3) and test runs (module 4). Unlike the
// three helpers above these encode the search text: an unencoded "&" or
// "#" in a query string is truncated by the time it reaches Express.
export let getWCPlanList = async (searchText) => {
    let planList = await axiosPrivate.get(`api/v1/testplan/wildcardsearch?search=${encodeURIComponent(searchText)}`)
    return planList.data.data
}

export let getWCRunList = async (searchText) => {
    let runList = await axiosPrivate.get(`api/v1/testexecution/wildcardsearch?search=${encodeURIComponent(searchText)}`)
    return runList.data.data
}

export let createLink = async(payLoad) =>{
    let createLinkIssue = await axiosPrivate.post(`api/v1/linkIssue`,payLoad)
    return createLinkIssue.data.data
}

export let getLinkedIssuesApi =async (srcId) => {
    let linkedIssue = await axiosPrivate.get(`api/v1/linkIssue?${srcId}`)
    return linkedIssue.data.data
    
}

export let deleteLinkAPI = async(linkId) =>{
    let deleteLink = await axiosPrivate.delete(`api/v1/linkIssue/${linkId}`)
    return deleteLink
}

export let deleteLinkcAPI = async(params) =>{
    let deleteLink = await axiosPrivate.delete(`api/v1/linkIssue/completedelete?${params}`)
    return deleteLink
}

// Wave B-3 -- per-entity delete. Every module has a properly-scoped
// per-entity DELETE endpoint (keycloak.protect() -> requireProjectScope()
// -> authorize('delete')), but nothing in this file called any of them
// before this WP -- bulk delete (api/bulkApi.ts) covers modules 1/5 from
// the LIST view only, leaving no way to remove a single mistyped/duplicate
// record from anywhere else. These are plain thin wrappers, same shape as
// every update*/save* function above.
export let deleteTestCase = async(id:string) =>{
    let deleteRes = await axiosPrivate.delete(`/api/v1/testrepo/${id}`)
    return deleteRes.data
}

export let deleteRequirement = async(id:string) =>{
    let deleteRes = await axiosPrivate.delete(`/api/v1/requirement/${id}`)
    return deleteRes.data
}

export let deleteTestPlan = async(id:string) =>{
    let deleteRes = await axiosPrivate.delete(`/api/v1/testplan/${id}`)
    return deleteRes.data
}

export let deleteTestExecution = async(id:string) =>{
    let deleteRes = await axiosPrivate.delete(`/api/v1/testexecution/${id}`)
    return deleteRes.data
}

export let deleteDefect = async(id:string) =>{
    let deleteRes = await axiosPrivate.delete(`/api/v1/defects/${id}`)
    return deleteRes.data
}



//GetAll Projects
export let getAllProjects =async () => {
    let stepDef = await axiosPrivate.get(`api/v1/projects/getAllProjects`)
    return stepDef.data.data
    
}

//Get All Comments
export let getComments =async (typeId:string,moduleId:number) => {
    let comments = await axiosPrivate.get(`api/v1/comments?typeId=${typeId}&moduleId=${moduleId}`)
    return comments.data.data
    
}

//Insert new Comments
export let createComments = async(payLoad) =>{
    let createComments = await axiosPrivate.post(`api/v1/comments`,payLoad)
    return createComments.data.data
}

//Update Comments
export let updateCommentsByParam =  async(id,payload) =>{
    let updateTc = await axiosPrivate.put(`/api/v1/comments/updateCommentsByParam?id=${id}`,payload)
    return updateTc.data
}

//Delete Comment - soft Delete status change
export let deleteCommentById =  async(id:string) =>{
    let updateTc = await axiosPrivate.put(`/api/v1/comments/deleteCommentById?id=${id}`,{})
    return updateTc.data
}

