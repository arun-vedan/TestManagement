let request = ''
export let setRequest = async(tempRequest:string) =>{
     request = tempRequest
}

export let getRequest =async () => {
     return request
}