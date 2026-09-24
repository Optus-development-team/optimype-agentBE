const { NestFactory } = require('@nestjs/core');
const { google } = require('googleapis');
const { AppModule } = require('../dist/app.module');
const {
  SupabaseService,
} = require('../dist/common/intraestructure/supabase/supabase.service');
const { OAuthService } = require('../dist/features/auth/oauth.service');
const {
  AppointmentsService,
} = require('../dist/features/calendar/appointments.service');

const TEST_KEY = 'calendar-e2e-v1';

function localDateAfter(days) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const db = app.get(SupabaseService);
    const appointments = app.get(AppointmentsService);
    const oauth = app.get(OAuthService);

    const setup = await db.query(`
      SELECT c.id AS company_id,
             cs.id AS staff_id,
             item.id AS service_id,
             user_row.id AS user_id
        FROM companies c
        JOIN company_integrations integration
          ON integration.company_id = c.id
         AND integration.provider = 'GOOGLE_CALENDAR'
         AND integration.is_active = TRUE
        JOIN company_staff cs
          ON cs.company_id = c.id AND cs.is_active = TRUE
        JOIN staff_catalog_services staff_service
          ON staff_service.staff_id = cs.id AND staff_service.is_active = TRUE
        JOIN catalog_items item
          ON item.id = staff_service.catalog_item_id
         AND item.metadata->>'seed_key' = 'calendar-functional-v1'
        JOIN LATERAL (
          SELECT id FROM company_users
           WHERE company_id = c.id
           ORDER BY is_phone_verified DESC, created_at
           LIMIT 1
        ) user_row ON TRUE
       ORDER BY integration.updated_at DESC NULLS LAST
       LIMIT 1
    `);
    const target = setup[0];
    if (!target) {
      throw new Error('Ejecuta primero npm run calendar:db:seed');
    }

    let appointment = (
      await db.query(
        `SELECT * FROM appointments
          WHERE company_id = $1
            AND metadata->>'test_key' = $2
            AND scheduled_end > NOW()
            AND status <> 'cancelled'
          ORDER BY created_at DESC LIMIT 1`,
        [target.company_id, TEST_KEY],
      )
    )[0];

    if (!appointment) {
      let selectedSlot;
      for (let offset = 1; offset <= 14 && !selectedSlot; offset++) {
        const slots = await appointments.availability({
          companyId: target.company_id,
          date: localDateAfter(offset),
          serviceId: target.service_id,
          staffId: target.staff_id,
        });
        selectedSlot = slots[0];
      }
      if (!selectedSlot)
        throw new Error('No hay horarios disponibles en 14 días');

      appointment = await appointments.create(
        {
          companyId: target.company_id,
          title: '[OPTUS E2E] Reserva funcional',
          description:
            'Creada por npm run calendar:e2e para validar DB y Google Calendar',
          start: selectedSlot.start,
          end: selectedSlot.end,
          customerPhone: '+59170000000',
          customerName: 'Cliente Prueba Calendar',
          staffId: target.staff_id,
          serviceId: target.service_id,
          targetCalendarId: 'primary',
          metadata: { test_key: TEST_KEY },
        },
        {
          kind: 'admin',
          companyId: target.company_id,
          userId: target.user_id,
          role: 'ADMIN',
        },
      );
    }

    if (appointment.sync_status !== 'synced') {
      throw new Error(
        `La cita quedó con sync_status=${appointment.sync_status}: ${appointment.sync_error_message || 'sin detalle'}`,
      );
    }
    if (!appointment.google_calendar_event_id) {
      throw new Error('La cita no recibió google_calendar_event_id');
    }

    const auth = await oauth.getClient(target.company_id);
    const calendar = google.calendar({ version: 'v3', auth });
    const remote = await calendar.events.get({
      calendarId: appointment.target_calendar_id || 'primary',
      eventId: appointment.google_calendar_event_id,
    });

    // La prueba valida la cola, pero no debe enviar recordatorios reales.
    await db.query(
      `UPDATE appointment_notifications
          SET status = 'cancelled', updated_at = NOW()
        WHERE appointment_id = $1
          AND status IN ('pending', 'processing')`,
      [appointment.id],
    );

    console.log(
      JSON.stringify(
        {
          success: true,
          appointmentId: appointment.id,
          syncStatus: appointment.sync_status,
          scheduledStart: appointment.scheduled_start,
          googleEventId: remote.data.id,
          googleEventStatus: remote.data.status,
          googleHtmlLink: remote.data.htmlLink,
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
  console.error(`Calendar E2E failed: ${error.message}`);
  process.exitCode = 1;
});
