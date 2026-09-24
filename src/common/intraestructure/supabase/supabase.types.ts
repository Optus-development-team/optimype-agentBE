export type DbJson = Record<string, unknown>;
export type DbTimestamp = string;
export type DbTimestamptz = string;

export type DbCompanyType = 'product' | 'service' | 'academy' | 'hybrid';
export type DbCompanyVertical = 'general' | 'academy' | 'salon';

export interface DbCompanyRow {
  id: string;
  name: string;
  company_type: DbCompanyType;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  currency_code: string | null;
  settings: DbJson;
  academy_json: DbJson;
  is_active: boolean;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  currency: string;
  branding: DbJson;
  payment_settings: DbJson;
  business_hours: DbJson;
  vertical: DbCompanyVertical;
  config: DbJson;
  whatsapp_admin_phone_ids: string[];
  whatsapp_display_phone_number: string | null;
  whatsapp_phone_id: string | null;
}

export type DbCompanyTenantRow = Pick<
  DbCompanyRow,
  | 'id'
  | 'name'
  | 'vertical'
  | 'timezone'
  | 'config'
  | 'whatsapp_admin_phone_ids'
  | 'whatsapp_display_phone_number'
  | 'whatsapp_phone_id'
>;

export type DbUserRole = 'ADMIN' | 'CLIENT';

export interface DbCompanyUserRow {
  id: string;
  company_id: string;
  phone: string | null;
  role: DbUserRole;
  embedding: unknown | null;
  created_at: DbTimestamptz;
  email: string | null;
  is_phone_verified: boolean;
  alias: string | null;
  last_login_at: DbTimestamptz | null;
  updated_at: DbTimestamptz;
  permissions: DbJson;
}

export type DbCompanyUserRoleRow = Pick<DbCompanyUserRow, 'role' | 'phone'>;
export type DbCompanyUserPhoneRow = Pick<DbCompanyUserRow, 'phone'>;

export interface DbVerificationCodeRow {
  id: string;
  phone: string;
  code: string;
  expires_at: DbTimestamptz;
  verified: boolean;
  created_at: DbTimestamptz;
}

export interface DbAdkSessionRow {
  session_id: string;
  company_id: string;
  context_data: DbJson;
  updated_at: DbTimestamptz;
}

export interface DbSearchPublicKnowledgeRow {
  entity_name: string;
  data: DbJson;
}
