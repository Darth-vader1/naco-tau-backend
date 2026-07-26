// functions/contact.js
// Netlify function for contact form processing

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { name, email, subject, message } = JSON.parse(event.body || '{}');

        if (!name || !email || !subject || !message) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required fields' })
            };
        }

        // Here you would typically send an email using a service like SendGrid, Mailgun, etc.
        // For demonstration, we'll just log and return success.
        console.log('Contact form submission:', { name, email, subject, message });

        // In a real production environment, you'd add your email sending logic here
        
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Message sent successfully' })
        };

    } catch (error) {
        console.error('Contact form error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
