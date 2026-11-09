import { useEffect, useState } from 'react';

// Generic debounce primitive. Used by EntitySearchPanel (workbench search,
// Wave B-2) to turn keystrokes into a settled query value: the raw input
// text is kept in the caller's own useState (a UI concern, not "server
// results"), and this hook derives a second value that only changes once
// `delayMs` has passed with no further update -- exactly what a
// react-query `queryKey` needs so typing doesn't fire one request per
// keystroke. No lodash/debounce dependency: `lodash` sits in node_modules
// only as a transitive dependency (not in package.json), so
// Components/Lists/issueSearch.tsx importing `lodash/debounce` directly
// is a phantom-dependency risk this hook avoids by using plain
// setTimeout/clearTimeout instead.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
}

export default useDebouncedValue;
