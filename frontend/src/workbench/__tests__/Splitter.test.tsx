import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Splitter, { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from '../Splitter';

describe('Splitter', () => {
  it('exposes role="separator" with a vertical orientation', () => {
    render(<Splitter width={300} onCommit={jest.fn()} />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('does not commit during drag -- only on mouseup', () => {
    const onCommit = jest.fn();
    render(<Splitter width={300} onCommit={onCommit} />);
    const handle = screen.getByRole('separator');

    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 340 });
    fireEvent.mouseMove(document, { clientX: 380 });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.mouseUp(document);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(380);
  });

  it('clamps the committed width to the 220px minimum', () => {
    const onCommit = jest.fn();
    render(<Splitter width={300} onCommit={onCommit} />);
    const handle = screen.getByRole('separator');

    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: -1000 }); // huge leftward drag
    fireEvent.mouseUp(document);

    expect(onCommit).toHaveBeenCalledWith(MIN_PANEL_WIDTH);
  });

  it('clamps the committed width to the 640px maximum', () => {
    const onCommit = jest.fn();
    render(<Splitter width={300} onCommit={onCommit} />);
    const handle = screen.getByRole('separator');

    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 5000 }); // huge rightward drag
    fireEvent.mouseUp(document);

    expect(onCommit).toHaveBeenCalledWith(MAX_PANEL_WIDTH);
  });

  it('ArrowRight widens the panel by a fixed step, clamped to the maximum', () => {
    const onCommit = jest.fn();
    render(<Splitter width={MAX_PANEL_WIDTH - 10} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith(MAX_PANEL_WIDTH);
  });

  it('ArrowLeft narrows the panel by a fixed step, clamped to the minimum', () => {
    const onCommit = jest.fn();
    render(<Splitter width={MIN_PANEL_WIDTH + 10} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenCalledWith(MIN_PANEL_WIDTH);
  });
});
