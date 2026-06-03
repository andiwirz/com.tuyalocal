'use strict';

/**
 * Capitalize the first letter of a string and replace underscores with spaces.
 * Used for human-readable display of Tuya enum values (modes, presets, etc.).
 *
 * @param {string} s  — raw enum value, e.g. 'make_hot'
 * @returns {string}  — display label,  e.g. 'Make hot'
 */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

module.exports = { capitalize };
