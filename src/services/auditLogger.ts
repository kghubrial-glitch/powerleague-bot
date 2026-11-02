import { AuditRepository } from '../database/repositories/auditRepository';

export class AuditLogger {
  constructor(private audit: AuditRepository) {}

  admin(action: string, administratorId: string, details?: Record<string, unknown>): void {
    this.audit.log({
      action,
      administrator_id: administratorId,
      details: details ? JSON.stringify(details) : null,
    });
  }

  adminTarget(
    action: string,
    administratorId: string,
    targetId: string | null,
    matchId: string | null,
    details?: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      administrator_id: administratorId,
      target_id: targetId,
      match_id: matchId,
      details: details ? JSON.stringify(details) : null,
    });
  }

  system(action: string, details?: Record<string, unknown>): void {
    this.audit.log({
      action,
      administrator_id: null,
      details: details ? JSON.stringify(details) : null,
    });
  }
}