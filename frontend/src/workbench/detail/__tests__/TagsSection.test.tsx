import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagsSection } from '../TagsSection';

// WP-F05b -- free-form tags. Normalisation is enforced in the model (see
// each schema's `tags` setter, WP-F05a), but the editor normalises too so a
// user sees what will be stored before they commit, rather than watching
// the server rewrite their input.
it('renders each tag as a chip', () => {
  render(<TagsSection module={1} entityId="TC-1" tags={['regression', 'smoke']} onChange={jest.fn()} />);
  expect(screen.getByText('regression')).toBeInTheDocument();
  expect(screen.getByText('smoke')).toBeInTheDocument();
});

it('adds a tag, lowercased and trimmed', () => {
  const onChange = jest.fn();
  render(<TagsSection module={1} entityId="TC-1" tags={[]} onChange={onChange} />);
  const input = screen.getByRole('textbox', { name: /add a tag/i });
  fireEvent.change(input, { target: { value: '  Regression ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith(['regression']);
});

it('refuses a tag containing a space, and says why', () => {
  const onChange = jest.fn();
  render(<TagsSection module={1} entityId="TC-1" tags={[]} onChange={onChange} />);
  const input = screen.getByRole('textbox', { name: /add a tag/i });
  fireEvent.change(input, { target: { value: 'not one token' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText(/one token/i)).toBeInTheDocument();
});

it('does not add a duplicate', () => {
  const onChange = jest.fn();
  render(<TagsSection module={1} entityId="TC-1" tags={['smoke']} onChange={onChange} />);
  const input = screen.getByRole('textbox', { name: /add a tag/i });
  fireEvent.change(input, { target: { value: 'SMOKE' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
});

it('removes a tag', () => {
  const onChange = jest.fn();
  render(<TagsSection module={1} entityId="TC-1" tags={['regression', 'smoke']} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /remove regression/i }));
  expect(onChange).toHaveBeenCalledWith(['smoke']);
});

it('offers no add or remove affordance when read-only', () => {
  // RBAC: a viewer sees tags but cannot change them. permissions.ts is
  // UI decoration -- the server is the boundary -- but the control must
  // still not invite an action that will 403.
  render(<TagsSection module={1} entityId="TC-1" tags={['regression']} onChange={jest.fn()} readOnly />);
  expect(screen.getByText('regression')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: /add a tag/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
});
