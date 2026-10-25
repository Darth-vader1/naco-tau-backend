# NACOS TAU — Database Migrations Log

## How to apply a migration
1. Open your Supabase project → **SQL Editor**
2. Paste the contents of the migration file
3. Click **Run**
4. Record it in `schema_migrations`:
   ```sql
   INSERT INTO schema_migrations (filename, description)
   VALUES ('NNN_your_migration', 'What it does')
   ON CONFLICT (filename) DO NOTHING;
   ```

## Numbering convention
- Sequential: `NNN_description.sql` (zero-padded to 3 digits)
- Suffix letters for same-sprint additions: `012a_...`, `012b_...`
- Rollback scripts live in `migrations/rollbacks/` — **never run automatically**

---

## Migration Registry

| # | File | Description | Status |
|---|------|-------------|--------|
| 000 | `000_create_schema_migrations.sql` | Creates this tracking table + backfills history | ⬜ Run first if not applied |
| 001 | `001_payments_event_link.sql` | Link payments → events via `event_id` FK | ✅ Applied |
| 002 | `002_add_past_questions_payment_verification.sql` | Add `past_questions` and `payment_verification` tables | ✅ Applied |
| 003 | `003_fix_schema_mismatches.sql` | Fix schema mismatches from initial deploy | ✅ Applied |
| 004 | `004_align_payment_verification_schema.sql` | Align `payment_verification` columns with routes | ✅ Applied |
| 005 | `005_fix_academic_resources_schema.sql` | Fix `academic_resources` column constraints | ✅ Applied |
| 006 | `006_add_url_to_academic_resources.sql` | Add `url` column to `academic_resources` | ✅ Applied |
| 007 | `007_add_student_networking_fields.sql` | Add social/networking fields, visibility, privacy_settings to students | ✅ Applied |
| 008 | `008_add_snapchat_field.sql` | Add `snapchat` column to students | ✅ Applied |
| 009 | `009_add_events_composite_index.sql` | Composite index on events for query performance | ✅ Applied |
| 010 | `010_fix_audit_logs_rls.sql` | Fix Row Level Security on `audit_logs` | ✅ Applied |
| 011 | `011_add_level_to_students.sql` | Add static `level` column (100–400) to students | ✅ Applied |
| 011b | `011b_performance_indexes.sql` | Production performance indexes for all major tables | ✅ Applied |
| 012a | `012a_hackathons.sql` | Create `hackathons`, `hackathon_registrations`, `hackathon_submissions` tables | ✅ Applied |
| 012b | `012b_replace_level_with_year_of_study.sql` | Replace static level with `year_of_study` + `graduation_year` + computed view | ✅ Applied |
| 013a | `013a_fix_year_of_study_data.sql` | Re-extract and correct `year_of_study` from matric numbers | ✅ Applied |
| 013b | `013b_past_executives.sql` | Create `past_executives` Roll of Honour table | ✅ Applied |
| 013c | `013c_performance_indexes.sql` | Additional indexes incl. hackathons, payments transaction_id | ✅ Applied |
| 014 | `014_fix_level_display_issue.sql` | Fix `current_level` display calculation in view | ✅ Applied |
| 015 | `015_fix_all_student_data_issues.sql` | Bulk fix student data quality issues | ✅ Applied |
| 016 | `016_fix_double_encoded_skills_interests.sql` | Fix double-encoded JSON in skills/interests arrays | ✅ Applied |
| 017 | `017_add_payments_transaction_id_index.sql` | Index on `payments.transaction_id` for receipt lookups | ⬜ Pending — run in Supabase SQL Editor |

---

## Rollbacks
Rollback scripts are in `migrations/rollbacks/`. They are **manual-only** — never run
automatically. Before running a rollback, take a Supabase database backup.

| File | Rolls back |
|------|------------|
| `rollbacks/007_rollback_student_networking_fields.sql` | Migration 007 — removes networking columns from students |

---

## Duplicate numbering — resolved

The original repo had 5 duplicate migration numbers. They have been renamed:

| Old name | New name | Reason |
|----------|----------|--------|
| `011_performance_indexes.sql` | `011b_performance_indexes.sql` | Duplicate of 011 |
| `012_hackathons.sql` | `012a_hackathons.sql` | Duplicate of 012 |
| `012_replace_level_with_year_of_study.sql` | `012b_replace_level_with_year_of_study.sql` | Duplicate of 012 |
| `013_fix_year_of_study_data.sql` | `013a_fix_year_of_study_data.sql` | Duplicate of 013 |
| `013_past_executives.sql` | `013b_past_executives.sql` | Duplicate of 013 |
| `013_performance_indexes.sql` | `013c_performance_indexes.sql` | Duplicate of 013 |
