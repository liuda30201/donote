'use strict';

// Canonical target shared by email issuance and consumption; never trust client deadlines.
function privateUnlockTarget(body = {}) {
  const { scope, messageId, duration, hours } = body;
  if (!['current', 'all'].includes(scope) || (scope === 'current' && (typeof messageId !== 'string' || !messageId || messageId.length > 128)) || (scope === 'all' && messageId != null)) throw Object.assign(new Error('Invalid private unlock scope'), { status: 400, code: 'INVALID_PRIVATE_UNLOCK' });
  let seconds;
  if (duration === 'permanent') seconds = -1;
  else if (duration === '600' || duration === '1800') seconds = Number(duration);
  else if (duration === 'custom' && typeof hours === 'string' && /^\d{1,3}(?:\.\d)?$/.test(hours) && Number(hours) > 0 && Number(hours) <= 168) seconds = Math.round(Number(hours) * 3600);
  else throw Object.assign(new Error('Invalid private unlock duration'), { status: 400, code: 'INVALID_PRIVATE_UNLOCK' });
  return { action: 'private', scope, messageId: scope === 'current' ? messageId : null, seconds };
}
module.exports = { privateUnlockTarget };
