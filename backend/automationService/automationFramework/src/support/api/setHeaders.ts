let headers = {}
export let setHeader =async (header:any) => {

    let parsedHead = JSON.parse(header)
    headers = {...headers,...parsedHead}
    console.log(headers)   
}

export let getHeader =async () => {
    return headers    
}