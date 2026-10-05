// Script to check the dynamic level system status
const { supabase } = require('../config/supabase');

async function checkLevelSystem() {
  console.log('='.repeat(60));
  console.log('DYNAMIC LEVEL SYSTEM - DIAGNOSTIC CHECK');
  console.log('='.repeat(60));
  
  try {
    // Check 1: Does the view exist?
    console.log('\n📊 Check 1: Checking if students_with_current_level view exists...');
    const { data: viewData, error: viewError } = await supabase
      .from('students_with_current_level')
      .select('*')
      .limit(1);
    
    if (viewError) {
      console.error('❌ View does NOT exist or has an error:');
      console.error(viewError);
      console.log('\n🔧 ACTION REQUIRED: Run migration 012 in Supabase SQL Editor');
      console.log('   File: backend/migrations/012_replace_level_with_year_of_study.sql');
      return;
    }
    
    console.log('✅ View exists and is accessible');
    
    // Check 2: Sample student data
    console.log('\n📊 Check 2: Fetching sample students...');
    const { data: students, error: studentsError } = await supabase
      .from('students_with_current_level')
      .select('*')
      .limit(5);
    
    if (studentsError) {
      console.error('❌ Error fetching students:', studentsError);
      return;
    }
    
    console.log(`✅ Found ${students.length} students\n`);
    
    // Check 3: Analyze data
    console.log('📊 Check 3: Analyzing student data...\n');
    
    if (students.length === 0) {
      console.log('⚠️  No students in database');
      return;
    }
    
    let hasYearOfStudy = 0;
    let hasCurrentLevel = 0;
    let hasGraduationYear = 0;
    let isGraduated = 0;
    
    console.log('Sample Students:');
    console.log('-'.repeat(100));
    
    students.forEach((s, i) => {
      console.log(`\nStudent ${i + 1}:`);
      console.log(`  Name:            ${s.first_name} ${s.last_name}`);
      console.log(`  Matric:          ${s.matric_no || 'N/A'}`);
      console.log(`  Department:      ${s.department || 'N/A'}`);
      console.log(`  Year of Study:   ${s.year_of_study || 'NULL ❌'}`);
      console.log(`  Graduation Year: ${s.graduation_year || 'NULL'}`);
      console.log(`  Current Level:   ${s.current_level || 'NULL ❌'}`);
      console.log(`  Is Graduated:    ${s.is_graduated ? '🎓 Yes' : 'No'}`);
      
      if (s.year_of_study) hasYearOfStudy++;
      if (s.current_level) hasCurrentLevel++;
      if (s.graduation_year) hasGraduationYear++;
      if (s.is_graduated) isGraduated++;
    });
    
    console.log('\n' + '-'.repeat(100));
    console.log('\n📊 Summary Statistics:');
    console.log(`  Students with year_of_study:  ${hasYearOfStudy}/${students.length}`);
    console.log(`  Students with current_level:  ${hasCurrentLevel}/${students.length}`);
    console.log(`  Students with graduation_year: ${hasGraduationYear}/${students.length}`);
    console.log(`  Graduated students:            ${isGraduated}/${students.length}`);
    
    // Check 4: Get total count
    console.log('\n📊 Check 4: Getting total student count...');
    const { count, error: countError } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true });
    
    if (!countError) {
      console.log(`✅ Total students in database: ${count}`);
    }
    
    // Check 5: Diagnose issues
    console.log('\n' + '='.repeat(60));
    console.log('DIAGNOSIS:');
    console.log('='.repeat(60));
    
    if (hasYearOfStudy === 0) {
      console.log('\n❌ ISSUE FOUND: No students have year_of_study populated');
      console.log('\n🔧 SOLUTION:');
      console.log('   1. Check if migration 012 was run completely');
      console.log('   2. Check actual matric number formats in database');
      console.log('   3. May need to update extract_year_from_matric() function');
      console.log('\n📝 To check matric formats, run in Supabase SQL Editor:');
      console.log('   SELECT DISTINCT matric_no FROM students LIMIT 10;');
    } else if (hasCurrentLevel === 0) {
      console.log('\n❌ ISSUE FOUND: Students have year_of_study but current_level is NULL');
      console.log('\n🔧 SOLUTION:');
      console.log('   Check the view calculation logic in migration 012');
      console.log('   The CASE statement may need adjustment');
    } else {
      console.log('\n✅ SYSTEM IS WORKING!');
      console.log('   - Migration 012 was run successfully');
      console.log('   - year_of_study is populated');
      console.log('   - current_level is calculated correctly');
      console.log('   - Backend and frontend should show levels correctly');
      console.log('\n💡 If admin dashboard still shows "Not Set":');
      console.log('   - Backend may not be deployed to Railway yet');
      console.log('   - Frontend may not be deployed to Netlify yet');
      console.log('   - Check browser cache (hard refresh)');
    }
    
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    console.error('\n❌ Unexpected error:', error);
  }
}

// Run the check
checkLevelSystem()
  .then(() => {
    console.log('\n✅ Diagnostic complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Diagnostic failed:', error);
    process.exit(1);
  });
