import { createContext } from "react";
import { WSObject } from "../model/workSpaceContext";

export type WSContextProps = {
    wsObject?: WSObject;
    setWsObject: React.Dispatch<React.SetStateAction<WSObject>>;
  }

export const WSContext = createContext<WSContextProps>({ wsObject: { imageName: '', workspaceId: '0', workspaceName: '' }, setWsObject: () => {} });




