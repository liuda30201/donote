const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getUserState, commitUserMutation } = require('../storage');
const { toPublicMessage } = require('../message');
const { trackRouter } = require('../lifecycle');
const router = trackRouter(express.Router());
router.get('/', requireAuth, (req, res) => {
  const favorites = getUserState(req.userId).messages.filter(message => message.favorite);
  res.json({ messages: favorites.map(message => toPublicMessage(message, req.userId)), total: favorites.length });
});
function updateFavorite(favorite) {
  return async (req, res) => {
    let message;
    await commitUserMutation(req.userId, candidate => {
      message = candidate.messages.find(item => item.id === req.params.id);
      if (!message) throw Object.assign(new Error('Message not found'), { status: 404 });
      message.favorite = favorite;
    });
    const publicMessage = toPublicMessage(message, req.userId);
    req.app.get('io')?.broadcastFavorite(req.userId, { id: message.id, favorite, message: publicMessage });
    res.json({ success: true, message: publicMessage });
  };
}
router.post('/:id/favorite', requireAuth, updateFavorite(true));
router.delete('/:id/favorite', requireAuth, updateFavorite(false));
module.exports = router;
