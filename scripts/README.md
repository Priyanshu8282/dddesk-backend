# Database Migration & Maintenance Scripts

This directory contains standalone migration, backfill, and maintenance scripts.
Before running any script on a production database:
1. Create a full database backup (`mongodump`).
2. Run in a staging/test environment first.
3. Ensure the required `.env` file is present in `../.env`.

## Scripts Overview

| Script | Purpose |
| :--- | :--- |
| `add_library_sidebar.js` | Initializes or updates default sidebar navigation items for libraries. |
| `backfill_branch.js` | Backfills missing `branchId` references on legacy student and seat documents. |
| `backfill_receipt_tax.js` | Recalculates and backfills CGST/SGST/IGST breakdown for historical payment receipts. |
| `migrate-library-codes.js` | Ensures all library records have unique uppercase identifier codes. |
| `migrate_aadhaar_mask.js` | Masks legacy plaintext Aadhaar numbers to DPDP-compliant `XXXX XXXX ####` hashes. |
| `migrate_legacy_documents.js` | Migrates legacy document upload paths to the partitioned directory structure. |
| `migrate_tenant_roles_slugs.js` | Normalizes legacy role slugs for multitenant RBAC permission checks. |
| `provision_library_roles.js` | Seeds standard roles (Owner, Manager, Staff) for newly registered libraries. |
| `rearrange_sidebar.js` | Reorders sidebar modules according to updated navigation specs. |
| `report_duplicate_mobiles.js` | Audits and outputs any student/admin records sharing duplicate mobile numbers. |

## Running a Script
From the `backend` directory:
```bash
node scripts/<script_name>.js
```

