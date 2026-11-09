import React, { useState, useEffect, useCallback } from 'react';
import { TextField, Autocomplete, CircularProgress } from '@mui/material';
import { getUserDirectory, updateDefect, updateTestExecution } from '../../api/apiCalls';
import debounce from 'lodash/debounce';

interface OptionType {
  label: string;
  value: string;
}

const DynamicAutocomplete = (props) => {
  const [options, setOptions] = useState<OptionType[]>([]);
  const [inputValue, setInputValue] = useState<string>(props.userName || ''); // Set initial value from props
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedValue, setSelectedValue] = useState<OptionType | null>(null);

  // Fetch initial value on component mount
  useEffect(() => {
    const fetchInitialValue = async () => {
      try {
        const initialUsersList = await getUserDirectory();
        const mappedUsers = mapUsersToOptions(initialUsersList);
        setOptions(mappedUsers);

        // Find initial user based on props.userName
        const initialUser = mappedUsers.find((user) => user.label === props.userName);
        if (initialUser) {
          setSelectedValue(initialUser); // Set the initial selected value
        }
      } catch (error) {
        console.error('Error fetching initial user:', error);
      }
    };

    fetchInitialValue();
  }, [props.userName]);

  // Debounce function to limit API calls when typing. debounce() wraps the callback
  // in a stateful closure; the linter cannot see through it to infer deps, and
  // re-creating this on every dependency change would reset the debounce timer,
  // changing runtime behavior. Intentionally created once (empty dep array).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedFetchUsers = useCallback(
    debounce(async (value) => {
      if (value) {
        try {
          setLoading(true);
          // Filters the project's directory client-side instead of issuing a
          // per-keystroke username search. The old search hit
          // /api/v1/users/kcUsers?id=<typed text>, which matched usernames by
          // SUBSTRING across the whole realm -- so typing one letter
          // enumerated a slice of every tenant's users. A project's member
          // list is small enough to filter in the browser, and it is the only
          // set a user can legitimately be assigned from anyway.
          const directory = await getUserDirectory();
          const needle = String(value).toLowerCase();
          const usersList = mapUsersToOptions(directory).filter((u) =>
            String(u.label || '').toLowerCase().includes(needle)
          );
          setOptions(usersList);
        } catch (error) {
          console.error('Error fetching users:', error);
        } finally {
          setLoading(false);
        }
      } else {
        setOptions([]);
      }
    }, 300),
    []
  );

  useEffect(() => {
    if (inputValue !== props.userName) {
      debouncedFetchUsers(inputValue);
    }
  }, [inputValue, debouncedFetchUsers, props.userName]);

  const handleSelection = async (event: React.ChangeEvent<{}>, newValue: string | null) => {
    if (props.moduleId === 3) {
      if (newValue) {
        try {
          const selectedOption = options.find((option) => option.label === newValue);
          if (selectedOption) {
            setSelectedValue(selectedOption);
            const sendVal = { assignedTo: selectedOption.value };
            await updateTestExecution(sendVal, props.nteId);
          }
        } catch (error) {
          console.error('Error updating test execution:', error);
        }
      }
    }
    if (props.moduleId === 5) {
      const selectedOption = options.find((option) => option.label === newValue);
      if (selectedOption) {
        setSelectedValue(selectedOption);
        const sendVal = { assignedTo: selectedOption.value };
        if (!props.defecnId.includes('newDefect')) {
          await updateDefect(props.defectId, sendVal);
        }
        props.updateUser(selectedOption);
      }
    }
  };

  const mapUsersToOptions = (users: any[]): OptionType[] => {
    return users.filter((user) => !user.username.includes('service-account')).map((user) => ({
      label: user.username,
      value: user.id,
    }));
  };

  return (
    <Autocomplete
      freeSolo={false}
      sx={{ width: '100%', height: '70%' }}
      options={options.map((option) => option.label)}
      loading={loading}
      value={selectedValue?.label || ''}
      inputValue={inputValue}
      onInputChange={(event, newInputValue) => {
        setInputValue(newInputValue); // Update input value as user types
      }}
      onChange={handleSelection}
      renderInput={(params) => (
        <TextField
          sx={{ width: '100%', height: '50%' }}
          {...params}
          size="small"
          variant="outlined"
          // D6 (docs/superpowers/PRODUCT_GAP_REGISTER.md) -- this control
          // rendered with no accessible name at all (no label, no
          // aria-label/aria-labelledby), failing axe's
          // "aria-input-field-name" rule. `displayName` is the field's own
          // FieldGrid-supplied label (e.g. "Assigned To") threaded through
          // by UserDropDownField below, rather than a hardcoded string, so
          // this stays correct for any field this control is ever wired to.
          // Merged with `params.inputProps` (not replaced) to keep the
          // combobox role attributes (aria-autocomplete/aria-expanded/etc.)
          // MUI's Autocomplete already computed for this input.
          inputProps={{
            ...params.inputProps,
            'aria-label': props.displayName || 'Assignee',
          }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress color="inherit" size={20} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
};

export default DynamicAutocomplete;
