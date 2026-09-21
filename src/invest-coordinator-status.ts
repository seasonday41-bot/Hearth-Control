export type V2CoordinatorDisplayTone = 'monitoring' | 'ready' | 'working' | 'blocked' | 'error';

export interface V2CoordinatorDisplay {
  label: 'Monitoring' | 'READY' | 'Risk checking' | 'Executing' | 'Blocked' | 'Error';
  tone: V2CoordinatorDisplayTone;
}

const MONITORING: V2CoordinatorDisplay = { label: 'Monitoring', tone: 'monitoring' };

/**
 * Keeps the Invest status calm without changing the coordinator state machine.
 * Frequent cycle states deliberately collapse to Monitoring; only states that
 * need the operator's attention receive a distinct label.
 */
export const getV2CoordinatorDisplay = (
  coordinator: LiveV2CoordinatorState | null | undefined,
): V2CoordinatorDisplay => {
  if (!coordinator || coordinator.state === 'unavailable' || coordinator.state === 'error' || coordinator.last_error) {
    return { label: 'Error', tone: 'error' };
  }

  if (coordinator.state === 'blocked' || coordinator.state === 'risk_rejected' || coordinator.circuit_breaker_active) {
    return { label: 'Blocked', tone: 'blocked' };
  }

  if (coordinator.state === 'executing') {
    return { label: 'Executing', tone: 'working' };
  }

  if (coordinator.state === 'risk_checking') {
    return { label: 'Risk checking', tone: 'working' };
  }

  const hasReadySetup = Object.values(coordinator.strategies).some((strategy) => strategy.state === 'READY');
  if (coordinator.state === 'ready_monitor_only' || hasReadySetup) {
    return { label: 'READY', tone: 'ready' };
  }

  return MONITORING;
};
