// routes/events.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// GET UPCOMING EVENTS
// ============================================
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('is_active', true)
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(5);

    if (error) throw error;

    return successResponse(res, data || [], 'Upcoming events retrieved successfully');
  } catch (error) {
    console.error('Events fetch error:', error);
    return errorResponse(res, 'Failed to fetch events', 500, error);
  }
});

// ============================================
// GET PAST EVENTS
// ============================================
router.get('/past', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { limit = 10 } = req.query;

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .lt('date', today)
      .order('date', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    return successResponse(res, data || [], 'Past events retrieved successfully');
  } catch (error) {
    console.error('Past events fetch error:', error);
    return errorResponse(res, 'Failed to fetch past events', 500, error);
  }
});

// ============================================
// GET SINGLE EVENT
// ============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Event not found', 404);
      }
      throw error;
    }

    return successResponse(res, data, 'Event retrieved successfully');
  } catch (error) {
    console.error('Event fetch error:', error);
    return errorResponse(res, 'Failed to fetch event', 500, error);
  }
});

// ============================================
// CREATE EVENT (Admin only)
// ============================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      time,
      location,
      image_url,
      event_type,
      requires_payment,
      payment_amount,
      max_attendees
    } = req.body;

    if (!title || !date) {
      return errorResponse(res, 'Title and date are required', 400);
    }

    const { data, error } = await supabase
      .from('events')
      .insert([{
        title,
        description,
        date,
        time,
        location,
        image_url,
        event_type,
        requires_payment: requires_payment || false,
        payment_amount: payment_amount || 0,
        max_attendees: max_attendees || null,
        is_active: true,
        created_by: req.userId,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    return successResponse(res, { event: data }, 'Event created successfully', 201);

  } catch (error) {
    console.error('Event creation error:', error);
    return errorResponse(res, 'Failed to create event', 500, error);
  }
});

// ============================================
// UPDATE EVENT (Admin only)
// ============================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('events')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Event not found', 404);
      }
      throw error;
    }

    return successResponse(res, { event: data }, 'Event updated successfully');

  } catch (error) {
    console.error('Event update error:', error);
    return errorResponse(res, 'Failed to update event', 500, error);
  }
});

// ============================================
// REGISTER FOR EVENT
// ============================================
router.post('/:id/register', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if event exists and is active
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (eventError || !event) {
      return errorResponse(res, 'Event not found or inactive', 404);
    }

    // Check if already registered
    const { data: existingRegistration, error: checkError } = await supabase
      .from('event_registrations')
      .select('id')
      .eq('event_id', id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (existingRegistration) {
      return errorResponse(res, 'You are already registered for this event', 409);
    }

    // Register user
    const { data, error } = await supabase
      .from('event_registrations')
      .insert([{
        event_id: id,
        user_id: req.userId,
        registration_date: new Date().toISOString(),
        status: 'registered'
      }])
      .select()
      .single();

    if (error) throw error;

    return successResponse(res, { registration: data }, 'Successfully registered for event');

  } catch (error) {
    console.error('Event registration error:', error);
    return errorResponse(res, 'Failed to register for event', 500, error);
  }
});

module.exports = router;
