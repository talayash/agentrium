import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SettingsNav } from './SettingsNav';
import { PageHeader, PageHeaderModeContext, subTitle } from './SettingRow';

afterEach(cleanup);

const section = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('SettingsNav', () => {
  it('lists the nine sections and marks the active one', () => {
    render(<SettingsNav active="terminal" onSelect={() => {}} query="" onQueryChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(9);
    expect(section('Terminal').getAttribute('aria-current')).toBe('page');
    expect(section('General').hasAttribute('aria-current')).toBe(false);
  });

  it('dims sections without a search hit and counts hits on the rest', () => {
    render(
      <SettingsNav
        active="general"
        onSelect={() => {}}
        query="paste"
        onQueryChange={() => {}}
        highlightedPages={new Set(['terminal.behavior', 'terminal.pastes'])}
      />,
    );
    const terminal = section('Terminal');
    expect(terminal.className).not.toContain('opacity-40');
    expect(terminal.textContent).toBe('Terminal2');
    expect(section('Editor').className).toContain('opacity-40');
  });

  it('selects a section on click and forwards typing to the query', () => {
    const onSelect = vi.fn();
    const onQueryChange = vi.fn();
    render(<SettingsNav active="general" onSelect={onSelect} query="" onQueryChange={onQueryChange} />);
    fireEvent.click(section('Git'));
    expect(onSelect).toHaveBeenCalledWith('git');
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'font' } });
    expect(onQueryChange).toHaveBeenCalledWith('font');
  });
});

describe('PageHeader modes', () => {
  it('strips the group prefix when stacked under a section', () => {
    expect(subTitle('Terminal - Behavior')).toBe('Behavior');
    expect(subTitle('Agents & Keys')).toBe('Agents & Keys');
    render(
      <PageHeaderModeContext.Provider value="sub">
        <PageHeader title="Version Control - Git" />
      </PageHeaderModeContext.Provider>,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Git');
  });

  it('renders nothing when the section header already names the page', () => {
    const { container } = render(
      <PageHeaderModeContext.Provider value="hidden">
        <PageHeader title="Keymap" />
      </PageHeaderModeContext.Provider>,
    );
    expect(container.innerHTML).toBe('');
  });
});
