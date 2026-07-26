// functions/newsletter.js
// Netlify function for newsletter subscription

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { email } = JSON.parse(event.body || '{}');

        if (!email) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Email is required' })
            };
        }

        // Here you would typically add the email to your mailing list (e.g., Mailchimp, ConvertKit)
        console.log('Newsletter subscription:', { email });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Subscribed successfully' })
        };

    } catch (error) {
        console.error('Newsletter error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
