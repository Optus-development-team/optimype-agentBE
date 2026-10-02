import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { SupplierPaymentsConfig } from './supplier-payments.config';
import type {
  PasskeyRecord,
  SupplierPaymentRequest,
  SupplierPaymentStatus,
} from './supplier-payments.types';

interface StoreFile {
  version: 1;
  requests: SupplierPaymentRequest[];
  passkeys: PasskeyRecord[];
}

/**
 * Persistencia local (archivo JSON) de las órdenes a proveedores y de las
 * passkeys registradas. Sobrevive a reinicios del backend en modo desarrollo;
 * si el disco no es escribible sigue funcionando en memoria.
 */
@Injectable()
export class SupplierPaymentsStore {
  private readonly logger = new Logger(SupplierPaymentsStore.name);
  private readonly requests = new Map<string, SupplierPaymentRequest>();
  private readonly passkeys = new Map<string, PasskeyRecord>();
  private readonly filePath: string | null;

  constructor(config: SupplierPaymentsConfig) {
    // SUPPLIER_PAYMENTS_STORE_PATH=memory desactiva el archivo.
    this.filePath =
      config.storePath && config.storePath !== 'memory'
        ? resolve(config.storePath)
        : null;
    this.load();
  }

  getRequest(id: string): SupplierPaymentRequest | null {
    const request = this.requests.get(id);
    return request ? structuredClone(request) : null;
  }

  listByStatus(status: SupplierPaymentStatus): SupplierPaymentRequest[] {
    return [...this.requests.values()]
      .filter((request) => request.status === status)
      .map((request) => structuredClone(request));
  }

  saveRequest(request: SupplierPaymentRequest): SupplierPaymentRequest {
    const saved = { ...request, updatedAt: new Date().toISOString() };
    this.requests.set(saved.id, structuredClone(saved));
    this.persist();
    return saved;
  }

  getPasskey(credentialId: string): PasskeyRecord | null {
    const passkey = this.passkeys.get(credentialId);
    return passkey ? { ...passkey } : null;
  }

  passkeysFor(companyId: string, phone: string): PasskeyRecord[] {
    return [...this.passkeys.values()]
      .filter((p) => p.companyId === companyId && p.phone === phone)
      .map((p) => ({ ...p }));
  }

  savePasskey(passkey: PasskeyRecord): void {
    this.passkeys.set(passkey.credentialId, { ...passkey });
    this.persist();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile;
      for (const request of data.requests ?? [])
        this.requests.set(request.id, request);
      for (const passkey of data.passkeys ?? [])
        this.passkeys.set(passkey.credentialId, passkey);
      this.logger.log(
        `Órdenes a proveedores cargadas: ${this.requests.size} · passkeys: ${this.passkeys.size}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(
          `No se pudo leer ${this.filePath}: ${(error as Error).message}`,
        );
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const data: StoreFile = {
      version: 1,
      requests: [...this.requests.values()],
      passkeys: [...this.passkeys.values()],
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar ${this.filePath}; se mantiene en memoria: ${(error as Error).message}`,
      );
    }
  }
}
