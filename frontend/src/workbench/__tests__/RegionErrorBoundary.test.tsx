import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RegionErrorBoundary from '../RegionErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <div>fine</div>;
}

describe('RegionErrorBoundary', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    // React logs the caught error to console.error (twice, in dev) --
    // expected noise for these tests, silenced and restored per-test.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('catches a throw from its child and names the region', () => {
    render(
      <RegionErrorBoundary region="panel">
        <Bomb shouldThrow />
      </RegionErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/source panel/i);
  });

  it('names each region distinctly', () => {
    render(
      <RegionErrorBoundary region="rail">
        <Bomb shouldThrow />
      </RegionErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/module rail/i);
  });

  it('"Try again" resets the boundary so the region can re-render', () => {
    const { rerender } = render(
      <RegionErrorBoundary region="detail">
        <Bomb shouldThrow />
      </RegionErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    // The underlying condition is fixed (as it would be after e.g. a
    // refetch), but the boundary itself still shows the fallback until
    // its own state is reset.
    rerender(
      <RegionErrorBoundary region="detail">
        <Bomb shouldThrow={false} />
      </RegionErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('renders children normally when there is no error', () => {
    render(
      <RegionErrorBoundary region="rail">
        <div>all good</div>
      </RegionErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
