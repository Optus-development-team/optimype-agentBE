import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import { WhatsAppMessagingService } from '../messaging/features/whatsapp/services/whatsapp.messaging.service';
import { BookingPolicyService } from './booking-policy.service';
import type { AppointmentRecord } from './calendar.types';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class AppointmentNotificationService {
  private readonly logger = new Logger(AppointmentNotificationService.name);

  constructor(
    private readonly db: SupabaseService,
    private readonly whatsapp: WhatsAppMessagingService,
    private readonly policies: BookingPolicyService,
  ) {}

  async scheduleCreated(
    appointment: AppointmentRecord,
    options: { sendConfirmation?: boolean } = {},
  ): Promise<void> {
    const context = await this.context(appointment.id, appointment.company_id);
    if (!context?.customer_phone) return;
    const policy = await this.policies.get(appointment.company_id);
    const startKey = dayjs(appointment.scheduled_start).valueOf();
    if (options.sendConfirmation !== false) {
      await this.enqueue({
        appointment,
        type: 'confirmation',
        recipient: context.customer_phone,
        scheduledAt: new Date().toISOString(),
        dedupeKey: `confirmation:${appointment.id}:${startKey}`,
      });
    }
    for (const minutes of policy.remindersMinutes) {
      const scheduledAt = dayjs(appointment.scheduled_start).subtract(
        minutes,
        'minute',
      );
      if (scheduledAt.isAfter(dayjs())) {
        await this.enqueue({
          appointment,
          type: minutes >= 1440 ? 'reminder_24h' : 'reminder_2h',
          recipient: context.customer_phone,
          scheduledAt: scheduledAt.toISOString(),
          dedupeKey: `reminder:${minutes}:${appointment.id}:${startKey}`,
        });
      }
    }
    if (context.staff_phone) {
      await this.enqueue({
        appointment,
        type: 'staff_assigned',
        recipient: context.staff_phone,
        scheduledAt: new Date().toISOString(),
        dedupeKey: `staff-assigned:${appointment.id}:${startKey}`,
      });
    }
  }

  async scheduleRescheduled(appointment: AppointmentRecord): Promise<void> {
    await this.cancelPendingReminders(appointment.id);
    const context = await this.context(appointment.id, appointment.company_id);
    if (context?.customer_phone) {
      await this.enqueue({
        appointment,
        type: 'rescheduled',
        recipient: context.customer_phone,
        scheduledAt: new Date().toISOString(),
        dedupeKey: `rescheduled:${appointment.id}:${appointment.booking_version ?? 1}`,
      });
    }
    await this.scheduleCreated(appointment, { sendConfirmation: false });
  }

  async scheduleCancelled(appointment: AppointmentRecord): Promise<void> {
    await this.cancelPendingReminders(appointment.id);
    const context = await this.context(appointment.id, appointment.company_id);
    for (const recipient of [context?.customer_phone, context?.staff_phone]) {
      if (!recipient) continue;
      await this.enqueue({
        appointment,
        type: 'cancelled',
        recipient,
        scheduledAt: new Date().toISOString(),
        dedupeKey: `cancelled:${appointment.id}:${recipient}`,
      });
    }
  }

  async processDue(limit = 50): Promise<number> {
    const claimed = await this.db.query<{ id: string }>(
      `WITH due AS (
         SELECT id FROM appointment_notifications
          WHERE (status = 'pending' AND scheduled_at <= NOW())
             OR (status = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes')
          ORDER BY scheduled_at
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE appointment_notifications n
          SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         FROM due WHERE n.id = due.id RETURNING n.id`,
      [limit],
    );
    for (const item of claimed) await this.deliver(item.id);
    return claimed.length;
  }

  async reconcileRecent(limit = 200): Promise<number> {
    const appointments = await this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments
        WHERE updated_at >= NOW() - INTERVAL '24 hours'
          AND (
            (status = 'confirmed' AND scheduled_start > NOW()) OR
            status = 'cancelled'
          )
        ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    for (const appointment of appointments) {
      try {
        if (appointment.status === 'cancelled') {
          await this.scheduleCancelled(appointment);
        } else {
          await this.scheduleCreated(appointment, {
            sendConfirmation: (appointment.booking_version ?? 1) <= 1,
          });
        }
      } catch (error) {
        this.logger.error(
          `Reconciliación ${appointment.id}: ${(error as Error).message}`,
        );
      }
    }
    return appointments.length;
  }

  private async deliver(notificationId: string): Promise<void> {
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      appointment_id: string;
      notification_type: string;
      recipient: string;
      attempts: number;
      max_attempts: number;
      title: string | null;
      service_name: string | null;
      staff_name: string | null;
      company_name: string;
      company_address: string | null;
      scheduled_start: Date | string;
      timezone: string | null;
      whatsapp_phone_id: string | null;
      appointment_status: string;
    }>(
      `SELECT n.id, n.company_id, n.appointment_id, n.notification_type,
              n.recipient, n.attempts, n.max_attempts, a.title,
              ci.name AS service_name,
              NULLIF(TRIM(cs.first_name || ' ' || COALESCE(cs.last_name, '')), '') AS staff_name,
              c.name AS company_name, c.address AS company_address,
              a.scheduled_start, a.status::text AS appointment_status,
              c.timezone, c.whatsapp_phone_id
         FROM appointment_notifications n
         JOIN appointments a ON a.id = n.appointment_id
         JOIN companies c ON c.id = n.company_id
         LEFT JOIN catalog_items ci ON ci.id = a.catalog_item_id
         LEFT JOIN company_staff cs ON cs.id = a.staff_id
        WHERE n.id = $1 LIMIT 1`,
      [notificationId],
    );
    const item = rows[0];
    if (!item) return;
    if (
      !['pending', 'confirmed'].includes(item.appointment_status) &&
      item.notification_type !== 'cancelled'
    ) {
      await this.db.query(
        `UPDATE appointment_notifications SET status = 'cancelled',
                updated_at = NOW() WHERE id = $1`,
        [item.id],
      );
      return;
    }
    try {
      await this.whatsapp.sendText(item.recipient, this.message(item), {
        companyId: item.company_id,
        phoneNumberId: item.whatsapp_phone_id ?? undefined,
      });
      await this.db.query(
        `UPDATE appointment_notifications
            SET status = 'sent', sent_at = NOW(), last_error = NULL,
                updated_at = NOW() WHERE id = $1`,
        [item.id],
      );
    } catch (error) {
      const finalAttempt = item.attempts >= item.max_attempts;
      await this.db.query(
        `UPDATE appointment_notifications
            SET status = $2,
                scheduled_at = CASE WHEN $2 = 'pending'
                  THEN NOW() + make_interval(mins => LEAST(60, POWER(2, attempts)::int))
                  ELSE scheduled_at END,
                last_error = LEFT($3, 2000), updated_at = NOW()
          WHERE id = $1`,
        [
          item.id,
          finalAttempt ? 'failed' : 'pending',
          (error as Error).message,
        ],
      );
      this.logger.error(`Notificación ${item.id}: ${(error as Error).message}`);
    }
  }

  private message(item: {
    notification_type: string;
    title: string | null;
    service_name: string | null;
    staff_name: string | null;
    company_name: string;
    company_address: string | null;
    scheduled_start: Date | string;
    timezone: string | null;
  }): string {
    const when = dayjs(item.scheduled_start)
      .tz(item.timezone || 'America/La_Paz')
      .format('DD/MM/YYYY HH:mm');
    const service = item.service_name || item.title || 'tu cita';
    const staff = item.staff_name ? ` con ${item.staff_name}` : '';
    const address = item.company_address ? `\n📍 ${item.company_address}` : '';
    const messages: Record<string, string> = {
      confirmation: `✅ Tu ${service}${staff} quedó confirmada para el ${when}.${address}`,
      reminder_24h: `🔔 Te recordamos que tienes ${service}${staff} el ${when}.${address}`,
      reminder_2h: `⏰ Tu ${service}${staff} comienza el ${when}.${address}\nSi necesitas cambiarla, responde a este mensaje.`,
      rescheduled: `📅 Tu ${service}${staff} fue reprogramada para el ${when}.${address}`,
      cancelled: `❌ Tu ${service} del ${when} fue cancelada. Si quieres, puedo ayudarte a reservar otro horario.`,
      staff_assigned: `📌 Se te asignó ${service} para el ${when}.`,
    };
    return (
      messages[item.notification_type] ||
      `Actualización de cita: ${service}, ${when}.`
    );
  }

  private async enqueue(params: {
    appointment: AppointmentRecord;
    type: string;
    recipient: string;
    scheduledAt: string;
    dedupeKey: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO appointment_notifications (
         company_id, appointment_id, notification_type, recipient,
         scheduled_at, dedupe_key
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        params.appointment.company_id,
        params.appointment.id,
        params.type,
        params.recipient,
        params.scheduledAt,
        params.dedupeKey,
      ],
    );
  }

  private async cancelPendingReminders(appointmentId: string): Promise<void> {
    await this.db.query(
      `UPDATE appointment_notifications SET status = 'cancelled', updated_at = NOW()
        WHERE appointment_id = $1 AND status = 'pending'
          AND notification_type IN ('confirmation', 'reminder_24h', 'reminder_2h', 'staff_assigned')`,
      [appointmentId],
    );
  }

  private async context(appointmentId: string, companyId: string) {
    const rows = await this.db.query<{
      customer_phone: string | null;
      staff_phone: string | null;
    }>(
      `SELECT c.phone AS customer_phone, cs.phone AS staff_phone
         FROM appointments a
         LEFT JOIN customers c ON c.id = a.customer_id
         LEFT JOIN company_staff cs ON cs.id = a.staff_id
        WHERE a.id = $1 AND a.company_id = $2 LIMIT 1`,
      [appointmentId, companyId],
    );
    return rows[0] ?? null;
  }
}
