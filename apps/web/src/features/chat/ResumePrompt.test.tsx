import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ResumePrompt } from './ResumePrompt';

describe('ResumePrompt', () => {
  it('renders the resume CTA when alive=false', () => {
    const { container } = render(
      <ResumePrompt webSessionId="s1" alive={false} onResume={() => {}} />,
    );
    expect(container.textContent).toMatch(/session ended/i);
    const button = container.querySelector('button.resume-prompt-button');
    expect(button).toBeTruthy();
    expect(button!.textContent).toBe('Resume');
  });

  it('renders nothing when alive=true', () => {
    const { container } = render(
      <ResumePrompt webSessionId="s1" alive={true} onResume={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('clicking Resume calls onResume()', () => {
    const onResume = vi.fn();
    const { container } = render(
      <ResumePrompt webSessionId="s1" alive={false} onResume={onResume} />,
    );
    const button = container.querySelector('button.resume-prompt-button');
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
