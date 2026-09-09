import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPicker } from './AgentPicker';
import { setCustomAgentSpecs } from '../lib/agents';

beforeEach(() => setCustomAgentSpecs([]));

describe('AgentPicker', () => {
  it('renders built-ins, custom agents, and an Add agent tile', () => {
    setCustomAgentSpecs([{
      kind: 'custom:a1', displayName: 'OpenCode', binary: 'opencode', installUrl: '', installHint: '',
      defaultArgsHint: '', color: '#30C55E', monogram: 'OC', defaultArgs: [], resumeFlag: null, requiredEnv: [],
    }]);
    const onAdd = vi.fn();
    render(<AgentPicker value="claude" onChange={() => {}} onAddAgent={onAdd} />);
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('OC')).toBeTruthy();
    expect(screen.getByText('Local')).toBeTruthy();
    fireEvent.click(screen.getByText('Add agent'));
    expect(onAdd).toHaveBeenCalled();
  });

  it('uses a 3-column grid once there are more than four tiles', () => {
    setCustomAgentSpecs([{
      kind: 'custom:a1', displayName: 'X', binary: 'x', installUrl: '', installHint: '', defaultArgsHint: '',
      color: '#30C55E', monogram: 'X', defaultArgs: [], resumeFlag: null, requiredEnv: [],
    }]);
    const { container } = render(<AgentPicker value="claude" onChange={() => {}} onAddAgent={() => {}} />);
    expect(container.firstElementChild?.className).toContain('grid-cols-3');
  });
});
