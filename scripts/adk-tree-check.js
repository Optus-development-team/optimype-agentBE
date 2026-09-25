const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { GeneralClientOrchestratorService } = require('../dist/core/adk/orchestrator/verticals/general/general-client.orchestrator');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const service = app.get(GeneralClientOrchestratorService);
    const root = service.orchestratorAgent;
    console.log(
      JSON.stringify(
        {
          root: root?.name,
          subAgents: (root?.subAgents || []).map((agent) => ({
            name: agent.name,
            parent: agent.parentAgent?.name,
          })),
          appointmentFound:
            root?.findAgent('appointment_client_agent')?.name || null,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
