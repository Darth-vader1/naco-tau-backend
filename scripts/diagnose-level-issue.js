/**
 * Diagnostic script to check level display issue
 * Run with: node scripts/diagnose-level-issue.js
 */

require('dotenv').config();
const { supabase } = require('../config/supabase');

async function diagnoseLevelIssue() {
  console.log('🔍 Diagnosing Level Display Issue\n');
  console.log('=' .repeat(80));
  
  try {
    // Query students_with_current_level view
    console.log('\n📊 Querying students_with_current_level view...\n');
    
    const { data: students, error } = await supabase
      .from('students_with_current_level')
      .select('first_name, last_name, matric_no, year_of_study, current_level, is_graduated, graduation_year')
      .order('matric_no');
    
    if (error) {
      console.error('❌ Error querying view:', error.message);
      return;
    }
    
    console.log(`Found ${students.length} students\n`);
    console.log('=' .repeat(80));
    
    // Analyze data
    let correct = 0;
    let suspicious = 0;
    let noLevel = 0;
    
    const problems = [];
    
    students.forEach(s => {
      const name = `${s.first_name} ${s.last_name}`;
      
      if (!s.current_level) {
        noLevel++;
        problems.push({
          name,
          matric: s.matric_no,
          issue: 'No level calculated',
          year_of_study: s.year_of_study,
          current_level: s.current_level
        });
      } else if (s.current_level > 1000) {
        suspicious++;
        problems.push({
          name,
          matric: s.matric_no,
          issue: 'Suspicious level (showing year?)',
          year_of_study: s.year_of_study,
          current_level: s.current_level
        });
      } else if (s.current_level >= 100 && s.current_level <= 500) {
        correct++;
      } else {
        suspicious++;
        problems.push({
          name,
          matric: s.matric_no,
          issue: 'Invalid level value',
          year_of_study: s.year_of_study,
          current_level: s.current_level
        });
      }
    });
    
    // Summary
    console.log('\n📈 SUMMARY');
    console.log('=' .repeat(80));
    console.log(`✅ Correct levels (100-500):        ${correct}`);
    console.log(`⚠️  Suspicious levels (> 1000):     ${suspicious}`);
    console.log(`❌ No level calculated:            ${noLevel}`);
    console.log('=' .repeat(80));
    
    // Show problems
    if (problems.length > 0) {
      console.log('\n🚨 PROBLEMS FOUND:\n');
      problems.forEach((p, i) => {
        console.log(`${i + 1}. ${p.name} (${p.matric})`);
        console.log(`   Issue: ${p.issue}`);
        console.log(`   year_of_study: ${p.year_of_study}`);
        console.log(`   current_level: ${p.current_level}`);
        console.log('');
      });
    } else {
      console.log('\n✅ No problems found! All levels are displaying correctly.\n');
    }
    
    // Show sample data
    console.log('\n📋 SAMPLE DATA (first 10 students):\n');
    console.log('=' .repeat(80));
    console.log('Name'.padEnd(25), 'Matric'.padEnd(18), 'Year', 'Level', 'Grad?');
    console.log('-'.repeat(80));
    
    students.slice(0, 10).forEach(s => {
      const name = `${s.first_name} ${s.last_name}`.padEnd(25);
      const matric = (s.matric_no || '').padEnd(18);
      const year = String(s.year_of_study || '').padEnd(5);
      const level = String(s.current_level || 'NULL').padEnd(6);
      const grad = s.is_graduated ? '🎓' : '';
      
      console.log(name, matric, year, level, grad);
    });
    
    console.log('=' .repeat(80));
    
    // Recommendations
    if (suspicious > 0 || noLevel > 0) {
      console.log('\n💡 RECOMMENDATIONS:\n');
      console.log('1. Run migration 014 to fix data issues:');
      console.log('   psql -d your_database -f backend/migrations/014_fix_level_display_issue.sql');
      console.log('');
      console.log('2. Verify the students_with_current_level view is working correctly');
      console.log('');
      console.log('3. Check that the backend routes/students.js is querying the view');
      console.log('');
    }
    
  } catch (error) {
    console.error('❌ Diagnostic failed:', error.message);
    console.error(error);
  }
}

diagnoseLevelIssue();
