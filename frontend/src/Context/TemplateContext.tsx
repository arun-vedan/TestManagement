import { createContext } from "react";
import { TemplateObject } from "../model/TemplateModel";

export type TemplateContextProps = {
    templateObject?: TemplateObject;
    setTemplateObject: React.Dispatch<React.SetStateAction<TemplateObject>>;
  }

export const TemplateContext = createContext<TemplateContextProps>({ templateObject: { templateId: '', gitURL: '', TemplateName: '' }, setTemplateObject: () => {} });




