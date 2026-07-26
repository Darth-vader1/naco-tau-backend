// assets/js/auth-check.js
import { supabase, checkAuth } from './supabase-config.js';

export async function requireStudentAuth() {
  try {
    const session = await checkAuth();
    
    if (!session) {
      window.location.href = '/student-login.html';
      return false;
    }
    
    const { data: student, error } = await supabase
      .from('students')
      .select('id, status')
      .eq('user_id', session.user.id)
      .single();
    
    if (error || !student || student.status !== 'approved') {
      await supabase.auth.signOut();
      window.location.href = '/student-login.html';
      return false;
    }
    
    return true;
    
  } catch (error) {
    console.error('Auth error:', error);
    window.location.href = '/student-login.html';
    return false;
  }
}