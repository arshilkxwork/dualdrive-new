import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, login, verifyToken } from '../src/auth.js';

addUser('alice', 'correct horse battery staple');

test('a valid login returns a token', () => {
  const token = login('alice', 'correct horse battery staple');
  assert.equal(typeof token, 'string');
});

test('a wrong password returns null', () => {
  assert.equal(login('alice', 'wrong'), null);
});

test('an unknown user returns null', () => {
  assert.equal(login('mallory', 'anything'), null);
});

test('a token round-trips to its username', () => {
  const token = login('alice', 'correct horse battery staple');
  assert.equal(verifyToken(token), 'alice');
});

test('an expired token is rejected', () => {
  const issuedAt = Date.now();
  const token = login('alice', 'correct horse battery staple', issuedAt);
  assert.equal(verifyToken(token, issuedAt + 2 * 60 * 60 * 1000), null);
});

test('a tampered token is rejected', () => {
  const token = login('alice', 'correct horse battery staple');
  const [payload] = token.split('.');
  assert.equal(verifyToken(`${payload}.not-the-signature`), null);
});
