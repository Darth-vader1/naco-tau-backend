const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role key to bypass RLS for signup if needed, but here we want to ensure profile creation

const supabase = createClient(supabaseUrl, supabaseServiceKey);

exports.handler = async function (event, context) {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { email, password, first_name, last_name, matric_number, department } = JSON.parse(event.body || '{}');

        if (!email || !password || !first_name || !last_name || !matric_number || !department) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required fields' })
            };
        }

        // 1. Sign up user in Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
        });

        if (authError) throw authError;

        const user = authData.user;
        if (!user) {
             return {
                statusCode: 400,
                body: JSON.stringify({ error: 'User already exists or signup failed' })
            };
        }

        // 2. Create student profile
        const { error: profileError } = await supabase
            .from('students')
            .insert({
                user_id: user.id,
                email: email,
                first_name,
                last_name,
                matric_number,
                department,
                status: 'pending'
            });

        if (profileError) {
            // If profile creation fails, we might want to delete the auth user? 
            // For now, just return error
            console.error('Profile creation error:', profileError);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to create student profile: ' + profileError.message })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Signup successful, pending approval' })
        };

    } catch (error) {
        console.error('Signup error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || 'Internal server error' })
        };
    }
};
