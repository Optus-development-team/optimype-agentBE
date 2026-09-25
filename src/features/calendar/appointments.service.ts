import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import dayjs from 'dayjs';
import { AppointmentAuditService } from './appointment-audit.service';
import { AppointmentNotificationService } from './appointment-notification.service';
import { AppointmentRepository } from './appointment.repository';
import { AvailabilityService } from './availability.service';
import { BookingPolicyService } from './booking-policy.service';
import {
  CalendarAccessService,
  type CalendarActor,
} from './calendar-access.service';
import { CalendarSyncService } from './calendar-sync.service';
import type {
  AppointmentRecord,
  AvailabilitySlot,
  CreateAppointmentInput,
} from './calendar.types';

type AppointmentFilter = 'all' | 'upcoming' | 'past' | 'cancelled';

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly appointments: AppointmentRepository,
    private readonly sync: CalendarSyncService,
    private readonly availabilityService: AvailabilityService,
    private readonly policies: BookingPolicyService,
    private readonly access: CalendarAccessService,
    private readonly audit: AppointmentAuditService,
    private readonly notifications: AppointmentNotificationService,
  ) {}

  async create(
    input: CreateAppointmentInput,
    actor?: CalendarActor,
  ): Promise<AppointmentRecord> {
    if (actor && actor.kind !== 'admin' && input.targetCalendarId) {
      throw new ForbiddenException(
        'Solo un administrador puede elegir el calendario de destino',
      );
    }
    const customerPhone = actor
      ? this.access.assertCustomerPhone(actor, input.customerPhone)
      : input.customerPhone;
    const selected = await this.availabilityService.selectStaffForRange({
      companyId: input.companyId,
      start: input.start,
      end: input.end,
      serviceId: input.serviceId,
      staffId: input.staffId,
    });
    let appointment: AppointmentRecord;
    try {
      appointment = await this.appointments.create({
        ...input,
        customerPhone,
        staffId: selected.staffId,
        bufferMinutes: selected.bufferMinutes,
        createdByUserId: actor?.userId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        (error as Error).message === 'APPOINTMENT_SLOT_UNAVAILABLE' ||
        code === '23P01'
      ) {
        throw new BadRequestException(
          'El horario acaba de ser ocupado; elige otro',
        );
      }
      throw error;
    }
    await this.runSideEffects([
      {
        name: 'auditoría de creación',
        execute: () =>
          this.audit.record({
            companyId: input.companyId,
            appointmentId: appointment.id,
            action: 'created',
            actor,
            newState: appointment,
          }),
      },
      {
        name: 'notificaciones de creación',
        execute: () => this.notifications.scheduleCreated(appointment),
      },
    ]);
    return this.syncSafely(appointment);
  }

  async cancel(
    companyId: string,
    appointmentId: string,
    reason?: string,
    actor?: CalendarActor,
  ): Promise<AppointmentRecord> {
    const current = await this.requireAppointment(companyId, appointmentId);
    if (current.status === 'cancelled') return current;
    this.assertActive(current, 'cancelar');
    if (actor) {
      await this.access.assertCanModifyAppointment(actor, appointmentId);
      await this.assertCustomerCancellationAllowed(actor, current);
    }
    const appointment = await this.appointments.cancel(
      companyId,
      appointmentId,
      reason,
      actor?.userId,
    );
    if (!appointment) throw new NotFoundException('Cita no encontrada');
    await this.runSideEffects([
      {
        name: 'auditoría de cancelación',
        execute: () =>
          this.audit.record({
            companyId,
            appointmentId,
            action: 'cancelled',
            actor,
            previousState: current,
            newState: appointment,
            metadata: { reason },
          }),
      },
      {
        name: 'notificaciones de cancelación',
        execute: () => this.notifications.scheduleCancelled(appointment),
      },
    ]);
    return this.syncSafely(appointment);
  }

  async reschedule(
    companyId: string,
    appointmentId: string,
    start: string,
    end: string,
    actor?: CalendarActor,
  ): Promise<AppointmentRecord> {
    const current = await this.requireAppointment(companyId, appointmentId);
    this.assertActive(current, 'reprogramar');
    if (actor) {
      await this.access.assertCanModifyAppointment(actor, appointmentId);
      await this.assertCustomerCancellationAllowed(actor, current);
    }
    const selected = await this.availabilityService.selectStaffForRange({
      companyId,
      start,
      end,
      serviceId: current.catalog_item_id ?? undefined,
      staffId: current.staff_id ?? undefined,
      excludeAppointmentId: appointmentId,
    });
    let updated: AppointmentRecord | null;
    try {
      updated = await this.appointments.updateSchedule(
        companyId,
        appointmentId,
        start,
        end,
        selected.bufferMinutes,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        (error as Error).message === 'APPOINTMENT_SLOT_UNAVAILABLE' ||
        code === '23P01'
      ) {
        throw new BadRequestException(
          'El horario acaba de ser ocupado; elige otro',
        );
      }
      throw error;
    }
    if (!updated) throw new NotFoundException('Cita no encontrada');
    await this.runSideEffects([
      {
        name: 'auditoría de reprogramación',
        execute: () =>
          this.audit.record({
            companyId,
            appointmentId,
            action: 'rescheduled',
            actor,
            previousState: current,
            newState: updated,
          }),
      },
      {
        name: 'notificaciones de reprogramación',
        execute: () => this.notifications.scheduleRescheduled(updated),
      },
    ]);
    return this.syncSafely(updated);
  }

  async rescheduleKeepingDuration(
    companyId: string,
    appointmentId: string,
    start: string,
    actor?: CalendarActor,
  ): Promise<AppointmentRecord> {
    const current = await this.requireAppointment(companyId, appointmentId);
    const duration = dayjs(current.scheduled_end).diff(
      dayjs(current.scheduled_start),
      'minute',
    );
    return this.reschedule(
      companyId,
      appointmentId,
      start,
      dayjs(start).add(Math.max(duration, 1), 'minute').toISOString(),
      actor,
    );
  }

  async updateStatus(
    companyId: string,
    appointmentId: string,
    status: 'confirmed' | 'completed' | 'no_show',
    actor: CalendarActor,
  ): Promise<AppointmentRecord> {
    if (actor.kind === 'customer') {
      throw new ForbiddenException(
        'Solo el negocio puede actualizar el estado',
      );
    }
    await this.access.assertCanModifyAppointment(actor, appointmentId);
    const current = await this.requireAppointment(companyId, appointmentId);
    if (current.status === status) return current;
    const allowed =
      (current.status === 'pending' && status === 'confirmed') ||
      (current.status === 'confirmed' &&
        ['completed', 'no_show'].includes(status));
    if (!allowed) {
      throw new BadRequestException(
        `No se puede cambiar una cita ${current.status} a ${status}`,
      );
    }
    const updated = await this.appointments.updateStatus(
      companyId,
      appointmentId,
      status,
    );
    if (!updated) throw new NotFoundException('Cita no encontrada');
    await this.runSideEffects([
      {
        name: 'auditoría de estado',
        execute: () =>
          this.audit.record({
            companyId,
            appointmentId,
            action: `status_${status}`,
            actor,
            previousState: current,
            newState: updated,
          }),
      },
    ]);
    return this.syncSafely(updated);
  }

  list(
    actor: CalendarActor,
    filter: AppointmentFilter = 'upcoming',
    limit = 20,
    requestedPhone?: string,
  ): Promise<AppointmentRecord[]> {
    if (actor.kind === 'admin') {
      return requestedPhone
        ? this.appointments.listForCustomer(
            actor.companyId,
            requestedPhone,
            filter,
            limit,
          )
        : this.appointments.listForCompany(actor.companyId, filter, limit);
    }
    if (actor.kind === 'staff' && actor.staffId) {
      return this.appointments.listForStaff(
        actor.companyId,
        actor.staffId,
        filter,
        limit,
      );
    }
    const phone = this.access.assertCustomerPhone(actor, requestedPhone);
    return this.appointments.listForCustomer(
      actor.companyId,
      phone,
      filter,
      limit,
    );
  }

  listForCustomer(
    companyId: string,
    phone: string,
    filter: AppointmentFilter = 'upcoming',
    limit = 20,
  ): Promise<AppointmentRecord[]> {
    return this.appointments.listForCustomer(companyId, phone, filter, limit);
  }

  availability(params: {
    companyId: string;
    date: string;
    serviceId?: string;
    staffId?: string;
    durationMinutes?: number;
    excludeAppointmentId?: string;
  }): Promise<AvailabilitySlot[]> {
    return this.availabilityService.list(params);
  }

  listBookableServices(companyId: string) {
    return this.appointments.listBookableServices(companyId);
  }

  listActiveStaff(companyId: string, serviceId?: string) {
    return this.appointments.listActiveStaff(companyId, serviceId);
  }

  async resolveActiveStaff(
    companyId: string,
    staffName: string,
    serviceId?: string,
  ): Promise<{ id: string; name: string; specialty: string | null }> {
    const requested = this.normalizeSearchText(staffName);
    const staff = await this.appointments.listActiveStaff(companyId, serviceId);
    const exact = staff.find(
      (candidate) => this.normalizeSearchText(candidate.name) === requested,
    );
    if (exact) return exact;
    const partial = staff.filter((candidate) => {
      const name = this.normalizeSearchText(candidate.name);
      return name.includes(requested) || requested.includes(name);
    });
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new BadRequestException(
        `El profesional es ambiguo. Opciones: ${partial.map((item) => item.name).join(', ')}`,
      );
    }
    throw new NotFoundException(`Profesional no disponible: ${staffName}`);
  }

  async resolveBookableService(
    companyId: string,
    serviceName: string,
  ): Promise<{ id: string; name: string; durationMinutes: number | null }> {
    const requested = this.normalizeSearchText(serviceName);
    const services = await this.appointments.listBookableServices(companyId);
    const exact = services.find(
      (service) => this.normalizeSearchText(service.name) === requested,
    );
    if (exact) {
      return {
        id: exact.id,
        name: exact.name,
        durationMinutes: exact.duration_minutes,
      };
    }

    const partial = services.filter((service) => {
      const candidate = this.normalizeSearchText(service.name);
      return candidate.includes(requested) || requested.includes(candidate);
    });
    if (partial.length === 1) {
      return {
        id: partial[0].id,
        name: partial[0].name,
        durationMinutes: partial[0].duration_minutes,
      };
    }
    if (partial.length > 1) {
      throw new BadRequestException(
        `El servicio es ambiguo. Opciones: ${partial.map((item) => item.name).join(', ')}`,
      );
    }
    throw new NotFoundException(`Servicio no disponible: ${serviceName}`);
  }

  async findForCustomer(params: {
    companyId: string;
    phone: string;
    date?: string;
    time?: string;
  }): Promise<AppointmentRecord> {
    const appointment = await this.appointments.findCustomerAppointment(params);
    if (!appointment)
      throw new NotFoundException('No encontré una cita que coincida');
    return appointment;
  }

  private async assertCustomerCancellationAllowed(
    actor: CalendarActor,
    appointment: AppointmentRecord,
  ): Promise<void> {
    if (actor.kind !== 'customer') return;
    const policy = await this.policies.get(actor.companyId);
    if (
      dayjs(appointment.scheduled_start).diff(dayjs(), 'minute') <
      policy.cancellationNoticeMinutes
    ) {
      throw new ForbiddenException(
        `La cita requiere ${policy.cancellationNoticeMinutes} minutos de anticipación para cambios`,
      );
    }
  }

  private async requireAppointment(
    companyId: string,
    appointmentId: string,
  ): Promise<AppointmentRecord> {
    const appointment = await this.appointments.findById(
      companyId,
      appointmentId,
    );
    if (!appointment) throw new NotFoundException('Cita no encontrada');
    return appointment;
  }

  private assertActive(appointment: AppointmentRecord, action: string): void {
    if (!['pending', 'confirmed'].includes(appointment.status)) {
      throw new BadRequestException(
        `No se puede ${action} una cita con estado ${appointment.status}`,
      );
    }
  }

  private async runSideEffects(
    effects: Array<{ name: string; execute: () => Promise<void> }>,
  ): Promise<void> {
    for (const effect of effects) {
      try {
        await effect.execute();
      } catch (error) {
        this.logger.error(`${effect.name}: ${(error as Error).message}`);
      }
    }
  }

  private async syncSafely(
    appointment: AppointmentRecord,
  ): Promise<AppointmentRecord> {
    try {
      return await this.sync.syncAppointmentToGoogle(
        appointment.company_id,
        appointment.id,
      );
    } catch {
      return (
        (await this.appointments.findById(
          appointment.company_id,
          appointment.id,
        )) ?? appointment
      );
    }
  }

  private normalizeSearchText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }
}
