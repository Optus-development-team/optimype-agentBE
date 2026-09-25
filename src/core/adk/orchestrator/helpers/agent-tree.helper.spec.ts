import type { BaseAgent } from '@google/adk';
import {
  buildTenantSessionId,
  normalizeAgentTreeRoots,
} from './agent-tree.helper';

function stubAgent(name: string, subAgents: BaseAgent[] = []): BaseAgent {
  return {
    name,
    rootAgent: undefined,
    subAgents,
  } as unknown as BaseAgent;
}

describe('ADK agent tree helpers', () => {
  it('asigna el orquestador raiz a todos los subagentes', () => {
    const appointment = stubAgent('appointment_client_agent');
    const knowledge = stubAgent('knowledge_agent');
    const root = stubAgent('general_client_orchestrator', [
      appointment,
      knowledge,
    ]);

    normalizeAgentTreeRoots(root);

    expect(root.rootAgent).toBe(root);
    expect(appointment.rootAgent).toBe(root);
    expect(knowledge.rootAgent).toBe(root);
  });

  it('construye una sesion estable por empresa y telefono', () => {
    expect(
      buildTenantSessionId(
        'e40203b8-d8e8-4951-8ac0-840f81596047',
        '+591 64252325',
      ),
    ).toBe('e40203b8-d8e8-4951-8ac0-840f81596047:59164252325');
  });
});
