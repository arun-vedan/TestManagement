import { Skeleton } from "@mui/material";

export const ListSkeleton = ({listsToRender}) => {
    return (
      <>
        {Array(listsToRender)
          .fill(1)
          .map((card, index) => (
            <Skeleton variant="rounded" height={40} ></Skeleton>
          ))}
      </>
    );
  };