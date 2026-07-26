// scripts/seed-admin.js
require('dotenv').config();
const { supabase } = require('../config/supabase');
const {
  getAdminEmails,
  getPrimaryAdminEmail,
  DEFAULT_ADMIN_EMAIL
} = require('../utils/helpers');

async function seedAdmin() {
  console.log('🌱 Seeding admin user(s)...');

  const adminEmails = getAdminEmails();
  console.log(`📋 ADMIN_EMAILS allow-list: [${adminEmails.join(', ')}]`);

  try {
    for (let i = 0; i < adminEmails.length; i++) {
      const email = adminEmails[i];
      const role = i === 0 ? 'super_admin' : 'admin';
      const displayName =
        email === DEFAULT_ADMIN_EMAIL ? 'NACOS Admin' : `NACOS ${role} (${email})`;

      console.log(`\n→ Processing ${email} (${role})...`);

      // Skip if admin_users row already present
      const { data: existingAdmin } = await supabase
        .from('admin_users')
        .select('email, role')
        .eq('email', email)
        .maybeSingle();

      if (existingAdmin) {
        console.log(
          `✅ Already exists: ${existingAdmin.email} [${existingAdmin.role}]`
        );
        continue;
      }

      // Create or locate auth user
      const password = process.env.ADMIN_PASSWORD || 'NacosAdmin2024!';
      const { data: authUser, error: authError } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
          data: {
            full_name: displayName,
            role: 'admin'
          }
        }
      });

      let userId = authUser?.user?.id;
      if (authError) {
        // Already registered in auth → fetch user via admin list and attach role
        if (
          authError.message &&
          authError.message.toLowerCase().includes('already registered')
        ) {
          console.log('User already in auth — locating user_id via admin list...');
          const { data: adminAuth } = await supabase.auth.admin.listUsers();
          const user = (adminAuth.users || []).find(
            u => u.email && u.email.toLowerCase() === email.toLowerCase()
          );
          if (!user) {
            console.error(`Could not find existing auth user for ${email}`);
            process.exit(1);
          }
          userId = user.id;
        } else {
          console.error('❌ Admin auth creation failed:', authError);
          process.exit(1);
        }
      }

      if (!userId) {
        console.error(`❌ Failed to create / locate auth user for ${email}`);
        process.exit(1);
      }

      // Create admin_users row
      const { error: adminError } = await supabase
        .from('admin_users')
        .insert([
          {
            user_id: userId,
            email: email,
            name: displayName,
            role: role
          }
        ]);

      if (adminError) {
        console.error('❌ Admin record creation failed:', adminError);
        process.exit(1);
      }

      console.log(`✅ Created ${role}: ${email}`);
    }

    console.log('\n========================================');
    console.log('✅ Admin seeding completed');
    console.log('📧 Primary (super_admin):', getPrimaryAdminEmail());
    if (adminEmails.length > 1) {
      console.log('📧 Additional (admin):       ', adminEmails.slice(1).join(', '));
    }
    console.log(
      '🔑 Password (ADMIN_PASSWORD env):',
      process.env.ADMIN_PASSWORD || 'NacosAdmin2024!'
    );
    console.log('========================================');
  } catch (error) {
    console.error('❌ Seed error:', error);
  }
}

seedAdmin();