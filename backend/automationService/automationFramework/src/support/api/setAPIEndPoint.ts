let endPoint = ''
export let setAPIEndPoint =  async (apiEndPoint:string) => {
     endPoint = apiEndPoint
};

export let getAPIEndPoint = async() =>{
    return endPoint
}
