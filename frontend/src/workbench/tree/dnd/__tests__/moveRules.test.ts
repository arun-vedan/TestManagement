import {
  ENTITY_DRAG_TYPE,
  isNodeMovable,
  canDropOnFolder,
  canDropOnRoot,
  buildMoveVars,
  DragPayload,
} from '../moveRules';

// WP-077b -- these are the pure rules EntityTreeNode's useDrag/useDrop
// configs (and the keyboard "Move to..." menu) are built from. Covered as
// plain function calls per the WP brief: jsdom does not implement HTML5
// drag events faithfully, so the actual react-dnd wiring is verified
// against the DOM in EntityTree.dnd.test.tsx (attribute-level, real
// DndProvider) and in the browser check, not by synthesising drag events
// here.

describe('ENTITY_DRAG_TYPE', () => {
  it('is a stable non-empty string shared by every drag source/target', () => {
    expect(typeof ENTITY_DRAG_TYPE).toBe('string');
    expect(ENTITY_DRAG_TYPE.length).toBeGreaterThan(0);
  });
});

describe('isNodeMovable', () => {
  it('is true for a folder in every module', () => {
    ([1, 2, 3, 4, 5, 6] as const).forEach((module) => {
      expect(isNodeMovable(module, true)).toBe(true);
    });
  });

  it('is true for a leaf in module 1 (test cases) and 2 (requirements)', () => {
    expect(isNodeMovable(1, false)).toBe(true);
    expect(isNodeMovable(2, false)).toBe(true);
  });

  it('is false for a leaf in modules 3/4/5 (test plans/runs/defects) -- no mover exists', () => {
    expect(isNodeMovable(3, false)).toBe(false);
    expect(isNodeMovable(4, false)).toBe(false);
    expect(isNodeMovable(5, false)).toBe(false);
  });
});

describe('canDropOnFolder', () => {
  const dragged: DragPayload = { id: 'TC-104', parentId: '0', droppable: false };

  it('is true for a different folder that is not the current parent', () => {
    expect(canDropOnFolder(dragged, '8')).toBe(true);
  });

  it('is false when the target is the dragged node itself', () => {
    expect(canDropOnFolder(dragged, 'TC-104')).toBe(false);
  });

  it('is false when the target is the node\'s current parent (no-op move)', () => {
    expect(canDropOnFolder(dragged, '0')).toBe(false);
  });
});

describe('canDropOnRoot', () => {
  it('is true when the node is not already at the root', () => {
    expect(canDropOnRoot({ id: 'TC-104', parentId: '8', droppable: false })).toBe(true);
  });

  it('is false when the node is already at the root (no-op move)', () => {
    expect(canDropOnRoot({ id: 'TC-104', parentId: '0', droppable: false })).toBe(false);
  });
});

describe('buildMoveVars', () => {
  it('builds the exact MoveNodeVars useMoveNode expects', () => {
    const dragged: DragPayload = { id: 'TC-104', parentId: '0', droppable: false };
    expect(buildMoveVars(dragged, '8')).toEqual({
      id: 'TC-104',
      fromParentId: '0',
      toParentId: '8',
      droppable: false,
    });
  });

  it('carries a folder\'s own droppable:true through', () => {
    const dragged: DragPayload = { id: '8', parentId: '0', droppable: true };
    expect(buildMoveVars(dragged, '9')).toEqual({
      id: '8',
      fromParentId: '0',
      toParentId: '9',
      droppable: true,
    });
  });
});
