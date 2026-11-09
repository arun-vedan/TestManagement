import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';

export const MIN_PANEL_WIDTH = 220;
export const MAX_PANEL_WIDTH = 640;
const KEYBOARD_STEP = 16;

function clamp(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

interface Props {
  /** Current committed panel width. */
  width: number;
  /** Called once, with the final clamped width, when a drag or key press finishes. */
  onCommit: (width: number) => void;
}

// WP-072 — resizable divider between the source panel and the detail
// area. Commits to the store on drag END only (mouseup), never on every
// mousemove: the store persists to localStorage on every write (WP-070),
// so writing per-pixel-of-mousemove would thrash localStorage and, via
// the persisted subscription, every component reading panelWidth.
// role="separator" + aria-orientation + arrow-key support so resizing
// isn't mouse-only (keyboard users get the same [220, 640] clamp).
export default function Splitter({ width, onCommit }: Props): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(width);
  const pendingWidth = useRef(width);

  const handleMouseMove = useCallback((event: MouseEvent) => {
    const delta = event.clientX - dragStartX.current;
    pendingWidth.current = clamp(dragStartWidth.current + delta);
  }, []);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
    onCommit(pendingWidth.current);
  }, [onCommit]);

  // Attach/detach document listeners only while actually dragging, and
  // always through the latest handlers (they close over onCommit).
  useEffect(() => {
    if (!dragging) {
      return undefined;
    }
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  const handleMouseDown = (event: React.MouseEvent): void => {
    dragStartX.current = event.clientX;
    dragStartWidth.current = width;
    pendingWidth.current = width;
    setDragging(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onCommit(clamp(width - KEYBOARD_STEP));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onCommit(clamp(width + KEYBOARD_STEP));
    }
  };

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={MAX_PANEL_WIDTH}
      aria-valuenow={width}
      aria-label="Resize source panel"
      tabIndex={0}
      data-testid="workbench-splitter"
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      sx={{
        width: 4,
        flexShrink: 0,
        cursor: 'col-resize',
        bgcolor: dragging ? 'action.selected' : 'divider',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -1 },
      }}
    />
  );
}
