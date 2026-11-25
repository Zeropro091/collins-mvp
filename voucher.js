#!/usr/bin/env node
'use strict';
/* Voucher admin CLI: create / list / reset vouchers. No server needed. */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'data', 'collins.db'));
const [cmd, a, b] = process.argv.slice(2);
const show = rows => rows.forEach(r => console.log(`${r.code}  ${r.tokens} tok  ${r.uses}/${r.max_uses} pakai`));

if (cmd === 'create') {
  if (!a || !b) { console.log('usage: node voucher.js create <CODE> <TOKENS> [MAX_USES]'); process.exit(1); }
  const maxUses = Number(process.argv[5] || 1);
  db.prepare('INSERT OR REPLACE INTO vouchers(code,tokens,max_uses,uses,created) VALUES(?,?,?,0,?)').run(a, Number(b), maxUses, Date.now());
  console.log(`voucher ${a} = ${b} tok, ${maxUses}x pakai`);
} else if (cmd === 'list') {
  show(db.prepare('SELECT * FROM vouchers ORDER BY created DESC').all());
} else if (cmd === 'reset') {
  if (!a) { console.log('usage: node voucher.js reset <CODE>   # hapus semua pemakaian'); process.exit(1); }
  db.prepare('DELETE FROM voucher_redemptions WHERE code = ?').run(a);
  db.prepare('UPDATE vouchers SET uses = 0 WHERE code = ?').run(a);
  console.log(`voucher ${a} direset`);
} else {
  console.log('usage: node voucher.js create <CODE> <TOKENS> [MAX_USES] | list | reset <CODE>');
}
