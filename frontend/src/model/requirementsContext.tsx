type FileData = {
    fileType: string;
  };
export type tObject = {
    id: number;
    parent: number;
    droppable: boolean;
    text: string;
    data?: FileData;
  };
