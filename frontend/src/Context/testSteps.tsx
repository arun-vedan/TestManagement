import { createContext } from "react";

export type TCStepsProps = {
    tcSteps?: any[];
    setTcSteps: React.Dispatch<React.SetStateAction<(any[])>>;
  }

export const TCStepsContext = createContext<TCStepsProps | undefined>(undefined);