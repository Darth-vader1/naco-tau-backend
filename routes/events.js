// routes/events.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');

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

    res.json(data || []);
  } catch (error) {
    console.error('Events fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch events'
    });
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

    res.json(data || []);
  } catch (error) {
    console.error('Past events fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch past events'
    });
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
        return res.status(404).json({
          error: 'Event not found'
        });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Event fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch event'
    });
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
      return res.status(400).json({
        error: 'Title and date are required'
      });
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

    res.status(201).json({
      success: true,
      message: 'Event created successfully',
      event: data
    });

  } catch (error) {
    console.error('Event creation error:', error);
    res.status(500).json({
      error: 'Failed to create event'
    });
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
        return res.status(404).json({
          error: 'Event not found'
        });
      }
      throw error;
    }

    res.json({
      success: true,
      message: 'Event updated successfully',
      event: data
    });

  } catch (error) {
    console.error('Event update error:', error);
    res.status(500).json({
      error: 'Failed to update event'
    });
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
      return res.status(404).json({
        error: 'Event not found or inactive'
      });
    }

    // Check if already registered
    const { data: existingRegistration, error: checkError } = await supabase
      .from('event_registrations')
      .select('id')
      .eq('event_id', id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (existingRegistration) {
      return res.status(409).json({
        error: 'You are already registered for this event'
      });
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

    res.json({
      success: true,
      message: 'Successfully registered for event',
      registration: data
    });

  } catch (error) {
    console.error('Event registration error:', error);
    res.status(500).json({
      error: 'Failed to register for event'
    });
  }
});

module.exports = router;