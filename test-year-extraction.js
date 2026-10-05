/**
 * Test script for year extraction logic
 * Run with: node test-year-extraction.js
 */

const extractYearFromMatric = (matricNo) => {
  if (!matricNo) return null;
  
  // Format: 22/10MSC014 or 23/10MSC014
  const twoDigitMatch = matricNo.match(/^(\d{2})\//);
  if (twoDigitMatch) {
    return 2000 + parseInt(twoDigitMatch[1]);
  }
  
  // Format: TAU/CS/23/014
  const tauTwoDigitMatch = matricNo.match(/TAU\/[A-Z]+\/(\d{2})\//);
  if (tauTwoDigitMatch) {
    return 2000 + parseInt(tauTwoDigitMatch[1]);
  }
  
  // Format: TAU/MSC/2023/0014
  const tauFourDigitMatch = matricNo.match(/TAU\/[A-Z]+\/(\d{4})\//);
  if (tauFourDigitMatch) {
    return parseInt(tauFourDigitMatch[1]);
  }
  
  return null;
};

// Test cases
const testCases = [
  { matric: '22/10MSC014', expected: 2022 },
  { matric: '23/10MSC061', expected: 2023 },
  { matric: '24/10MSC037', expected: 2024 },
  { matric: '24/10MSS048', expected: 2024 },
  { matric: '24/10MSC021', expected: 2024 },
  { matric: '24/10MSC043', expected: 2024 },
  { matric: 'TAU/CS/23/014', expected: 2023 },
  { matric: 'TAU/MSC/2023/0014', expected: 2023 },
  { matric: 'TAU/CS/25/001', expected: 2025 },
  { matric: '26/10MSC999', expected: 2026 },
];

console.log('Testing year extraction from matric numbers:\n');
console.log('=' .repeat(60));

let passed = 0;
let failed = 0;

testCases.forEach(({ matric, expected }) => {
  const result = extractYearFromMatric(matric);
  const status = result === expected ? '✅ PASS' : '❌ FAIL';
  
  if (result === expected) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${status} | ${matric.padEnd(20)} → ${result} (expected: ${expected})`);
});

console.log('=' .repeat(60));
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${testCases.length} tests`);

// Test level calculation
console.log('\n\nTesting level calculation logic:\n');
console.log('=' .repeat(60));

const currentYear = 2026; // As per system context

testCases.forEach(({ matric, expected }) => {
  const yearOfStudy = extractYearFromMatric(matric);
  const programDuration = 4;
  const graduationYear = yearOfStudy ? yearOfStudy + programDuration : null;
  const yearsElapsed = yearOfStudy ? (currentYear - yearOfStudy + 1) : null;
  
  let currentLevel = null;
  let isGraduated = false;
  
  if (yearsElapsed !== null) {
    if (yearsElapsed <= 0) {
      currentLevel = null;
    } else if (yearsElapsed > programDuration) {
      currentLevel = 400;
      isGraduated = true;
    } else {
      currentLevel = yearsElapsed * 100;
    }
  }
  
  console.log(`${matric.padEnd(20)} | Year: ${yearOfStudy} | Level: ${currentLevel || 'NULL'} ${isGraduated ? '🎓' : ''}`);
});

console.log('=' .repeat(60));
