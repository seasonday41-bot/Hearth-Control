// Six destinations, each one thing the operator actually does. Anything that is
// a mechanism rather than a destination -- X runs, the queue, pending tasks,
// runIds -- is detail inside Goals or evidence inside System, never navigation.
export type NavItem = 'Overview' | 'Goals' | 'Chat' | 'Invest' | 'Connections' | 'System';
export type GoalsTab = 'Goals' | 'Activity';
export type SystemTab = 'Workspace' | 'Permissions' | 'Activity' | 'Storage' | 'Updates';

/** Tab order for that destination. */
export const GOALS_TABS: GoalsTab[] = ['Goals', 'Activity'];

/** Tab order for that destination. */
export const SYSTEM_TABS: SystemTab[] = ['Workspace', 'Permissions', 'Activity', 'Storage', 'Updates'];
