// backend/config/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
    console.error('❌ SUPABASE_URL is missing in .env file');
    console.error('Please add: SUPABASE_URL=https://your-project.supabase.co');
    throw new Error('Missing SUPABASE_URL');
}

if (!supabaseServiceKey) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY is missing in .env file');
    console.error('Please add your service role key from Supabase dashboard');
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
}

console.log('📡 Connecting to Supabase:', supabaseUrl);

// Server-side client (uses service role key - NEVER expose to frontend)
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    }
});

// Public client (uses anon key for public operations)
const supabasePublic = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
    }
});

console.log('✅ Supabase clients initialized');

module.exports = {
    supabase,
    supabasePublic
};