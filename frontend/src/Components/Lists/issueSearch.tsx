import React, { useState, useEffect, useCallback } from 'react';
import { TextField, Autocomplete, CircularProgress } from '@mui/material';
import { getWCDefectList, getWCReqList, getWCTCList } from '../../api/apiCalls';
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

  // Debounce function to limit API calls when typing. debounce() wraps the callback
  // in a stateful closure; the linter cannot see through it to infer deps, and
  // re-creating this on every dependency change would reset the debounce timer,
  // changing runtime behavior. Intentionally created once (empty dep array).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedFetchUsers = useCallback(
    debounce(async (value, issueType) => {
      if (value) {
        try {
          setLoading(true);
          let nusersList = [];
          if (issueType === 2) {
            nusersList = await getWCReqList(value);
          }
          if (issueType === 1) {
            nusersList = await getWCTCList(value);
          }
          if (issueType === 5) {
            nusersList = await getWCDefectList(value);
          }

          const usersList = mapIssuesToOption(nusersList, issueType);
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

  // Effect to reset inputValue and selectedValue when selectedIssueType changes
  useEffect(() => {
    // Clear the input and selected value when the selected issue type changes
    setInputValue(''); // Clear inputValue
    setSelectedValue(null); // Clear selectedValue
    setOptions([]); // Clear the options
  }, [props.selectedIssueType]); // Triggered when selectedIssueType changes

  // Fetch new options when inputValue changes
  useEffect(() => {
    if (props.selectedIssueType && inputValue) {
      debouncedFetchUsers(inputValue, props.selectedIssueType);
    }
  }, [inputValue, debouncedFetchUsers, props.selectedIssueType]);

  const handleSelection = async (event: React.ChangeEvent<{}>, newValue: string | null) => {
    const selectedOption = options.find((option) => option.label === newValue);
    if (selectedOption) {
      setSelectedValue(selectedOption);
      props.setDestIssue(selectedOption);
    }
  };

  const mapIssuesToOption = (issueList: any[], issueType: number): OptionType[] => {
    if (issueType === 2) {
      return issueList.map((issue) => ({
        label: issue.reqId + ' : ' + issue.requirementSummary,
        value: issue.reqId,
      }));
    }
    if (issueType === 1) {
      return issueList.map((issue) => ({
        label: issue.TestCaseId + ' : ' + issue.TestCaseSummary,
        value: issue.TestCaseId,
      }));
    }
    if (issueType === 5) {
      return issueList.map((issue) => ({
        label: issue.defectId + ' : ' + issue.summary,
        value: issue.defectId,
      }));
    }
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
          placeholder="Search issue"
          // WP-046: this field had no `label` and no accessible name at
          // all -- an axe "label" violation. `inputProps` (lowercase,
          // native-element attributes), not `InputProps` (the Input
          // component wrapper, already used above for the loading
          // adornment) -- MUI does not forward a bare aria-label on
          // TextField itself down to the underlying <input> reliably (see
          // the same lesson learned the hard way on OutlinedInput in
          // folderStructure.tsx).
          inputProps={{ ...params.inputProps, 'aria-label': 'Search issue' }}
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
