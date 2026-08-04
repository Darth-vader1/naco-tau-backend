// test-email.js - Standalone email test script
// Run with: node test-email.js

require('dotenv').config();
const { sendEmail, sendBulkEmail, getEmailTemplate } = require('./services/email');

const TEST_EMAIL = 'nacos@tau.edu.ng';

async function testSingleEmail() {
    console.log('\n==========================================');
    console.log('TEST 1: Single Email');
    console.log('==========================================\n');
    
    try {
        console.log(`📧 Sending test email to: ${TEST_EMAIL}`);
        
        const result = await sendEmail({
            to: TEST_EMAIL,
            subject: '✅ NACOS Test Email - Single Recipient',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Test Email</title>
                </head>
                <body style="margin: 0; padding: 0; background: #f8fbfc;">
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <div style="background: #1b8c0c; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
                            <h1 style="color: white; margin: 0;">✅ Test Email Successful!</h1>
                        </div>
                        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                            <h2 style="color: #1b8c0c;">Hello from NACOS!</h2>
                            <p>This is a test email from the NACOS TAU Chapter portal.</p>
                            <p><strong>If you're reading this, your email system is working perfectly! 🎉</strong></p>
                            
                            <div style="background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <p style="margin: 0;"><strong>Test Details:</strong></p>
                                <ul style="margin: 10px 0;">
                                    <li>Sent at: ${new Date().toLocaleString()}</li>
                                    <li>To: ${TEST_EMAIL}</li>
                                    <li>From: ${process.env.EMAIL_FROM}</li>
                                    <li>Provider: Resend</li>
                                </ul>
                            </div>
                            
                            <p style="color: #666; font-size: 12px; border-top: 1px solid #eee; padding-top: 15px; margin-top: 20px;">
                                This is an automated test email from NACOS - Thomas Adewumi University Chapter
                            </p>
                        </div>
                    </div>
                </body>
                </html>
            `,
            text: `
NACOS Test Email

Hello from NACOS TAU Chapter!

This is a test email. If you're reading this, your email system is working!

Test Details:
- Sent at: ${new Date().toLocaleString()}
- To: ${TEST_EMAIL}
- From: ${process.env.EMAIL_FROM}
- Provider: Resend

---
NACOS - Thomas Adewumi University Chapter
            `
        });
        
        console.log('✅ SUCCESS! Email sent successfully');
        console.log('📊 Result:', JSON.stringify(result, null, 2));
        console.log(`\n📬 Check inbox at: ${TEST_EMAIL}`);
        console.log('📁 Also check SPAM/JUNK folder if not in inbox\n');
        
        return result;
        
    } catch (error) {
        console.error('❌ FAILED! Error sending email:', error.message);
        console.error('Full error:', error);
        
        if (error.message.includes('not initialized')) {
            console.error('\n⚠️  RESEND_API_KEY not set in .env file');
            console.error('   Add: RESEND_API_KEY=your_key_here');
        }
        
        return null;
    }
}

async function testEventTemplate() {
    console.log('\n==========================================');
    console.log('TEST 2: Event Notification Template');
    console.log('==========================================\n');
    
    try {
        const eventData = {
            title: 'Tech Workshop - AI & Machine Learning',
            date: '2026-08-15',
            time: '2:00 PM',
            location: 'Main Auditorium, TAU Campus',
            description: 'Join us for an exciting workshop on Artificial Intelligence and Machine Learning. Learn from industry experts and get hands-on experience with real-world projects!'
        };
        
        const html = getEmailTemplate('new_event', eventData);
        
        console.log(`📧 Sending event notification to: ${TEST_EMAIL}`);
        
        const result = await sendEmail({
            to: TEST_EMAIL,
            subject: '🎉 New Event: Tech Workshop - AI & ML',
            html,
            text: `New Event: ${eventData.title}\nDate: ${eventData.date}\nTime: ${eventData.time}\nLocation: ${eventData.location}`
        });
        
        console.log('✅ SUCCESS! Event email sent');
        console.log('📊 Result:', JSON.stringify(result, null, 2));
        
        return result;
        
    } catch (error) {
        console.error('❌ FAILED! Error sending event email:', error.message);
        return null;
    }
}

async function testResourceTemplate() {
    console.log('\n==========================================');
    console.log('TEST 3: Resource Notification Template');
    console.log('==========================================\n');
    
    try {
        const resourceData = {
            title: 'Python Programming Tutorial - Complete Guide',
            resource_type: 'Tutorial',
            course: 'CSC 201',
            description: 'Comprehensive Python programming tutorial covering basics to advanced topics including data structures, OOP, and web development.'
        };
        
        const html = getEmailTemplate('new_resource', resourceData);
        
        console.log(`📧 Sending resource notification to: ${TEST_EMAIL}`);
        
        const result = await sendEmail({
            to: TEST_EMAIL,
            subject: '📚 New Resource: Python Programming Tutorial',
            html,
            text: `New Resource: ${resourceData.title}\nType: ${resourceData.resource_type}\nCourse: ${resourceData.course}`
        });
        
        console.log('✅ SUCCESS! Resource email sent');
        console.log('📊 Result:', JSON.stringify(result, null, 2));
        
        return result;
        
    } catch (error) {
        console.error('❌ FAILED! Error sending resource email:', error.message);
        return null;
    }
}

async function runAllTests() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║                                                        ║');
    console.log('║          NACOS EMAIL SYSTEM TEST SUITE                ║');
    console.log('║                                                        ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    
    console.log('\n📋 Configuration:');
    console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ Set' : '❌ Not set'}`);
    console.log(`   EMAIL_FROM: ${process.env.EMAIL_FROM || '❌ Not set'}`);
    console.log(`   TEST_EMAIL: ${TEST_EMAIL}`);
    
    if (!process.env.RESEND_API_KEY) {
        console.error('\n❌ ERROR: RESEND_API_KEY not found in .env file');
        console.error('   Please add RESEND_API_KEY to backend/.env');
        process.exit(1);
    }
    
    const results = {
        singleEmail: false,
        eventEmail: false,
        resourceEmail: false
    };
    
    // Test 1: Single Email
    const test1 = await testSingleEmail();
    results.singleEmail = !!test1;
    
    // Wait 2 seconds between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 2: Event Template
    const test2 = await testEventTemplate();
    results.eventEmail = !!test2;
    
    // Wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 3: Resource Template
    const test3 = await testResourceTemplate();
    results.resourceEmail = !!test3;
    
    // Summary
    console.log('\n\n╔════════════════════════════════════════════════════════╗');
    console.log('║                    TEST SUMMARY                        ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    console.log(`Test 1 - Single Email:        ${results.singleEmail ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Test 2 - Event Template:      ${results.eventEmail ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Test 3 - Resource Template:   ${results.resourceEmail ? '✅ PASSED' : '❌ FAILED'}`);
    
    const passedCount = Object.values(results).filter(Boolean).length;
    const totalCount = Object.keys(results).length;
    
    console.log(`\n📊 Total: ${passedCount}/${totalCount} tests passed`);
    
    if (passedCount === totalCount) {
        console.log('\n🎉 ALL TESTS PASSED! Email system is working perfectly!');
        console.log(`📬 Check your inbox at: ${TEST_EMAIL}`);
        console.log('📁 Remember to check SPAM/JUNK folder if emails not in inbox');
    } else {
        console.log('\n⚠️  Some tests failed. Check the errors above.');
    }
    
    console.log('\n════════════════════════════════════════════════════════\n');
}

// Run tests
if (require.main === module) {
    runAllTests()
        .then(() => {
            console.log('✅ Test suite completed\n');
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Test suite failed:', error);
            process.exit(1);
        });
}

module.exports = { testSingleEmail, testEventTemplate, testResourceTemplate };
