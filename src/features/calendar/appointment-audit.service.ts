import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import type { CalendarActor } from './calendar-access.service';

@Injectable()
export class AppointmentAuditService {
  constructor(private readonly db: SupabaseService) {}

  async record(params: {
    companyId: string;
    appointmentId?: string;
    action: string;
    actor?: CalendarActor;
    previousState?: unknown;
    newState?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const actor = params.actor;
    await this.db.query(
      `INSERT INTO appointment_audit_logs (
         company_id, appointment_id, action, actor_type, actor_user_id,
         actor_staff_id, actor_phone, previous_state, new_state, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        params.companyId,
        params.appointmentId ?? null,
        params.action,
        actor?.kind ?? 'system',
        actor?.userId ?? null,
        actor?.staffId ?? null,
        actor?.phone ?? null,
        params.previousState ? JSON.stringify(params.previousState) : null,
        params.newState ? JSON.stringify(params.newState) : null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
  }
}
