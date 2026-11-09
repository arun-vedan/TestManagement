import { QueryClient } from '@tanstack/react-query';
import { qk } from '../../../Hooks/queryKeys';
import { TreeNode } from '../../../Hooks/queries/useTreeChildren';
import { resolveSelectedParentId } from '../selectedParent';

// WP-079 Part A -- lifted from Components/folderStructure/folderStructure.tsx's
// createFolder/createNewReq, which both apply the identical rule (a
// selected folder's own id, else a selected leaf's parent, else root '0')
// to decide where a new folder/item belongs. Extracted so both the source
// panel's "New folder" control and TestCaseDetail's Create action share
// one implementation, reading the same qk.children cache EntityTree itself
// populates (precedent: AiDuplicateAuditToolbar.tsx's findSelectedNode).
function seed(client: QueryClient, projectId: number, module: 1, parentId: string, nodes: TreeNode[]) {
  client.setQueryData(qk.children(projectId, module, parentId), nodes);
}

describe('resolveSelectedParentId', () => {
  it('returns root ("0") when nothing is selected', () => {
    const client = new QueryClient();
    expect(resolveSelectedParentId(client, 1, 1, null, [])).toBe('0');
  });

  it("returns a selected folder's own id", () => {
    const client = new QueryClient();
    seed(client, 1, 1, '0', [{ id: 'F1', parent: '0', droppable: true, text: 'Folder 1' }]);
    expect(resolveSelectedParentId(client, 1, 1, 'F1', [])).toBe('F1');
  });

  it("returns a selected leaf's parent folder", () => {
    const client = new QueryClient();
    seed(client, 1, 1, '0', [{ id: 'TC-1', parent: 'F1', droppable: false, text: 'TC-1' }]);
    expect(resolveSelectedParentId(client, 1, 1, 'TC-1', [])).toBe('F1');
  });

  it('finds the selected node inside an expanded (nested) folder, not just root', () => {
    const client = new QueryClient();
    seed(client, 1, 1, '0', [{ id: 'F1', parent: '0', droppable: true, text: 'Folder 1' }]);
    seed(client, 1, 1, 'F1', [{ id: 'TC-9', parent: 'F1', droppable: false, text: 'TC-9' }]);
    expect(resolveSelectedParentId(client, 1, 1, 'TC-9', ['F1'])).toBe('F1');
  });

  it('falls back to root when the selection is stale (no longer in any known query)', () => {
    const client = new QueryClient();
    expect(resolveSelectedParentId(client, 1, 1, 'ghost', [])).toBe('0');
  });
});
