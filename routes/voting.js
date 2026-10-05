// backend/routes/voting.js
const express = require('express');
const router = express.Router();

// Health check for voting routes
router.get('/test', (req, res) => {
    res.json({ message: 'Voting routes working' });
});

// Get voting positions
router.get('/positions', (req, res) => {
    res.json({ 
        message: 'Voting positions endpoint',
        positions: []
    });
});

module.exports = router;