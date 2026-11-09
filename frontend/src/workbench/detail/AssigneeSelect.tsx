import React from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { getUserDirectory } from '../../api/apiCalls';

// Picks a user to assign work to. `value`/`onChange` speak the Keycloak
// user id, which is what an execution's `assignedTo` stores (testPlan-
// ExecutionService's createTestExecution defaults it to the creator's
// token `sub`); the control shows the username.
//
// Not a reuse of Components/Lists/dropDownList.tsx's DynamicAutocomplete:
// that one is uncontrolled, matches its initial value by USERNAME while the
// stored value is an id (so a saved assignee never showed as selected), and
// persists by itself per module. This one only reports the choice; the
// caller decides how to save it.
//
// The whole directory comes from one cached query (kcUsers with an empty
// filter returns every user), shared by every picker on the page.

export interface DirectoryUser {
  id: string;
  username: string;
}

export function useUserDirectory() {
  return useQuery({
    queryKey: ['users', 'directory'] as const,
    queryFn: async (): Promise<DirectoryUser[]> => {
      const users = (await getUserDirectory()) as DirectoryUser[];
      return (users ?? []).filter((u) => u && !String(u.username).startsWith('service-account'));
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface AssigneeSelectProps {
  value?: string | null;
  onChange: (userId: string | null) => void;
  label: string;
  // Hide the visible label (e.g. inside a grid cell) but keep it as the
  // input's accessible name.
  hideLabel?: boolean;
  disabled?: boolean;
}

export function AssigneeSelect({ value, onChange, label, hideLabel, disabled }: AssigneeSelectProps): JSX.Element {
  const directory = useUserDirectory();
  const users = directory.data ?? [];
  // An id that isn't in the directory (deleted user, or a service account
  // that created the execution) still renders as something rather than a
  // blank box.
  const selected = value ? users.find((u) => u.id === value) ?? { id: value, username: value } : null;

  return (
    <Autocomplete
      fullWidth
      size="small"
      options={users}
      loading={directory.isLoading}
      disabled={disabled}
      value={directory.isLoading ? null : selected}
      getOptionLabel={(u) => u.username}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(_e, next) => onChange(next ? next.id : null)}
      // DataGrid treats Space/arrow keys inside a cell as grid navigation;
      // keep them for the text box when this sits in a cell.
      onKeyDown={(e) => e.stopPropagation()}
      renderInput={(params) => (
        <TextField
          {...params}
          label={hideLabel ? undefined : label}
          inputProps={{ ...params.inputProps, 'aria-label': label }}
        />
      )}
    />
  );
}

export default AssigneeSelect;
