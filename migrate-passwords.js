'use strict';
/* One-off: hash any legacy plaintext password rows in place (same password, just hashed). */
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'data', 'collins.db'));
const hash = pw => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${16}$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const legacy = db.prepare("SELECT id, username FROM users WHERE password NOT LIKE 'scrypt$%'").all();
for (const u of legacy) {
  const row = db.prepare('SELECT password FROM users WHERE id = ?').get(u.id);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash(row.password), u.id);
  console.log('hashed', u.username);
}
const plain = db.prepare("SELECT COUNT(*) n FROM users WHERE password NOT LIKE 'scrypt$%'").get().n;
console.log(`done: ${legacy.length} upgraded, ${plain} plaintext rows left`);
