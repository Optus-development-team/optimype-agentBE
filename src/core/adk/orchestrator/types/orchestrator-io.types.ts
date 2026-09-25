import { z } from 'zod';
import { zodObjectToSchema } from '@google/adk';
import type {
  CompanyVertical,
  UserRole,
} from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';

export interface OrchestratorInput {
  message: {
    text: string;
    referredProduct?: {
      catalogId: string;
      productRetailerId: string;
    };
  };
  sender: {
    id: string;
    name?: string;
    role?: UserRole;
  };
  tenant: {
    id: string;
    name: string;
    vertical: CompanyVertical;
    timezone: string;
    config: Record<string, unknown>;
  };
}

const OrchestratorInputSchema = z.object({
  message: z.object({
    text: z.string(),
    referredProduct: z
      .object({
        catalogId: z.string(),
        productRetailerId: z.string(),
      })
      .optional(),
  }),
  sender: z.object({
    id: z.string(),
    name: z.string().optional(),
    role: z.string().optional(),
  }),
  tenant: z.object({
    id: z.string(),
    name: z.string(),
    vertical: z.string(),
    timezone: z.string(),
    config: z.any(),
  }),
});

export const ORCHESTRATOR_INPUT_SCHEMA = zodObjectToSchema(
  OrchestratorInputSchema,
);
