import type { NavItem } from './nav';

/** One line per destination, shown under its title. */
export const PAGE_INTRO: Record<NavItem, string> = {
  Overview: 'Monitor your workspace and choose where to work next.',
  Goals: 'Everything you have asked Hearth to do, and how far it has got.',
  Chat: 'Talk to a local model. Nothing here creates a task or a durable job.',
  Invest: 'The XAUUSD demo trading subsystem.',
  Connections: 'Agents and services this workspace can reach.',
  System: 'Workspace, permissions, activity, storage, and updates.',
};
