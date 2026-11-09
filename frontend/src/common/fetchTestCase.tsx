import { getFolderList, getTcList } from "../api/apiCalls";
const objectExists = (array, key, value) => {
    return array.some(obj => obj[key] === value);
};
export let fetchfoldtc = async (root,objects) => {
    let data = [...objects];
    try {
        let reqFoldlist = await getFolderList(root, 1)
        for (let reqFold of reqFoldlist) {
            let finalFold = {
                "id": reqFold['id'],
                "parent": reqFold['parentFolder'],
                "droppable": true,
                "text": reqFold['folderName']
            }
            if (await objectExists(data, "id", reqFold['id']) === false) {
                data.push(finalFold)
            }
        }
        let reqList = await getTcList(`select=TestCaseId,TestCaseSummary,parentId,id&parentId=${root}`)
        for (let reqFold of reqList) {
            let finalFold = {
                "id": reqFold['TestCaseId'],
                "Summary":reqFold['TestCaseSummary'],
                "parent": reqFold['parentId'],
                "droppable": false,
                "text": reqFold['TestCaseId'],
                "data": {
                    "fileType": "testCase"
                }
            }
            if (await objectExists(data, "id", reqFold['TestCaseId']) === false) {
                data.push(finalFold)
            }
        }



    } catch (error) {
        console.error('Error fetching data:', error);
    }
    return (data)
}
export let fetchtc = async () => {


}
