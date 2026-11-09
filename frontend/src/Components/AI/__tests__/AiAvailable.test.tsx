import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiAvailable } from '../AiAvailable';
import { getAiAvailability } from '../../../api/aiApi';

// WP-166 follow-up -- AI is switched off for the closed beta at deployment
// level, and every /api/v1/ai/* call answers 403. GET /ai/availability
// (aiService, the peer's half) reports why; this wrapper decides what the
// UI does with that:
//   available                         -> render the feature
//   unavailable, actionable by admin  -> say why, in place of the feature
//   unavailable, NOT actionable       -> render nothing at all
//   loading or the probe itself fails -> render nothing (fail closed: never
//                                        flash a control that would 403)
jest.mock('../../../api/aiApi', () => ({ getAiAvailability: jest.fn() }));
const mockGetAiAvailability = getAiAvailability as jest.Mock;

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiAvailable>
        <button>Generate test cases (AI)</button>
      </AiAvailable>
    </QueryClientProvider>,
  );
}

describe('<AiAvailable>', () => {
  it('renders the feature when AI is available', async () => {
    mockGetAiAvailability.mockResolvedValue({
      available: true, reason: null, message: null, actionableByProjectAdmin: false, enabledUntil: null,
    });
    renderGate();
    expect(await screen.findByRole('button', { name: /generate test cases/i })).toBeInTheDocument();
  });

  it('renders nothing when AI is off for the whole deployment (nobody here can turn it on)', async () => {
    mockGetAiAvailability.mockResolvedValue({
      available: false,
      reason: 'deployment-disabled',
      message: 'AI features are turned off for this deployment and cannot be enabled per project.',
      actionableByProjectAdmin: false,
      enabledUntil: null,
    });
    const { container } = renderGate();
    await waitFor(() => expect(mockGetAiAvailability).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument();
  });

  it('explains instead of offering the feature when a project admin can turn it on', async () => {
    mockGetAiAvailability.mockResolvedValue({
      available: false,
      reason: 'project-disabled',
      message: 'AI is turned off for this project. A project admin can turn it on in Settings.',
      actionableByProjectAdmin: true,
      enabledUntil: null,
    });
    renderGate();
    expect(await screen.findByText(/a project admin can turn it on/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate test cases/i })).not.toBeInTheDocument();
  });

  it('renders nothing while the answer is loading, and nothing if the probe fails', async () => {
    mockGetAiAvailability.mockRejectedValue(new Error('network'));
    const { container } = renderGate();
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(mockGetAiAvailability).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
