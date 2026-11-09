import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../useDebouncedValue';

// Wave B-2 (workbench search) — EntitySearchPanel must not fire one
// request per keystroke. `useDebouncedValue` is the generic primitive that
// makes that possible: it echoes back its input, but only after `delayMs`
// has passed with no further change, exactly the semantics a query key
// needs so react-query only refetches once typing settles. Kept generic
// (not baked into the search component) so it's testable in isolation from
// react-query/MSW entirely.

describe('useDebouncedValue', () => {
    it('returns the initial value immediately', () => {
        const { result } = renderHook(() => useDebouncedValue('a', 300));
        expect(result.current).toBe('a');
    });

    it('does not update until delayMs has elapsed with no further change', () => {
        jest.useFakeTimers();
        const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
            initialProps: { value: 't' },
        });

        rerender({ value: 'te' });
        rerender({ value: 'tes' });
        rerender({ value: 'test' });

        // Still the very first value -- none of the intermediate keystrokes
        // have had 300ms of silence yet.
        expect(result.current).toBe('t');

        act(() => {
            jest.advanceTimersByTime(299);
        });
        expect(result.current).toBe('t');

        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(result.current).toBe('test');

        jest.useRealTimers();
    });

    it('restarts the timer on every change (a burst of keystrokes collapses to one update)', () => {
        jest.useFakeTimers();
        const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
            initialProps: { value: '' },
        });

        'search'.split('').forEach((_, i) => {
            rerender({ value: 'search'.slice(0, i + 1) });
            act(() => {
                jest.advanceTimersByTime(100); // less than delayMs between keystrokes
            });
        });
        // Only 100ms of silence has elapsed since the last keystroke.
        expect(result.current).toBe('');

        act(() => {
            jest.advanceTimersByTime(300);
        });
        expect(result.current).toBe('search');

        jest.useRealTimers();
    });
});
