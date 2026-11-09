import axios from "axios";
import { getAPIEndPoint } from "./setAPIEndPoint.js";
import { getRequest } from "./setRequest.js";
import { getHeader } from "./setHeaders.js";
export let postRequest =async (methodName:string) => {
     let response:any = ''
     let apiEndPoint = await getAPIEndPoint();
     let apiBody = await getRequest();
    let apiHeader = await getHeader();
     console.log(apiHeader)
     methodName = methodName.toLocaleUpperCase();
     switch(methodName) 
     {
          case "POST":
          {
               response=await axios.post(apiEndPoint,apiBody,{'headers':apiHeader})
               console.log(response)
               break;
          }
          case "GET":
          {
               response=await axios.get(apiEndPoint,{'headers':apiHeader})
               console.log(response)
               break;
          }
          case "PUT":
          {
               response=await axios.put(apiEndPoint,apiBody,{'headers':apiHeader})
               console.log(response)
               break;
          }
          case "DELETE":
          {
               response=await axios.delete(apiEndPoint,{'headers':apiHeader})
               console.log(response)
               break;

          }     

     }
}
