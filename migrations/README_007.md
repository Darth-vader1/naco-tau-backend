# Migration 007: Student Networking & Directory Fields

## Overview
This migration adds social media fields, interests, privacy controls, and academic information to the students table to enable the Student Networking & Directory feature.

## What This Migration Does

### 1. Adds New Columns to `students` Table
- `twitter` (TEXT) - Twitter/X profile URL
- `instagram` (TEXT) - Instagram profile URL  
- `portfolio_url` (TEXT) - Personal website or portfolio URL
- `interests` (TEXT[]) - Array of student interests
- `year_of_study` (INTEGER) - Current year (100, 200, 300, 400, 500)
- `graduation_year` (INTEGER) - Expected graduation year
- `visibility` (TEXT) - Profile visibility setting (default: 'students-only')
  - Options: 'public', 'students-only', 'private'
- `privacy_settings` (JSONB) - Field-level privacy controls
  - Default: `{"show_email": false, "show_phone": false, "show_matric": false}`

### 2. Creates Performance Indexes
- `idx_students_visibility` - For filtering by visibility
- `idx_students_year` - For filtering by year of study
- `idx_students_skills_gin` - GIN index for array searches on skills
- `idx_students_interests_gin` - GIN index for array searches on interests
- `idx_students_department` - For filtering by department
- `idx_students_status_visibility` - Composite index for common queries

### 3. Updates Row Level Security (RLS)
- Creates `students_directory_read` policy
- Allows authenticated students to view other active students' profiles based on visibility settings
- Students can always view their own profile
- Private profiles are only visible to the owner and admins

### 4. Migrates Existing Data
- Sets default `visibility` to 'students-only' for existing records
- Sets default `privacy_settings` for existing records

## How to Run

### Option 1: Using NPM Script (Recommended)
```bash
cd backend
npm run migrate:007
```

### Option 2: Using Node Directly
```bash
cd backend
node scripts/migrate-007.js
```

### Option 3: Manual SQL Execution
1. Open Supabase SQL Editor
2. Copy the contents of `007_add_student_networking_fields.sql`
3. Execute the SQL

## Prerequisites

- Node.js 16+ installed
- Backend `.env` file configured with:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
- Existing `students` table (from previous migrations)

## Expected Output

```
🚀 Running Migration 007: Student Networking & Directory Fields
📡 Connected to: https://your-project.supabase.co

📝 Found X SQL statements to execute

⚙️  Altering students table...
   ✅ Success
📊 Creating index: idx_students_visibility...
   ✅ Success
📊 Creating index: idx_students_year...
   ✅ Success
...

============================================================
📊 Migration Summary:
   ✅ Successful: X
   ⏭️  Skipped: Y
   ❌ Errors: 0
============================================================

🔍 Verifying migration...
✅ Found 8/8 new columns:
   • twitter
   • instagram
   • portfolio_url
   • interests
   • year_of_study
   • graduation_year
   • visibility
   • privacy_settings

🎉 Migration 007 completed successfully!

📋 Next Steps:
   1. Update backend API endpoints (Phase 2)
   2. Update frontend forms (Phase 3)
   3. Test the new features
```

## Rollback

If you need to rollback this migration:

```bash
cd backend
psql $DATABASE_URL -f migrations/007_rollback_student_networking_fields.sql
```

Or use Supabase SQL Editor to run `007_rollback_student_networking_fields.sql`

**⚠️ WARNING**: Rollback will permanently delete all data in the new columns!

## Verification

After running the migration, verify it worked:

### Check Columns
```sql
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'students' 
AND column_name IN ('twitter', 'instagram', 'portfolio_url', 'interests', 
                    'year_of_study', 'graduation_year', 'visibility', 'privacy_settings');
```

Expected: 8 rows returned

### Check Indexes
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'students' 
AND indexname LIKE 'idx_students_%';
```

Expected: At least 6 indexes related to students

### Check RLS Policy
```sql
SELECT policyname, permissive, roles, qual 
FROM pg_policies 
WHERE tablename = 'students' 
AND policyname = 'students_directory_read';
```

Expected: 1 row returned

### Test Query
```sql
-- Should return at least default values
SELECT id, visibility, privacy_settings 
FROM students 
LIMIT 5;
```

Expected: All rows have `visibility = 'students-only'` and privacy_settings JSONB

## Troubleshooting

### Error: "relation 'students' does not exist"
**Solution**: Run the main migration first: `npm run migrate`

### Error: "column already exists"
**Solution**: Migration was partially run. Check which columns exist and manually add missing ones, or rollback and re-run.

### Error: "permission denied"
**Solution**: Ensure you're using `SUPABASE_SERVICE_KEY` (not SUPABASE_ANON_KEY) in your .env file.

### Error: "function exec_sql does not exist"
**Solution**: Your Supabase project may not have the exec_sql RPC function. Execute the SQL file directly in Supabase SQL Editor instead.

## Testing After Migration

1. **Check existing students**:
   ```sql
   SELECT COUNT(*) as total_students,
          COUNT(visibility) as with_visibility,
          COUNT(privacy_settings) as with_privacy
   FROM students;
   ```
   All counts should be equal.

2. **Insert a test student** (optional):
   ```sql
   INSERT INTO students (
     user_id, email, first_name, last_name, name, matric_no, department,
     twitter, instagram, portfolio_url, interests, year_of_study, 
     graduation_year, visibility
   ) VALUES (
     gen_random_uuid(), 'test@example.com', 'Test', 'User', 'Test User',
     'TAU/TEST/001', 'Computer Science',
     'https://twitter.com/testuser', 'https://instagram.com/testuser',
     'https://testuser.com', ARRAY['Web Dev', 'AI/ML'], 300, 2026,
     'students-only'
   );
   ```

3. **Test directory query** (simulating API endpoint):
   ```sql
   SELECT id, name, department, year_of_study, visibility
   FROM students
   WHERE status = 'active' AND visibility != 'private'
   LIMIT 10;
   ```

## Related Files

- Main migration: `007_add_student_networking_fields.sql`
- Rollback: `007_rollback_student_networking_fields.sql`
- Runner script: `scripts/migrate-007.js`
- Spec document: `../.kiro/specs/student-networking/`

## Next Steps After Migration

1. ✅ **Phase 1 Complete**: Database is ready
2. 🔜 **Phase 2**: Implement backend API endpoints
   - `GET /api/students/directory` - Student directory with filters
   - `GET /api/students/:id/profile` - View student profile
   - `PUT /api/students/me` - Update profile (extend existing)
3. 🔜 **Phase 3**: Update frontend profile management
4. 🔜 **Phase 4**: Build student directory UI
5. 🔜 **Phase 5**: Add profile view modal
6. 🔜 **Phase 6**: Testing and polish

---

**Migration Version**: 007  
**Created**: 2026-08-03  
**Status**: Ready to Run ✅
