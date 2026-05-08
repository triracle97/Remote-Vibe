import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { DirPicker } from './DirPicker';

describe('DirPicker', () => {
  it('renders ★ on the first row only', () => {
    const { getAllByTestId } = render(<DirPicker dirs={['/a', '/b', '/c']} onChange={() => {}} />);
    const rows = getAllByTestId('dir-picker-row');
    expect(rows).toHaveLength(3);
    const stars = rows.map((r) => r.querySelector('.dir-picker-primary')?.textContent ?? '');
    expect(stars[0]).toBe('★');
    expect(stars[1]).toBe('');
    expect(stars[2]).toBe('');
  });

  it('renders an empty placeholder when dirs is empty', () => {
    const { container } = render(<DirPicker dirs={[]} onChange={() => {}} />);
    expect(container.querySelector('.dir-picker-empty')).toBeTruthy();
  });

  it('▼ on row 0 swaps with row 1 → onChange([b, a, c])', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DirPicker dirs={['/a', '/b', '/c']} onChange={onChange} />,
    );
    const downButtons = container.querySelectorAll('button[aria-label^="move "][aria-label$=" down"]');
    expect(downButtons).toHaveLength(3);
    fireEvent.click(downButtons[0]!);
    expect(onChange).toHaveBeenCalledWith(['/b', '/a', '/c']);
  });

  it('▲ on row 0 is disabled; ▼ on last row is disabled', () => {
    const { container } = render(<DirPicker dirs={['/a', '/b']} onChange={() => {}} />);
    const upButtons = container.querySelectorAll('button[aria-label^="move "][aria-label$=" up"]');
    const downButtons = container.querySelectorAll(
      'button[aria-label^="move "][aria-label$=" down"]',
    );
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((upButtons[1] as HTMLButtonElement).disabled).toBe(false);
    expect((downButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((downButtons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('▲ on row 1 swaps with row 0 → onChange([b, a, c])', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DirPicker dirs={['/a', '/b', '/c']} onChange={onChange} />,
    );
    const upButtons = container.querySelectorAll('button[aria-label^="move "][aria-label$=" up"]');
    fireEvent.click(upButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(['/b', '/a', '/c']);
  });

  it('✕ on row 1 → onChange([a, c])', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DirPicker dirs={['/a', '/b', '/c']} onChange={onChange} />,
    );
    const removeButtons = container.querySelectorAll('button[aria-label^="remove "]');
    fireEvent.click(removeButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(['/a', '/c']);
  });

  it('typing + Enter in add input → onChange with appended dir', () => {
    const onChange = vi.fn();
    const { container } = render(<DirPicker dirs={['/a', '/b']} onChange={onChange} />);
    const input = container.querySelector('.dir-picker-add-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['/a', '/b', '/new']);
  });

  it('clicking the + button adds a dir', () => {
    const onChange = vi.fn();
    const { container } = render(<DirPicker dirs={['/a']} onChange={onChange} />);
    const input = container.querySelector('.dir-picker-add-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/zzz' } });
    const addBtn = container.querySelector('.dir-picker-add-button') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    fireEvent.click(addBtn);
    expect(onChange).toHaveBeenCalledWith(['/a', '/zzz']);
  });

  it('+ button is disabled when input is empty/whitespace', () => {
    const { container } = render(<DirPicker dirs={['/a']} onChange={() => {}} />);
    const addBtn = container.querySelector('.dir-picker-add-button') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('does not add a duplicate dir', () => {
    const onChange = vi.fn();
    const { container } = render(<DirPicker dirs={['/a', '/b']} onChange={onChange} />);
    const input = container.querySelector('.dir-picker-add-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks invalid rows with the is-invalid class', () => {
    const { container } = render(
      <DirPicker dirs={['/a', '/b']} onChange={() => {}} validity={[true, false]} />,
    );
    const rows = container.querySelectorAll('.dir-picker-row');
    expect(rows[0]?.classList.contains('is-invalid')).toBe(false);
    expect(rows[1]?.classList.contains('is-invalid')).toBe(true);
  });
});
