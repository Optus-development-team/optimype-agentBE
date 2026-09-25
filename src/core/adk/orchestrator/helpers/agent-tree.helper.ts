import type { BaseAgent } from '@google/adk';

/**
 * @google/adk 0.1.3 calcula rootAgent antes de asignar parentAgent a los
 * subagentes. Al reanudar una sesion desde un subagente, una transferencia a
 * un agente hermano falla porque la busqueda empieza en el subagente actual.
 */
export function normalizeAgentTreeRoots(
  agent: BaseAgent,
  rootAgent: BaseAgent = agent,
): void {
  Object.defineProperty(agent, 'rootAgent', {
    value: rootAgent,
    writable: false,
    enumerable: true,
    configurable: true,
  });

  for (const subAgent of agent.subAgents) {
    normalizeAgentTreeRoots(subAgent, rootAgent);
  }
}

export function buildTenantSessionId(
  companyId: string,
  userId: string,
): string {
  return `${companyId}:${userId.replace(/\D/g, '')}`;
}
