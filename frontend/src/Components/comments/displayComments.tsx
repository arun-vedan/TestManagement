import React, { useEffect, useState } from "react";
import "./comments.css";
import {
  getComments,
  createComments,
  updateCommentsByParam,
  deleteCommentById,
} from "../../api/apiCalls";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";

const Comments = (props) => {
  const [comments, setComments] = useState("");
  const [updatedText, setUpdatedText] = useState("");
  const [displayComments, setDisplayComments] = useState([]);
  const [isEditing, setIsEditing] = useState(false);
  const [isDelete, setIsDelete] = useState(false);
  const [uniqueId, setUniqueId] = useState("");
  const [open, setOpen] = useState(false);

  const handleClose = () => {
    setUniqueId("");
    setIsDelete(false);
    setOpen(false);
  };

  const getCommentsList = async () => {
    let selectedTypeId = props.typeId;
    let selectedModuleId = props.moduleId;
    let getCommentsList = await getComments(selectedTypeId, selectedModuleId);
    setDisplayComments(getCommentsList);
  };

  const insertNewComment = async () => {
    let moduleId = props.moduleId;
    let typeId = props.typeId;
    let newComments = comments;
    setComments(newComments);
    let payload = {
      moduleId: moduleId,
      typeId: typeId,
      comments: newComments,
      createdAt: new Date().toLocaleString(),
    };
    let insertNewComment = await createComments(payload);
    if (insertNewComment) {
      setComments("");
      getCommentsList();
    }
  };

  const handleEditToggle = async (uniqueId: string) => {
    setUniqueId(uniqueId);
    setIsEditing(true);
  };

  const handleDeleteToggle = async (uniqueId: string) => {
    setUniqueId(uniqueId);
    setIsDelete(true);
    setOpen(true);
  };

  const handleDeleteComment = async () => {
    let deleteComment = await deleteCommentById(uniqueId);
    if (deleteComment.success) {
      setUniqueId("");
      setIsDelete(false);
      setOpen(false);
      getCommentsList();
    } else {
      console.log("Error in Deleteing the Comment");
    }
  };

  const handleCommentsCancel = async () => {
    setUniqueId("");
    setIsEditing(false);
  };

  const handleUpdateComment = async () => {
    let payload = {
      comments: updatedText,
      updatedAt: new Date().toLocaleString(),
    };
    let updateCommentsById = await updateCommentsByParam(uniqueId, payload);
    if (updateCommentsById.success) {
      setUniqueId("");
      setIsEditing(false);
      getCommentsList();
    }
  };

  const handleCommentChange = async (e) => {
    setUpdatedText(e.target.value);
    setUniqueId(e.target.id);
  };

  useEffect(() => {
    getCommentsList();
    // getCommentsList is redefined every render (it closes over props.typeId /
    // props.moduleId); adding it as a dep would run this effect on every render
    // instead of only on mount. Behavior is unchanged from before this fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="comments-section">
      <h3>Discussion</h3>

      <form onSubmit={insertNewComment}>
        <div className="user-info">
          {/* Circle Icon with Two Letters */}
          <div className="user-initials">
            {props.userName ? props.userName.slice(0, 2).toUpperCase() : ""}
          </div>

          <textarea
            aria-label="Add a comment"
            placeholder="Add a Comment"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            required
          />
        </div>
        <div className="button-container">
          <button
            type="button"
            onClick={insertNewComment}
            style={{
              backgroundColor: "#DCDCDC",
              color: "black",
              borderRadius: "4px",
            }}
          >
            Post Comment
          </button>
        </div>
      </form>
      {displayComments.map((comments, index) => {
        return (
          <div className="comment-container">
            <div className="user-initials">
              {comments.updatedByName
                ? comments.updatedByName.slice(0, 2).toUpperCase()
                : ""}
            </div>
            <div className="comment-box">
              <div className="comment-header">
                <div className="comment-details">
                  <strong>{comments.updatedByName}</strong>{" "}
                  <span>{comments.updatedAt} </span>{comments.isEdited === 1 ? (<span>(edited)</span>):''}
                  {!isEditing && props.userId === comments.createdBy ? (
                    <IconButton
                      className="edit-icon"
                      size="small"
                      aria-label="Edit comment"
                      onClick={() => handleEditToggle(comments._id)}
                    >
                      <EditIcon fontSize="small"></EditIcon>
                    </IconButton>
                  ) : (
                    ""
                  )}{" "}
                  {!isDelete && props.userId === comments.createdBy ? (
                    <IconButton
                      className="delete-icon"
                      size="small"
                      aria-label="Delete comment"
                      onClick={() => handleDeleteToggle(comments._id)}
                    >
                      <DeleteIcon fontSize="small"></DeleteIcon>
                    </IconButton>
                  ) : (
                    ""
                  )}
                </div>
              </div>
              {isEditing && uniqueId === comments._id ? (
                <div className="edit-comment">
                  <textarea
                    id={comments._id}
                    aria-label="Edit comment"
                    defaultValue={comments.comments}
                    onChange={handleCommentChange}
                    rows={4}
                    className="borderless-textarea"
                  />
                  <button
                    style={{
                      backgroundColor: "#DCDCDC",
                      color: "black",
                      borderRadius: "4px",
                    }}
                    onClick={handleUpdateComment}
                  >
                    Update
                  </button>
                  <button
                    style={{
                      marginLeft: "5px",
                      backgroundColor: "#DCDCDC",
                      color: "black",
                      borderRadius: "4px",
                    }}
                    onClick={handleCommentsCancel}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="comment-text">
                  <p>{comments.comments}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Display Comments */}
      <div className="comments-list">
        {displayComments.length <= 0 ? (
          <p>No comments yet. Be the first to comment!</p>
        ) : (
          ""
        )}
      </div>
      <Dialog
        open={open}
        onClose={handleClose}
        aria-labelledby="delete-comment-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="delete-comment-dialog-title">Delete comment</DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            Are you sure you want to delete this comment?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            variant="contained"
            size="small"
            onClick={handleDeleteComment}
          >
            Delete
          </Button>
          <Button
            variant="contained"
            color="secondary"
            size="small"
            onClick={handleClose}
          >
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
};

export default Comments;
