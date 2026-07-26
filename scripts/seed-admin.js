// scripts/seed-admin.js
require('dotenv').config();
const { supabase } = require('../config/supabase');

async function seedAdmin() {
  console.log('🌱 Seeding admin user...');

  try {
    // Check if admin already exists
    const { data: existingAdmin } = await supabase
      .from('admin_users')
      .select('email')
      .eq('email', 'nacos@tau.edu.ng')
      .maybeSingle();

    if (existingAdmin) {
      console.log('✅ Admin already exists');
      return;
    }

    // Create admin auth user if not exists
    const { data: authUser, error: authError } = await supabase.auth.signUp({
      email: 'nacos@tau.edu.ng',
      password: process.env.ADMIN_PASSWORD || 'NacosAdmin2024!',
      options: {
        data: {
          full_name: 'NACOS Admin',
          role: 'admin'
        }
      }
    });

    if (authError) {
      console.error('❌ Admin auth creation failed:', authError);
      return;
    }

    // Create admin record
    const { error: adminError } = await supabase
      .from('admin_users')
      .insert([{
        user_id: authUser.user.id,
        email: 'nacos@tau.edu.ng',
        name: 'NACOS Admin',
        role: 'super_admin'
      }]);

    if (adminError) {
      console.error('❌ Admin record creation failed:', adminError);
      return;
    }

    console.log('✅ Admin user created successfully');
    console.log('📧 Email: nacos@tau.edu.ng');
    console.log('🔑 Password:', process.env.ADMIN_PASSWORD || 'NacosAdmin2024!');

  } catch (error) {
    console.error('❌ Seed error:', error);
  }
}

seedAdmin();