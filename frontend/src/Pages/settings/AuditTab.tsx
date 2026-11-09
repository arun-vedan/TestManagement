import { AuditLogPanel } from '../audit';

// WP-044 — Settings > Audit Log. Same relocation reasoning as
// ApiKeysTab.tsx: /audit was top-level only because no Settings shell
// existed yet. AuditLogPanel reads the active project via
// api/auditApi.ts's projectScopeHeaders().
export default function AuditTab() {
    return <AuditLogPanel />;
}
