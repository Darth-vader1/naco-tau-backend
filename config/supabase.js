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

// Anon-key client factory.
// SECURITY: user-facing auth calls (signInWithPassword, refreshSession, ...) mutate
// the client's in-memory session, and supabase-js then sends that user's JWT on
// every later request made through the same client. They must therefore NEVER run
// on the shared service_role client above. Create a fresh, throwaway client per call.
const createAuthClient = () => {
    if (!supabaseAnonKey) {
        // Never fall back to the service_role key for end-user auth flows.
        throw new Error('Missing SUPABASE_ANON_KEY (required for user authentication)');
    }
    return createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    });
};

// Shared anon client for stateless public reads only (do not sign users in with it).
const supabasePublic = supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    })
    : null;

console.log('✅ Supabase clients initialized');

module.exports = {
    supabase,
    supabasePublic,
    createAuthClient
};