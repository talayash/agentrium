import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StructuredResult } from './StructuredResult';

afterEach(cleanup);

describe('StructuredResult', () => {
  it('renders table and bar chart', () => {
    const text = '| Name | Count |\n| --- | --- |\n| a | 1 |\n\n- x: 1\n- y: 2\n- z: 3';
    const { container } = render(<StructuredResult text={text} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByText('Name').tagName).toBe('TH');
    expect(container.querySelector('svg[role=img]')).not.toBeNull();
  });

  it('does not render raw html', () => {
    const { container } = render(<StructuredResult text={'hello <img src=x onerror=alert(1)> **bold**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
});
