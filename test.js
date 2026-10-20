const assert = require('assert');
process.env.DB_FILE = require('os').tmpdir() + '/angodate-test-' + Date.now() + '.json';
const server = require('./server');
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port + '/api/';
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  try {
    const a = (await call('POST', 'register', { email: 'a@x.com', password: 'secret1', name: 'John', age: 30, country: 'USA' })).j;
    const b = (await call('POST', 'register', { email: 'b@x.com', password: 'secret1', name: 'Maria', age: 25, country: 'Angola' })).j;
    assert.equal((await call('POST', 'register', { email: 'c@x.com', password: 'secret1', name: 'K', age: 17 })).s, 400);
    assert.equal((await call('POST', 'messages/' + b.user.id, { text: 'oi' }, a.token)).s, 402);
    assert.equal((await call('GET', 'likes-received', null, b.token)).j.locked, true);
    assert.equal((await call('POST', 'like/' + b.user.id, {}, a.token)).j.match, false);
    assert.equal((await call('GET', 'likes-received', null, b.token)).j.count, 1);
    assert.equal((await call('POST', 'pay', { item: 'vip', method: 'multicaixa_express' }, b.token)).j.user.plan, 'vip');
    const lr = (await call('GET', 'likes-received', null, b.token)).j; assert.equal(lr.locked, false);
    assert.equal((await call('POST', 'like/' + a.user.id, {}, b.token)).j.match, true);
    assert.equal((await call('POST', 'messages/' + b.user.id, { text: 'oi' }, a.token)).s, 200);
    const me = (await call('GET', 'me', null, b.token)).j; assert.ok(me.verified && me.boostsLeft === 5);
    assert.equal((await call('POST', 'boost', {}, b.token)).j.boosted, true);
    console.log('OK: todos os testes passaram');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close(); require('fs').unlinkSync(process.env.DB_FILE);
});
