import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LifecycleStatus } from '../../Components/governance/LifecycleStatus';
import { qk } from '../../Hooks/queryKeys';
import { ModuleId } from '../modules';

export type LifecycleEntityType = 'testcase' | 'requirement';

export interface LifecycleStatusSectionProps {
  projectId: number;
  module: ModuleId;
  /** Business key (e.g. "TC-1"/"Req-2") -- what qk.entity() is keyed by. */
  entityId: string;
  /** The record's Mongo _id -- what LifecycleStatus's own status/version APIs take. */
  mongoId: string;
  entityIdLabel?: string;
  status: string;
  entityType: LifecycleEntityType;
  onError: (message: string, severity: string) => void;
}

// WP-074e Part 1a -- Components/governance/LifecycleStatus.tsx (Sprint 2.1
// governance: draft/review/approved/deprecated/archived transitions +
// version history) was rendered by TabContent.tsx:637-650 for BOTH modules
// 1 and 2. The workbench's TestCaseDetail (WP-074) never ported it, and
// deleting Pages/testcases.tsx made it unreachable -- a GR-4 violation.
// This is a shared detail-kit component (not bolted into one module file)
// because both TestCaseDetail and RequirementDetail need it, parameterised
// by entityType/entityIdLabel exactly like the legacy call site was.
//
// The one deliberate behaviour change from TabContent.tsx:646
// (`onStatusChanged={(newStatus) => setFieldValues({ ...fieldValues, status: newStatus })}`):
// a status change here patches + invalidates the qk.entity cache instead of
// a useState copy, per this sub-project's central rule that server state
// lives only in React Query.
export function LifecycleStatusSection({
  projectId,
  module,
  entityId,
  mongoId,
  entityIdLabel,
  status,
  entityType,
  onError,
}: LifecycleStatusSectionProps): JSX.Element {
  const queryClient = useQueryClient();

  const handleStatusChanged = (newStatus: string): void => {
    const key = qk.entity(projectId, module, entityId);
    queryClient.setQueryData<Record<string, unknown>>(key, (old) => ({ ...(old ?? {}), status: newStatus }));
    queryClient.invalidateQueries({ queryKey: key });
  };

  return (
    <LifecycleStatus
      entityId={mongoId}
      entityIdLabel={entityIdLabel}
      status={status}
      entityType={entityType}
      onStatusChanged={handleStatusChanged}
      onError={onError}
    />
  );
}

export default LifecycleStatusSection;
